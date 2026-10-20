// 行情缓存 + 周期聚合。缓存日线 / 分时 / 分钟 K，周 / 月 / 年线由日线现算。
import adapter, { adapterName } from './adapters/index.js';
import { marketPhase } from './ifind-live.js';

const TTL = +(process.env.CACHE_TTL_MS || 5 * 60_000);
const cache = new Map(); // code -> { bars, at } | { pending }

export async function getDaily(symbol, { force = false } = {}) {
  const key = `${adapterName}:${symbol.code}`;
  const hit = cache.get(key);
  if (hit?.pending) return hit.pending;
  // iFinD 盘中日线带今天的实时日K，缓存缩短到 1 分钟
  const ttl = adapterName === 'ifind' && marketPhase() === 'session' ? Math.min(TTL, 60_000) : TTL;
  if (!force && hit && Date.now() - hit.at < ttl) return hit.bars;

  const pending = adapter
    .getDaily(symbol)
    .then((raw) => {
      const bars = raw.filter((b) =>
        [b.open, b.high, b.low, b.close].every(Number.isFinite) && Number.isFinite(b.timestamp));
      if (!bars.length) throw new Error(`${symbol.code} 没有返回数据`);
      cache.set(key, { bars, at: Date.now() });
      return bars;
    })
    .catch((err) => {
      // 拉取失败时保留旧缓存，直播画面不受影响
      if (hit) cache.set(key, hit);
      else cache.delete(key);
      throw err;
    });

  cache.set(key, { pending });
  return pending;
}

const INTRADAY_TTL = 30_000;
const intradayCache = new Map(); // code -> { value, at }

export async function getIntraday(symbol, { force = false } = {}) {
  if (!adapter.getIntraday) throw new Error('当前数据源不支持分时');
  const key = `${adapterName}:${symbol.code}`;
  const hit = intradayCache.get(key);
  if (!force && hit && Date.now() - hit.at < INTRADAY_TTL) return hit.value;
  const value = await adapter.getIntraday(symbol);
  if (!value?.bars?.length) throw new Error(`${symbol.code} 没有分时数据`);
  intradayCache.set(key, { value, at: Date.now() });
  return value;
}

const MINUTE_TTL = 60_000;
const minuteCache = new Map(); // `${code}|${freq}` -> { bars, at }

/** 分钟 K（freq = 5 / 15 / 30 / 60），内存缓存 1 分钟；本地库那层的缓存见 server/minutes.js */
export async function getMinutes(symbol, freq, { force = false } = {}) {
  if (!adapter.getMinutes) throw new Error('当前数据源不支持分钟 K');
  const key = `${adapterName}:${symbol.code}|${freq}`;
  const hit = minuteCache.get(key);
  if (!force && hit && Date.now() - hit.at < MINUTE_TTL) return hit.bars;
  const bars = (await adapter.getMinutes(symbol, freq)).filter((b) =>
    [b.open, b.high, b.low, b.close].every(Number.isFinite) && Number.isFinite(b.timestamp));
  if (!bars.length) throw new Error(`${symbol.code} 没有 ${freq} 分钟数据`);
  minuteCache.set(key, { bars, at: Date.now() });
  return bars;
}

/** 日线聚合：period = 'D' | 'W' | 'M' | 'Y'，时间戳取该周期最后一个交易日 */
export function aggregate(daily, period) {
  if (period === 'D') return daily;
  const keyOf = (ts) => {
    const d = new Date(ts);
    if (period === 'M') return d.getFullYear() * 100 + d.getMonth();
    if (period === 'Y') return d.getFullYear();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  };
  const out = [];
  let cur = null, curKey = null;
  for (const b of daily) {
    const k = keyOf(b.timestamp);
    if (k !== curKey) {
      if (cur) out.push(cur);
      cur = { ...b };
      curKey = k;
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      if (b.turnover != null) cur.turnover = (cur.turnover ?? 0) + b.turnover;
      cur.timestamp = b.timestamp;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function clearMarketCache() { cache.clear(); intradayCache.clear(); minuteCache.clear(); }
