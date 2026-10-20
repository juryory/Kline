import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../server/db.js';
import { initIfind } from '../server/ifind-store.js';
import { syncFutures, futuresList, futuresEnd } from '../server/ifind-futures.js';
import { periodsFor } from '../shared/periods.js';
import { loadUniverse, search } from '../server/symbols.js';

const at = (s) => Date.parse(`${s}+08:00`);
const env = { IFIND_FUTURES_YEARS: '1', IFIND_CLOSE_CUTOFF: '15:30' };
function database(t) {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA); initIfind(db);
  t.after(() => db.close()); return db;
}
/** 每个工作日一根；published = 接口已发布到哪天（还在交易的不返回） */
function fakeClient(published) {
  const calls = [];
  return { calls,
    dailyRange: async ([code], from, to) => {
      calls.push([code, from, to]);
      const rows = [];
      for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400_000) {
        const day = new Date(t).toISOString().slice(0, 10), w = new Date(t).getUTCDay();
        if (w === 0 || w === 6 || day > published) continue;
        const fx = code.endsWith('.FX');
        rows.push({ code, time: day, open: 10, high: 11, low: 9, close: 10.5,
          volume: fx ? null : 1000, amount: code.endsWith('.SHF') || code.endsWith('.INE') ? 2000 : null });
      }
      return { rows, cells: rows.length * 6 };
    } };
}

test('期货 / 外汇品种：类型和分类，追加品种，只有日 K 没有分时', () => {
  const list = futuresList({ IFIND_FUTURES_EXTRA: 'CL0Y.NYM:WTI原油' });
  const by = Object.fromEntries(list.map((s) => [s.code, s]));
  assert.deepEqual([by['AUZL.SHF'].type, by['AUZL.SHF'].category], ['future', 'FUT_CN']);
  assert.deepEqual([by['BRN0Y.ICE'].type, by['BRN0Y.ICE'].category], ['future', 'FUT_GL']);
  assert.deepEqual([by['DINI.FX'].type, by['DINI.FX'].category], ['fx', 'FX']);
  assert.equal(by['CL0Y.NYM'].name, 'WTI原油');
  assert.deepEqual(futuresList({ IFIND_FUTURES: '0' }), []);
  assert.throws(() => futuresList({ IFIND_FUTURES_EXTRA: 'CL0Y' }), /格式错误/);
  const keys = periodsFor({ indexOnly: true, intraday: true, minutes: true }, by['AUZL.SHF']).map((p) => p.key);
  assert.ok(keys.includes('D') && !keys.includes('T') && !keys.some((k) => k.startsWith('m')));
});

test('检索：按带字母的代码（AUZL、dini）也能找到', async () => {
  await loadUniverse({ listSymbols: async () => futuresList({}) });
  assert.equal(search('auzl')[0].code, 'AUZL.SHF');
  assert.equal(search('DINI')[0].code, 'DINI.FX');
  assert.equal(search('hjzl').some((s) => s.code === 'AUZL.SHF'), true);
});

test('只同步已收盘的日期：国内期货 15:30 以后到当天，海外 / 外汇到前一天', () => {
  const [cn, gl] = futuresList({}).filter((s) => ['AUZL.SHF', 'BRN0Y.ICE'].includes(s.code));
  assert.equal(futuresEnd(cn, at('2026-10-21T15:00:00')), '2026-10-20');
  assert.equal(futuresEnd(cn, at('2026-10-21T15:40:00')), '2026-10-21');
  assert.equal(futuresEnd(gl, at('2026-10-21T15:40:00')), '2026-10-20');
  assert.equal(futuresEnd(gl, at('2026-10-21T05:00:00')), '2026-10-20');
});

test('首次补历史、单位换算、增量只重取最近几天，已到截止日不再请求，没发布的 2 小时后再查', async (t) => {
  const db = database(t), now = at('2026-10-21T16:00:00');
  const client = fakeClient('2026-10-21');
  const one = { ...env, IFIND_FUTURES: '1' };
  const first = await syncFutures({ db, client, now, env: one, log: () => {} });
  assert.equal(first.failed, false);
  // 1 年历史，每个品种一次请求（366 天一段，最后一段到截止日）
  const au = client.calls.filter(([c]) => c === 'AUZL.SHF');
  assert.deepEqual(au.map(([, f, to]) => [f, to]), [['2025-10-21', '2026-10-21']]);
  assert.deepEqual(client.calls.find(([c]) => c === 'BRN0Y.ICE').slice(1), ['2025-10-21', '2026-10-20']);
  // 国内期货成交额万元 → 库里千元；外汇没有成交量记 0、没有成交额
  const bar = db.prepare("SELECT vol, amount FROM ifind_daily WHERE code='AUZL.SHF' AND date=20261021").get();
  assert.deepEqual({ ...bar }, { vol: 1000, amount: 20000 });
  const fx = db.prepare("SELECT vol, amount FROM ifind_daily WHERE code='DINI.FX' AND date=20261020").get();
  assert.deepEqual({ ...fx }, { vol: 0, amount: null });
  assert.equal(db.prepare("SELECT MAX(date) AS d FROM ifind_daily WHERE code='BRN0Y.ICE'").get().d, 20261020);
  assert.equal(db.prepare("SELECT type FROM ifind_symbols WHERE code='USDCNH.FX'").get().type, 'fx');

  // 同一天再跑：都已到截止日，不请求
  client.calls.length = 0;
  await syncFutures({ db, client, now: now + 600_000, env: one, log: () => {} });
  assert.equal(client.calls.length, 0);

  // 第二天：从最新日期往前 7 天重取；国内期货当天还没发布 → 2 小时内不重复请求
  const late = fakeClient('2026-10-21');
  const next = at('2026-10-22T15:40:00');
  await syncFutures({ db, client: late, now: next, env: one, log: () => {} });
  assert.deepEqual(late.calls.find(([c]) => c === 'AUZL.SHF').slice(1), ['2026-10-14', '2026-10-22']);
  assert.deepEqual(late.calls.find(([c]) => c === 'BRN0Y.ICE').slice(1), ['2026-10-13', '2026-10-21']);
  late.calls.length = 0;
  await syncFutures({ db, client: late, now: next + 3600_000, env: one, log: () => {} });
  assert.equal(late.calls.length, 0);
  await syncFutures({ db, client: fakeClient('2026-10-22'), now: next + 3 * 3600_000, env: one, log: () => {} });
  assert.equal(db.prepare("SELECT MAX(date) AS d FROM ifind_daily WHERE code='AUZL.SHF'").get().d, 20261022);
});

test('接口失败：保留断点，下次重新补历史', async (t) => {
  const db = database(t);
  const broken = { dailyRange: async () => { throw new Error('网络失败'); } };
  const r = await syncFutures({ db, client: broken, now: at('2026-10-21T16:00:00'), env, log: () => {} });
  assert.equal(r.failed, true); assert.match(r.errors[0], /网络失败/);
  const ok = fakeClient('2026-10-21');
  await syncFutures({ db, client: ok, now: at('2026-10-21T16:10:00'), env, log: () => {} });
  assert.equal(ok.calls.filter(([c]) => c === 'AUZL.SHF')[0][1], '2025-10-21');
});
