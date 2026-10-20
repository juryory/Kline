import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../server/db.js';
import { initIfind } from '../server/ifind-store.js';
import { runBackfill, backfillStatus, checkMinuteDay, inBackfillWindow } from '../server/ifind-backfill.js';
import { syncIfind, remoteSymbol } from '../server/ifind-sync.js';
import { quotaStatus } from '../server/ifind-budget.js';

const now = Date.parse('2026-10-21T22:00:00+08:00');
const DAYS = ['2026-10-16', '2026-10-19', '2026-10-20'];
const env = { IFIND_BACKFILL_MONTHS: '1', IFIND_BACKFILL_ETF_TOP: '1' };
const SYMBOLS = [
  ['000001.SH', '上证指数', 'index', null], ['399001.SZ', '深证成指', 'index', null],
  ['885001.TI', '概念', 'index', 'THN'], ['700001.TI', '行业无分钟', 'index', 'THI'], ['801010.SI', '农林牧渔', 'index', 'SW1'],
  ['510300.SH', '沪深300ETF', 'etf', 'ETF'], ['159915.SZ', '创业板ETF', 'etf', 'ETF'],
];
const ymd = (d) => Number(d.replaceAll('-', ''));
function database(t) {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA); initIfind(db);
  const put = db.prepare('INSERT INTO symbols VALUES (?,?,?,?)');
  for (const s of SYMBOLS) put.run(...s);
  // 前 20 个交易日的旧库日线：活跃 ETF 按平均成交额选（510300 成交额大）
  for (let i = 1; i <= 20; i++) {
    const date = 20260900 + i;
    db.prepare('INSERT INTO daily VALUES (?,?,10,10,10,10,100,?)').run('000001.SH', date, 241);
    db.prepare('INSERT INTO daily VALUES (?,?,10,10,10,10,100,?)').run('510300.SH', date, 500);
    db.prepare('INSERT INTO daily VALUES (?,?,10,10,10,10,100,?)').run('159915.SZ', date, 100);
  }
  t.after(() => db.close()); return db;
}
/** 一天 241 根分钟：每根收盘 close、成交额 1000 元 */
function minuteRows(code, day, close = 10) {
  const times = ['09:30'];
  for (const start of ['09:31', '13:01']) for (let i = 0; i < 120; i++) {
    const ts = Date.parse(`${day}T${start}:00Z`) + i * 60_000;
    times.push(new Date(ts).toISOString().slice(11, 16));
  }
  return times.map((hm) => ({ code, time: `${day} ${hm}`, open: close, high: close, low: close, close, volume: 100, amount: 1000 }));
}
function fakeClient({ usage = 0, close = 10 } = {}) {
  const calls = [], dailyCalls = [];
  return { calls, dailyCalls,
    dailyRange: async (codes, from, to) => {
      dailyCalls.push([codes.join(','), from, to]);
      const rows = codes.flatMap((code) => ['2026-10-14', '2026-10-15', ...DAYS].filter((d) => d >= from && d <= to).map((time) =>
        ({ code, time, open: 10, high: 10, low: 10, close: 10, volume: 241, amount: 241000 })));
      return { rows, cells: rows.length * 6 };
    },
    tradeDates: async () => DAYS,
    dataVolume: async () => ({ usage, limit: 150_000_000 }),
    query: async (kind, codes, day) => ({ cells: codes.length * 7,
      // 指数日线成交量单位是手、ETF 是股：都等于 241 根 × 100 股
      rows: codes.map((code) => ({ code, time: day, open: 10, high: 10, low: 10, close: 10,
        volume: /^(51|15)/.test(code) ? 24100 : 241, amount: 241000 })) }),
    minuteRange: async (codes, from, to) => {
      calls.push([codes.join(','), from, to]);
      const rows = codes.filter((c) => c !== '700001.TI').flatMap((c) => DAYS.filter((d) => d >= from && d <= to).flatMap((d) => minuteRows(c, d, close)));
      return { rows, cells: rows.length * 6 };
    },
  };
}

