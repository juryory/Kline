/**
 * 期货 / 外汇日线（iFinD）：只有日 K、周 K、月 K，没有分时和分钟 K（交易时段和 A 股不同，暂不做）。
 * 首次补 IFIND_FUTURES_YEARS（默认 10）年历史，每个品种每年一次请求；之后每轮盘后同步从库里最新日期往前 7 天重取一次。
 * 只同步已收盘的日期：国内期货 IFIND_CLOSE_CUTOFF（15:30）以后到当天，海外期货、外汇按交易所日期，北京时间白天还在交易，只到前一天。
 * 国内期货用主力连续合约（换月时价格可能跳空），成交额单位万元；海外期货没有成交额，外汇没有成交量（记 0）。
 * IFIND_FUTURES_EXTRA="代码:名称,…" 追加品种；IFIND_FUTURES=0 关闭。
 */
import { chinaDate, dateNumber, normalizeIfind } from './ifind-client.js';
import { initIfind, writeIfind } from './ifind-store.js';
import { quotaConfig, reserveWeekly, reconcileWeekly } from './ifind-budget.js';
import { reserveBudget } from './ifind-sync.js';
import { tx } from './db.js';

// category：FUT_CN 国内期货 / FUT_GL 海外期货 / FX 外汇（含伦敦金）
export const IFIND_FUTURES = [
  { code: 'AUZL.SHF', name: '沪金主力' },
  { code: 'AGZL.SHF', name: '沪银主力' },
  { code: 'SCZL.INE', name: '原油主力' },
  { code: 'CUZL.SHF', name: '沪铜主力' },
  { code: 'BRN0Y.ICE', name: '布伦特原油' },
  { code: 'XAUUSD.FX', name: '伦敦金现货' },
  { code: 'DINI.FX', name: '美元指数' },
  { code: 'USDCNH.FX', name: '美元兑离岸人民币' },
];
const DOMESTIC = /\.(SHF|INE|DCE|CZC|GFE)$/;
const CELLS = 6;
const OVERLAP_DAYS = 7;
const RECHECK_MS = 2 * 3600_000;

export function futureSymbol({ code, name }) {
  const fx = code.endsWith('.FX');
  return { code, name, type: fx ? 'fx' : 'future', category: fx ? 'FX' : DOMESTIC.test(code) ? 'FUT_CN' : 'FUT_GL' };
}

export function futuresList(env = process.env) {
  if (env.IFIND_FUTURES === '0') return [];
  const extra = (env.IFIND_FUTURES_EXTRA ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const [code, name] = item.split(':').map((s) => s?.trim());
    if (!/^[A-Za-z0-9]+\.[A-Za-z]+$/.test(code ?? '') || !name) throw new Error(`IFIND_FUTURES_EXTRA 格式错误：${item}（应为 代码:名称）`);
    return { code, name };
  });
  const seen = new Set();
  return [...IFIND_FUTURES, ...extra].filter((s) => !seen.has(s.code) && seen.add(s.code)).map(futureSymbol);
}

const shift = (day, days) => chinaDate(Date.parse(`${day}T00:00:00+08:00`) + days * 86400_000);
const iso = (n) => String(n).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
const weekdays = (from, to) => {
  let n = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400_000) {
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
};

/** 这个品种可以同步到哪天（含）：国内期货收盘截止时间以后是当天，否则前一天；海外 / 外汇总是前一天 */
export function futuresEnd(symbol, now = Date.now(), cutoff = process.env.IFIND_CLOSE_CUTOFF || '15:30') {
  const [h, m] = cutoff.split(':').map(Number);
  const clock = new Date(now + 8 * 3600_000);
  const afterClose = clock.getUTCHours() * 60 + clock.getUTCMinutes() >= h * 60 + m;
  return chinaDate(now - (symbol.category === 'FUT_CN' && afterClose ? 0 : 86400_000));
}

const meta = (db, key) => { const v = db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; return v ? JSON.parse(v) : {}; };
const setMeta = (db, key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value));

