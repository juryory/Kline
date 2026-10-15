// 本地行情库：直播时只读本机 SQLite，不访问公网。数据由 npm run sync 盘后写入。
// 股票做前复权（以最新复权因子为基准），指数原样使用。
import { openDb } from '../db.js';
import { ymdToTs } from '../tushare-client.js';
import { computeRanking } from '../rank.js';
import { MINUTES_ENABLED, readMinutes, toBar, intradayBars } from '../minutes.js';
import { attachBreadth } from '../breadth.js';

export const label = 'Tushare';

let db = null;
const getDb = () => (db ??= openDb({ mustExist: true }));

export async function listSymbols() {
  return getDb().prepare('SELECT code, name, type, category FROM symbols').all()
    .map(({ code, name, type, category }) => ({ code, name, type, category }));
}

export async function getDaily(symbol) {
  const d = getDb();
  const rows = d.prepare('SELECT date, open, high, low, close, vol, amount FROM daily WHERE code = ? ORDER BY date').all(symbol.code);
  if (!rows.length) throw new Error(`本地库没有 ${symbol.code} 的日线（新标的需先运行 npm run sync）`);

  // 前复权：价格 × 当日因子 / 最新因子。某天缺因子时沿用前一天的（当天因子可能还没发布）
  const factors = ['stock', 'etf'].includes(symbol.type)
    ? d.prepare('SELECT date, factor FROM adj WHERE code = ? ORDER BY date').all(symbol.code)
    : [];
  const latest = factors.at(-1)?.factor;
  let j = 0;
  const precision = symbol.type === 'etf' ? 1000 : 100;
  const r2 = (v) => Math.round(v * precision) / precision;

  return rows.map((r) => {
    let k = 1;
    if (latest) {
      while (j + 1 < factors.length && factors[j + 1].date <= r.date) j++;
      k = factors[j].factor / latest;
    }
    return {
      timestamp: ymdToTs(r.date),
      open: r2(r.open * k), high: r2(r.high * k), low: r2(r.low * k), close: r2(r.close * k),
      volume: r.vol,
      // 成交额：库里是千元，统一成元；同花顺板块没有成交额
      ...(r.amount != null && { turnover: r.amount * 1000 }),
    };
  });
}

/** 宏观数据集（见 shared/macro.js），按期间正序，每行是接口原始字段 + period */
export async function getMacro(dataset) {
  return getDb().prepare('SELECT period, data FROM macro WHERE dataset = ? ORDER BY period').all(dataset)
    .map((r) => ({ ...JSON.parse(r.data), period: r.period }));
}

/** 板块排名（申万一级 SW1 / 同花顺概念 THN） */
export async function getRanking(listKey) {
  return computeRanking(getDb(), listKey);
}

// ---------------- 分钟 K / 分时（tushare 历史分钟，按需拉取缓存到本地库，见 server/minutes.js） ----------------
// 没有 TUSHARE_TOKEN 或 MINUTE_MONTHS=0 时不导出，导播台自动隐藏这些周期

/** 当天的前复权系数：与日线一致，以最新复权因子为基准 */
function adjFactors(code) {
  const factors = getDb().prepare('SELECT date, factor FROM adj WHERE code = ? ORDER BY date').all(code);
  const latest = factors.at(-1)?.factor;
  if (!latest) return () => 1;
  return (ts) => {
    const d = new Date(ts);
    const ymd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    let lo = 0, hi = factors.length - 1, f = factors[0].factor;
    while (lo <= hi) { // 当天或之前最近一天的因子
      const mid = (lo + hi) >> 1;
      if (factors[mid].date <= ymd) { f = factors[mid].factor; lo = mid + 1; } else hi = mid - 1;
    }
    return f / latest;
  };
}

/** 分钟 K：freq = 5 / 15 / 30 / 60，最近 MINUTE_MONTHS 个月。个股前复权，指数原样 */
async function getMinutesImpl(symbol, freq) {
  const rows = await readMinutes(getDb(), symbol, freq);
  if (!rows.length) throw new Error(`${symbol.code} 没有 ${freq} 分钟数据`);
  const k = symbol.type === 'stock' ? adjFactors(symbol.code) : () => 1;
  return rows.map((r) => toBar(r, k(r.ts)));
}

/** 分时：最近一个交易日的 1 分钟线（不复权），昨收取本地日线里前一个交易日的收盘价 */
async function getIntradayImpl(symbol) {
  const rows = await readMinutes(getDb(), symbol, 1);
  if (!rows.length) throw new Error(`${symbol.code} 没有分时数据`);
  const last = new Date(rows.at(-1).ts);
  const dayStart = new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime();
  const ymd = last.getFullYear() * 10000 + (last.getMonth() + 1) * 100 + last.getDate();
  const bars = intradayBars(rows.filter((r) => r.ts >= dayStart), symbol);
  const prev = getDb().prepare('SELECT close FROM daily WHERE code = ? AND date < ? ORDER BY date DESC LIMIT 1').get(symbol.code, ymd);
  const prevClose = prev?.close ?? bars[0].open;
  // 大盘指数：补上领先指标 / 涨跌家数（盘后算好的，见 server/breadth.js）
  return { prevClose, bars: attachBreadth(getDb(), symbol, bars, prevClose) };
}

export const getMinutes = MINUTES_ENABLED ? getMinutesImpl : undefined;
export const getIntraday = MINUTES_ENABLED ? getIntradayImpl : undefined;