test('分钟补历史：按批次推进，无分钟数据的指数记下跳过，活跃 ETF 选定后固定，补完不再请求', async (t) => {
  const db = database(t), client = fakeClient();
  const result = await runBackfill({ db, client, now, env, log: () => {}, mappings: {} });
  assert.equal(result.stop, 'done');
  assert.deepEqual(client.calls, [
    ['000001.SH,399001.SZ', '2026-10-16', '2026-10-20'],
    ['885001.TI', '2026-10-16', '2026-10-20'],
    ['801010.SL,700001.TI', '2026-10-16', '2026-10-20'],
    ['510300.SH', '2026-10-16', '2026-10-20'],
  ]);
  assert.equal(result.checked, 15); assert.equal(result.issues, 0);
  assert.ok(db.prepare("SELECT 1 FROM ifind_no_minute WHERE code='700001.TI'").get());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ifind_progress WHERE kind='minute' AND complete=1").get().n, 15);
  assert.ok(quotaStatus(db, now).historyUsed > 0);
  const status = backfillStatus(db, { now, env });
  assert.deepEqual(status.batches.map((b) => [b.key, b.codes, b.done, b.total]),
    [['core', 2, 6, 6], ['concept', 1, 3, 3], ['industry', 1, 3, 3], ['etf', 1, 3, 3]]);
  assert.equal(status.remainingCells, 0); assert.equal(status.noMinute, 1);
  client.calls.length = 0; client.dailyCalls.length = 0;
  assert.equal((await runBackfill({ db, client, now: now + 3600_000, env, log: () => {}, mappings: {} })).stop, 'done');
  assert.equal(client.calls.length, 0); assert.equal(client.dailyCalls.length, 0);
});

test('核心指数 5 年 iFinD 日线、深证成指全历史：一次请求多天，收盘和 Tushare 核对，补完不再请求；大量不一致时不写入、暂停', async (t) => {
  const db = database(t), client = fakeClient();
  // 深证成指全历史：5 年以前（这里是 10-16 以前）旧库有的日期也换成 iFinD
  for (const d of [20261014, 20261015, 20261016]) db.prepare('INSERT INTO daily VALUES (?,?,10,10,10,10,100,?)').run('399001.SZ', d, 100);
  const result = await runBackfill({ db, client, now, env, log: () => {}, mappings: {} });
  assert.equal(result.stop, 'done'); assert.equal(result.dailyRows, 8);
  // 只有核心指数走多天日线；Tushare 已有的那天也换成 iFinD（成交额口径）
  assert.deepEqual(client.dailyCalls, [['000001.SH', '2026-10-16', '2026-10-20'], ['399001.SZ', '2026-10-14', '2026-10-20']]);
  assert.equal(db.prepare("SELECT amount FROM ifind_daily WHERE code='399001.SZ' AND date=20261016").get().amount, 241);
  const status = backfillStatus(db, { now, env });
  assert.deepEqual([status.coreDaily.codes, status.coreDaily.done, status.coreDaily.total], [2, 8, 8]);

  const db2 = database(t), bad = fakeClient();
  for (const code of ['000001.SH', '399001.SZ']) for (const d of [20261016, 20261019, 20261020]) {
    db2.prepare('INSERT INTO daily VALUES (?,?,9,9,9,9,100,100)').run(code, d);
  }
  const paused = await runBackfill({ db: db2, client: bad, now, env, log: () => {}, mappings: {} });
  assert.equal(paused.stop, 'paused'); assert.match(paused.errors[0], /核心指数日线.*6 \/ 6/);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM ifind_daily').get().n, 0);
  assert.equal(bad.calls.length, 0);
});

