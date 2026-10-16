import { queryPage } from './tushare-client.js';
import { tx } from './db.js';

export const isEtf = (r) => /ETF/i.test(r.name ?? '') && !/联接/.test(r.name ?? '') && /^\d{6}\.(SH|SZ)$/.test(r.ts_code);
export function validDaily(r) {
  const p = [r.open, r.high, r.low, r.close];
  return /^\d{8}$/.test(String(r.trade_date)) && p.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)
    && r.low <= Math.min(r.open, r.close) && r.high >= Math.max(r.open, r.close)
    && [r.vol, r.amount].every(v => v == null || (typeof v === 'number' && Number.isFinite(v) && v >= 0));
}

// 每页都经过限速器。检测重复页，避免接口忽略 offset 时无限循环或静默截断。
export async function etfPages(api, params, fields, size, call) {
  const all = [], seen = new Set();
  for (let offset = 0; ; ) {
    const { rows, hasMore } = await call(api, () => queryPage(api, { ...params, limit: size, offset }, fields));
    if (!rows.length) break;
    const signature = JSON.stringify(rows);
    if (seen.has(signature)) throw new Error(`${api} 分页重复，未将该日标记完成`);
    seen.add(signature); all.push(...rows); offset += rows.length;
    if (hasMore === false || (hasMore == null && rows.length < size)) break;
  }
  return all;
}

export async function syncEtf({ db, call, log = console.log, years = Number(process.env.ETF_YEARS || process.env.SYNC_YEARS || 3) }) {
  if (!Number.isInteger(years) || years < 1 || years > 30) throw new Error('ETF_YEARS 必须为 1～30 的整数');
  const now = new Date(Date.now() + 8 * 3600_000);
  const end = new Date(now);
  // 盘后数据可能分批发布；18 点前只同步到上一个自然日，交易日历再过滤。
  if (now.getUTCHours() < 18) end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(now); start.setUTCFullYear(start.getUTCFullYear() - years);
  const fmt = d => d.toISOString().slice(0, 10).replaceAll('-', '');
  const funds = await etfPages('fund_basic', { market: 'E' }, 'ts_code,name,status,list_date,delist_date', 15000, call);
  const etfs = new Map(funds.filter(isEtf).map(r => [r.ts_code, r]));
  if (!etfs.size) throw new Error('基金目录没有识别到 ETF，未修改已有数据');
  const cal = await etfPages('trade_cal', { exchange: 'SSE', start_date: fmt(start), end_date: fmt(end), is_open: '1' }, 'cal_date', 6000, call);
  const days = [...new Set(cal.map(r => Number(r.cal_date)))].sort((a,b) => b-a);
  const done = db.prepare('SELECT 1 FROM synced WHERE kind=? AND date=?');
  const mark = db.prepare('INSERT OR IGNORE INTO synced VALUES (?,?)');
  const symbol = db.prepare('INSERT OR REPLACE INTO symbols(code,name,type,category) VALUES (?,?,?,?)');
  const put = db.prepare('INSERT OR REPLACE INTO daily(code,date,open,high,low,close,vol,amount) VALUES (?,?,?,?,?,?,?,?)');
  const adj = db.prepare('INSERT OR REPLACE INTO adj(code,date,factor) VALUES (?,?,?)');
  let written = 0, skipped = 0, completed = 0, missingFactors = 0;
  log(`[etf] 目录识别 ${etfs.size} 个 ETF（含已退市）；${fmt(start)}～${fmt(end)}，${days.length} 个交易日，先同步最近日期`);
  for (const [i, day] of days.entries()) {
    if (i >= 2 && done.get('etf_daily', day)) { skipped++; continue; }
    const prices = (await etfPages('fund_daily', { trade_date: String(day) }, 'ts_code,trade_date,open,high,low,close,vol,amount', 5000, call))
      .filter(r => etfs.has(r.ts_code));
    if (!prices.length) { log(`[etf] ${day} 无 ETF 日线，保留待补状态`); continue; }
    if (prices.some(r => Number(r.trade_date) !== day || !validDaily(r))) throw new Error(`${day} ETF 日线数据校验失败，未写入该批`);
    const factors = (await etfPages('fund_adj', { trade_date: String(day) }, 'ts_code,trade_date,adj_factor', 2000, call))
      .filter(r => etfs.has(r.ts_code));
    if (factors.some(r => Number(r.trade_date) !== day || !Number.isFinite(r.adj_factor) || r.adj_factor <= 0)) throw new Error(`${day} ETF 复权因子校验失败`);
    const factorCodes = new Set(factors.map(r => r.ts_code));
    const missing = prices.filter(r => !factorCodes.has(r.ts_code)).length;
    missingFactors += missing;
    tx(db, () => {
      for (const r of prices) {
        symbol.run(r.ts_code, etfs.get(r.ts_code).name, 'etf', 'ETF');
        put.run(r.ts_code, day, r.open, r.high, r.low, r.close, r.vol ?? null, r.amount ?? null);
      }
      for (const r of factors) adj.run(r.ts_code, day, r.adj_factor);
      if (!missing) mark.run('etf_daily', day);
    });
    written += prices.length; completed++;
    if (completed === 1 || completed % 20 === 0 || i === days.length-1 || missing) log(`[etf] ${i+1}/${days.length} ${day}：${prices.length} 条，累计写入 ${written} 条${missing ? `，${missing} 条缺复权因子待补` : ''}`);
  }
  const result = db.prepare("SELECT count(*) AS rows,count(DISTINCT d.code) AS symbols,min(date) AS first,max(date) AS latest FROM daily d JOIN symbols s ON s.code=d.code WHERE s.type='etf'").get();
  log(`[etf] 完成：${JSON.stringify({ ...result, written, skipped, missingFactors })}`);
  if (missingFactors) throw new Error(`ETF 有 ${missingFactors} 条复权因子缺口，已有行情已保存，可再次运行补齐`);
  return result;
}
