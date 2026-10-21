import { openIfindDb } from '../ifind-db.js';
import { mergedDaily, mergedMinutes } from '../ifind-store.js';
import { chinaDate, dateNumber, createIfindClient } from '../ifind-client.js';
import { liveQuotes, refreshMinutes, liveDailyBar } from '../ifind-live.js';
import { ifindConfigured } from '../source-config.js';
import { isMinuteIndex, loadMappings, remoteSymbol } from '../ifind-sync.js';
import { isIfindDomestic } from '../../shared/periods.js';
import { computeRanking, computeIfindRanking } from '../rank.js';
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
// 盘中按需实时：只有被访问的标的才请求 iFinD（见 server/ifind-live.js）
let client, mappings;
const getClient = () => client ??= createIfindClient();
const canLive = (symbol) => ifindConfigured() && isIfindDomestic(symbol);
const live = (symbol) => ({ db: getDb(), client: getClient(), symbol, remote: remoteSymbol(symbol, mappings ??= loadMappings()) });

/** 库里的日线后面接上今天的实时日K（盘后同步写入当天日线之前） */
export function withLiveBar(bars, bar) {
  if (!bar || bars.at(-1)?.timestamp >= bar.timestamp) return bars;
  const { date, ...rest } = bar;
  return [...bars, { ...rest, dataSource: 'ifind-live' }];
}
export async function getDaily(symbol) {
  let bars = dailyBars(getDb(), symbol);
  if (canLive(symbol)) bars = withLiveBar(bars, await liveDailyBar(live(symbol)));
  if (!bars.length) throw new Error(`${symbol.code} 尚无 iFinD 或 Tushare 本地日线，请在服务器运行同步`);
  return bars;
}
/** 分时 Bar；个股带均价线 avg（累计成交额 / 累计成交量，库里分钟成交量单位是股） */
export function intradayBars(rows, symbol) {
  let amount = 0, vol = 0;
  return rows.map((r) => {
    const bar = { ...toBar(r), dataSource: r.source };
    if (symbol.type === 'stock' && r.amount != null) {
      amount += r.amount; vol += r.vol;
      if (vol > 0) bar.avg = Math.round((amount / vol) * 1000) / 1000;
    }
    return bar;
  });
}
/** date = 'YYYY-MM-DD'：历史某天的分时，只读库里已补的分钟历史（不请求接口），没有就报错 */
export async function getIntraday(symbol, date = null) {
  if (!isIfindDomestic(symbol)) throw new Error('iFinD 模式暂只开放境内标的的分时');
  const d = getDb();
  if (canLive(symbol) && (!date || date === chinaDate(Date.now()))) await refreshMinutes(live(symbol));
  const last = date ? null : d.prepare(`SELECT MAX(ts) AS ts FROM
    (SELECT MAX(ts) AS ts FROM ifind_minute WHERE code=? UNION ALL SELECT MAX(ts) FROM minute WHERE code=? AND freq=1)`)
    .get(symbol.code, symbol.code)?.ts;
  if (!date && !last) throw new Error(`${symbol.code} 暂无分时数据（盘中打开时按需拉取）`);
  const day = date ?? chinaDate(last);
  const start = Date.parse(`${day}T00:00:00+08:00`);
  const selected = mergedMinutes(d, symbol.code, start, start+86400_000-1);
  if (!selected.length) throw new Error(`${symbol.name} ${day} 没有分时数据（分钟历史还没补到这天）`);
  const bars = intradayBars(selected, symbol);
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
  if (!isMinuteIndex(symbol)) throw new Error('iFinD 模式个股暂不提供分钟 K');
  if (canLive(symbol)) await refreshMinutes(live(symbol));
  const from = new Date(); from.setUTCMonth(from.getUTCMonth()-6);
  return aggregateMinutes(mergedMinutes(getDb(), symbol.code, from.getTime()), freq);
}
// 同花顺概念排行用 iFinD 的板块列表 / 成分股 / 涨停；申万一级仍读主库（tushare 同步数据）
import { openDb } from '../db.js';
let mainDb;
const getMainDb = () => mainDb ??= openDb();
export async function getRanking(list) {
  if (list !== 'THN') return computeRanking(getMainDb(), list);
  const d = getDb();
  // 盘中用实时行情（见 server/ifind-live.js），拿不到时用盘后数据
  let live = null;
  if (ifindConfigured()) {
    const codes = d.prepare("SELECT code FROM ifind_boards WHERE list = 'THN' AND code IS NOT NULL").all().map((r) => r.code);
    if (codes.length) live = await liveQuotes({ db: d, client: getClient(), codes });
  }
  return computeIfindRanking(d, live);
}
/** 宏观：按期合并，同一期 iFinD 的字段覆盖 tushare；iFinD 没有的期数和字段（更早历史、未映射指标）用 tushare 补 */
export function mergeMacro(tushareRows, ifindRows) {
  const byPeriod = new Map(tushareRows.map((r) => [r.period, { ...JSON.parse(r.data), period: r.period }]));
  for (const r of ifindRows) byPeriod.set(r.period, { ...byPeriod.get(r.period), ...JSON.parse(r.data), period: r.period });
  return [...byPeriod.values()].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}
export async function getMacro(dataset) {
  return mergeMacro(getMainDb().prepare('SELECT period, data FROM macro WHERE dataset = ?').all(dataset),
    getDb().prepare('SELECT period, data FROM ifind_macro WHERE dataset = ?').all(dataset));
}