test('官方用量到停止线、本机周上限到了都不再请求，保留进度下次继续', async (t) => {
  const db = database(t);
  const official = fakeClient({ usage: 99_999_000 });
  assert.equal((await runBackfill({ db, client: official, now, env, log: () => {}, mappings: {} })).stop, 'official');
  assert.equal(official.calls.length, 0);
  const drain = await runBackfill({ db, client: official, now, env, drain: true, maxSeconds: Infinity, log: () => {}, mappings: {} });
  assert.equal(drain.stop, 'done');
  const db2 = database(t), small = fakeClient();
  // 盘后同步试过 3 天都没有分钟的指数，补历史开始时直接记为无分钟数据
  for (const d of [20261016, 20261019, 20261020]) db2.prepare("INSERT INTO ifind_progress VALUES ('minute','700001.TI',?,0,0)").run(d);
  const budget = await runBackfill({ db: db2, client: small, now, env: { ...env, IFIND_BACKFILL_WEEKLY: '5000' }, log: () => {}, mappings: {} });
  assert.equal(budget.stop, 'budget'); assert.equal(small.calls.length, 0);
  assert.ok(db2.prepare("SELECT 1 FROM ifind_no_minute WHERE code='700001.TI'").get());
});

test('分钟和日线对不上时记录并暂停，--resume 后继续', async (t) => {
  const db = database(t), bad = fakeClient({ close: 11 });
  const first = await runBackfill({ db, client: bad, now, env, log: () => {}, mappings: {} });
  assert.equal(first.stop, 'paused'); assert.equal(first.issues, 6);
  assert.match(db.prepare("SELECT detail FROM ifind_backfill_issues WHERE code='000001.SH'").get().detail, /收盘/);
  const again = fakeClient();
  assert.equal((await runBackfill({ db, client: again, now, env, log: () => {}, mappings: {} })).stop, 'paused');
  assert.equal(again.calls.length, 0);
  // 第一轮已写入的天算已尝试；--resume 清掉暂停，接着补后面的批次
  const resumed = await runBackfill({ db, client: again, now, env, resume: true, log: () => {}, mappings: {} });
  assert.equal(resumed.stop, 'done'); assert.equal(again.calls[0][0], '885001.TI');
});

test('核对规则、补历史时段、申万一级代码映射', () => {
  const rows = minuteRows('x', '2026-10-20').map((r) => ({ close: r.close, amount: r.amount, vol: 100 }));
  assert.equal(checkMinuteDay(rows, { close: 10, amount: 241, vol: 0 }), null);
  assert.match(checkMinuteDay(rows, { close: 10, amount: 300, vol: 0 }), /成交额/);
  assert.match(checkMinuteDay(rows, { close: 10, amount: null, vol: 100 }), /成交量/);
  assert.equal(checkMinuteDay(rows, { close: 10.004, amount: 241 }), null);
  assert.equal(checkMinuteDay(rows, null), null);
  const at = (s) => new Date(s);
  assert.equal(inBackfillWindow(at('2026-10-21T22:00:00'), '21:30-08:30'), true);
  assert.equal(inBackfillWindow(at('2026-10-22T08:00:00'), '21:30-08:30'), true);
  assert.equal(inBackfillWindow(at('2026-10-22T10:00:00'), '21:30-08:30'), false);
  assert.equal(inBackfillWindow(at('2026-10-24T14:00:00'), '21:30-08:30'), true);
  assert.equal(remoteSymbol({ code: '801010.SI' }, {}).code, '801010.SL');
  assert.equal(remoteSymbol({ code: '850111.SI' }, {}).code, '850111.SI');
});

test('盘后同步：整天为空且从没有分钟的指数记为无分钟数据，之后不再请求', async (t) => {
  const db = database(t), calls = [];
  const options = { db, now, mode: 'daily', kinds: ['minute'], startDate: '2026-10-20', endDate: '2026-10-20', log: () => {},
    symbols: SYMBOLS.slice(2, 4).map(([code, name, type, category]) => ({ code, name, type, category })),
    client: { query: async (kind, codes, day) => { calls.push(codes.join(',')); return { cells: 0, rows: minuteRows('885001.TI', day) }; } } };
  await syncIfind(options);
  assert.ok(db.prepare("SELECT 1 FROM ifind_no_minute WHERE code='700001.TI'").get());
  db.prepare('DELETE FROM ifind_progress').run();
  await syncIfind({ ...options, now: now + 3600_000 });
  // 885001 已有完整分钟直接标完成；700001 被跳过，第二轮不请求
  assert.deepEqual(calls, ['885001.TI,700001.TI']);
});