/** 盘后同步调用：登记品种（进检索），补历史 / 增量日线。返回 { requests, rows, cells, failed, errors } */
export async function syncFutures({ db, client, now = Date.now(), log = console.log, env = process.env, quota = quotaConfig() } = {}) {
  initIfind(db);
  const list = futuresList(env);
  const result = { requests: 0, rows: 0, cells: 0, failed: false, errors: [] };
  if (!list.length) return result;
  const put = db.prepare('INSERT OR REPLACE INTO ifind_symbols VALUES (?,?,?,?)');
  for (const s of list) put.run(s.code, s.name, s.type, s.category);

  const years = Number(env.IFIND_FUTURES_YEARS || 10);
  if (!Number.isInteger(years) || years < 1 || years > 30) throw new Error('IFIND_FUTURES_YEARS 必须为 1—30 年');
  const d = new Date(now + 8 * 3600_000); d.setUTCFullYear(d.getUTCFullYear() - years);
  const historyFrom = d.toISOString().slice(0, 10);
  const filled = meta(db, 'ifind_futures_history'), checked = meta(db, 'ifind_futures_checked');
  const latestOf = db.prepare('SELECT MAX(date) AS d FROM ifind_daily WHERE code=?');

  for (const s of list) {
    const end = futuresEnd(s, now, env.IFIND_CLOSE_CUTOFF || '15:30');
    const latest = latestOf.get(s.code)?.d;
    const history = !(filled[s.code] <= historyFrom);
    if (!history && latest >= dateNumber(end)) continue;
    // 当天的日线可能还没发布：2 小时内查过同一个截止日就不再查（节假日也不会每轮都请求）
    if (!history && checked[s.code]?.end === end && now - checked[s.code].at < RECHECK_MS) continue;
    const start = history ? historyFrom : latest ? shift(iso(latest), -OVERLAP_DAYS) : historyFrom;
    const lane = history ? 'history' : 'fresh';
    const bars = [];
    for (let from = start; from <= end; from = shift(from, 366)) {
      const to = [shift(from, 365), end].sort()[0];
      const estimate = Math.max(1, weekdays(from, to)) * CELLS;
      let week;
      try {
        if (quota.profile === 'trial') week = reserveWeekly(db, now, lane, 'daily', estimate, quota);
        else reserveBudget(db, chinaDate(now).slice(0, 7), 'daily', estimate, Number(env.IFIND_DAILY_BUDGET || 900000));
        result.requests++;
        const response = await client.dailyRange([s.code], from, to);
        if (week) reconcileWeekly(db, week, lane, 'daily', estimate, response.cells);
        result.cells += Number.isFinite(response.cells) ? response.cells : estimate;
        for (const row of response.rows) {
          const bar = row.code === s.code && normalizeIfind(row, 'daily', { volumeUnit: 'lot',
            amountUnit: s.category === 'FUT_CN' ? 'tenThousand' : 'yuan', allowMissingAmount: true, allowMissingVolume: true });
          if (bar && bar.date <= dateNumber(end)) bars.push(bar);
        }
      } catch (err) {
        result.failed = true; result.errors.push(`${s.name} ${from}—${to}：${err.message}`);
        log(`[futures] ${s.name} ${from}—${to}：${err.message}`);
        break;
      }
    }
    if (result.failed) break;
    tx(db, () => writeIfind(db, 'daily', s.code, bars));
    result.rows += bars.length;
    if (history) filled[s.code] = historyFrom;
    checked[s.code] = { end, at: now };
    log(`[futures] ${s.name} ${start}—${end}：${bars.length} 根日线${history ? `（首次补 ${years} 年历史）` : ''}`);
  }
  setMeta(db, 'ifind_futures_history', filled);
  setMeta(db, 'ifind_futures_checked', checked);
  log(`[futures] 完成：请求 ${result.requests} 次，数据量 ${result.cells}，写入 ${result.rows} 根日线`);
  return result;
}
