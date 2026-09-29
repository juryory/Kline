// 行情缓存 + 周期聚合。只缓存日线，周/月线现算。
import adapter from './adapters/index.js';

const TTL = +(process.env.CACHE_TTL_MS || 5 * 60_000);
const cache = new Map(); // code -> { bars, at } | { pending }

export async function getDaily(symbol, { force = false } = {}) {
  const hit = cache.get(symbol.code);
  if (hit?.pending) return hit.pending;
  if (!force && hit && Date.now() - hit.at < TTL) return hit.bars;

  const pending = adapter
    .getDaily(symbol)
    .then((raw) => {
      const bars = raw.filter((b) =>
        [b.open, b.high, b.low, b.close].every(Number.isFinite) && Number.isFinite(b.timestamp));
      if (!bars.length) throw new Error(`${symbol.code} 没有返回数据`);
      cache.set(symbol.code, { bars, at: Date.now() });
      return bars;
    })
    .catch((err) => {
      // 拉取失败时保留旧缓存，直播画面不受影响
      if (hit) cache.set(symbol.code, hit);
      else cache.delete(symbol.code);
      throw err;
    });

  cache.set(symbol.code, { pending });
  return pending;
}

const INTRADAY_TTL = 30_000;
const intradayCache = new Map(); // code -> { value, at }

export async function getIntraday(symbol, { force = false } = {}) {
  if (!adapter.getIntraday) throw new Error('当前数据源不支持分时');
  const hit = intradayCache.get(symbol.code);
  if (!force && hit && Date.now() - hit.at < INTRADAY_TTL) return hit.value;
  const value = await adapter.getIntraday(symbol);
  if (!value?.bars?.length) throw new Error(`${symbol.code} 没有分时数据`);
  intradayCache.set(symbol.code, { value, at: Date.now() });
  return value;
}

/** 日线聚合：period = 'D' | 'W' | 'M'，时间戳取该周期最后一个交易日 */
export function aggregate(daily, period) {
  if (period === 'D') return daily;
  const keyOf = (ts) => {
    const d = new Date(ts);
    if (period === 'M') return d.getFullYear() * 100 + d.getMonth();
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
