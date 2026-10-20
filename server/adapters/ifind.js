import { openIfindDb } from '../ifind-db.js';
import { mergedDaily, mergedMinutes } from '../ifind-store.js';
import { chinaDate, dateNumber } from '../ifind-client.js';
import { isMinuteIndex } from '../ifind-sync.js';
import { computeRanking } from '../rank.js';
import { attachBreadth } from '../breadth.js';

// 保留接口价格精度，ETF 的三位小数不能按股票两位小数舍入。
const toBar = r => ({ timestamp: r.ts, open: r.open, high: r.high, low: r.low, close: r.close,
  volume: r.vol/100, ...(r.amount != null && { turnover: r.amount }) });

export const label = 'iFinD 优先 / Tushare 历史补缺 · 不复权';
let db;
function getDb() {
  if (!db) db = openIfindDb();
  return db;
}
export async function listSymbols() {
  return getDb().prepare(`SELECT * FROM ifind_symbols UNION ALL SELECT * FROM symbols s
    WHERE NOT EXISTS (SELECT 1 FROM ifind_symbols i WHERE i.code=s.code)`).all();
}
export function dailyBars(db, symbol) {
  return mergedDaily(db, symbol.code).map((r) => ({
    timestamp: Date.parse(`${String(r.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}T00:00:00+08:00`),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.vol,
    ...(r.amount != null && { turnover: r.amount * 1000 }), dataSource: r.source,
  }));
}
export async function getDaily(symbol) {
  const bars = dailyBars(getDb(), symbol);
  if (!bars.length) throw new Error(`${symbol.code} 尚无 iFinD 或 Tushare 本地日线，请在服务器运行同步`);
  return bars;
}
export async function getIntraday(symbol) {
  if (!isMinuteIndex(symbol)) throw new Error('iFinD 模式为境内指数、板块和 ETF 开放分时，个股仅日线');
  const d = getDb();
  const last = d.prepare(`SELECT MAX(ts) AS ts FROM
    (SELECT MAX(ts) AS ts FROM ifind_minute WHERE code=? UNION ALL SELECT MAX(ts) FROM minute WHERE code=? AND freq=1)`)
    .get(symbol.code, symbol.code)?.ts;
  if (!last) throw new Error(`${symbol.code} 尚无本地分时，请在服务器运行 iFinD 同步`);
  const day = chinaDate(last);
  const start = Date.parse(`${day}T00:00:00+08:00`);
  const selected = mergedMinutes(d, symbol.code, start, start+86400_000-1);
  const bars = selected.map((r) => ({ ...toBar(r), dataSource: r.source }));
  const prev = d.prepare('SELECT close FROM merged_daily WHERE code=? AND date<? ORDER BY date DESC LIMIT 1')
    .get(symbol.code, dateNumber(day));
  // 缺昨收时明确失败，不能用开盘价冒充昨收导致涨跌幅错误。
  if (!prev) throw new Error(`${symbol.code} 分时已有数据，但缺少前一交易日日线用于昨收，请补同步日线`);
  return { prevClose: prev.close, bars: attachBreadth(d, symbol, bars, prev.close) };
}
export function aggregateMinutes(rows, freq) {
  if (![5,15,30,60].includes(freq)) throw new Error('分钟周期无效');
  const out = [];
  for (const r of rows) {
    const local = new Date(r.ts + 8*3600_000), minute = local.getUTCHours()*60 + local.getUTCMinutes();
    const session = minute >= 570 && minute <= 690 ? 570 : minute >= 780 && minute <= 900 ? 780 : null;
    if (session == null) continue;
    const end = session + Math.max(1, Math.ceil((minute-session)/freq))*freq;
    const timestamp = Date.parse(`${chinaDate(r.ts)}T00:00:00+08:00`) + end*60_000;
    const b = { ...toBar(r), timestamp, dataSource: r.source };
    const prev = out.at(-1);
    if (prev?.timestamp !== timestamp) out.push(b);
    else {
      prev.high = Math.max(prev.high,b.high); prev.low = Math.min(prev.low,b.low); prev.close = b.close;
      prev.volume += b.volume;
      if (b.turnover != null) prev.turnover = (prev.turnover ?? 0) + b.turnover;
      if (prev.dataSource !== b.dataSource) prev.dataSource = 'mixed';
    }
  }
  return out;
}
export async function getMinutes(symbol, freq) {
  if (!isMinuteIndex(symbol)) throw new Error('个股仅同步日线');
  const from = new Date(); from.setUTCMonth(from.getUTCMonth()-6);
  return aggregateMinutes(mergedMinutes(getDb(), symbol.code, from.getTime()), freq);
}
export async function getRanking(list) { return computeRanking(getDb(), list, 'merged_daily'); }
export async function getMacro(dataset) {
  return getDb().prepare('SELECT period,data FROM macro WHERE dataset=? ORDER BY period').all(dataset)
    .map((r) => ({ ...JSON.parse(r.data), period: r.period }));
}
