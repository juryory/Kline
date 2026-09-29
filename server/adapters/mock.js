// 假数据：按标的代码做种子，每次启动走势一致；最后一根收盘价 = symbol.mock.endClose

export const label = '示例数据';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

export async function getDaily(symbol, count = 750) {
  const rand = mulberry32(hash(symbol.code));
  const endClose = symbol.mock?.endClose ?? 10 + (Math.abs(hash(symbol.code)) % 9000) / 100;

  const days = [];
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  while (days.length < count) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) days.unshift(d.getTime());
    d.setDate(d.getDate() - 1);
  }

  const list = [];
  let close = 1000;
  for (let i = 0; i < count; i++) {
    const prev = close;
    const pct = 0.0005 + 0.0012 * Math.sin(i / 45) + (rand() - 0.5) * 0.022;
    const open = prev * (1 + (rand() - 0.5) * 0.006);
    close = prev * (1 + pct);
    const high = Math.max(open, close) * (1 + rand() * 0.006);
    const low = Math.min(open, close) * (1 - rand() * 0.006);
    const volume = Math.round((3.2e8 + rand() * 2.4e8) * (1 + Math.abs(pct) * 20));
    list.push({ timestamp: days[i], open, high, low, close, volume });
  }

  const k = endClose / list[list.length - 1].close;
  const r2 = (v) => Math.round(v * k * 100) / 100;
  return list.map((b) => ({
    ...b, open: r2(b.open), high: r2(b.high), low: r2(b.low), close: r2(b.close),
    turnover: Math.round(b.volume * 100 * b.close * k), // 成交额（元）≈ 成交量（手）× 100 × 价格
  }));
}

/**
 * 分时：最近一个交易日的 1 分钟数据（241 个点：9:30–11:30、13:01–15:00）
 * 用布朗桥从日线开盘价走到收盘价，保证和日线对得上
 */
export async function getIntraday(symbol) {
  const daily = await getDaily(symbol);
  const day = daily.at(-1);
  const prevClose = daily.at(-2).close;
  const rand = mulberry32(hash(symbol.code) ^ day.timestamp);

  const times = [];
  const base = new Date(day.timestamp);
  const at = (h, m) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m).getTime();
  for (let m = 9 * 60 + 30; m <= 11 * 60 + 30; m++) times.push(at(Math.floor(m / 60), m % 60));
  for (let m = 13 * 60 + 1; m <= 15 * 60; m++) times.push(at(Math.floor(m / 60), m % 60));

  const n = times.length - 1;
  const sigma = (day.high - day.low) / 6;
  const walk = [0];
  for (let i = 1; i <= n; i++) walk.push(walk[i - 1] + (rand() - 0.5) * sigma);
  const clamp = (v) => Math.min(day.high, Math.max(day.low, v));
  const prices = walk.map((w, i) => clamp(day.open + w - (i / n) * walk[n] + (i / n) * (day.close - day.open)));
  prices[n] = day.close;

  const weights = times.map((_, i) => 0.4 + Math.pow((i - n / 2) / (n / 2), 2) + rand() * 0.3); // 两头量大
  const wsum = weights.reduce((a, b) => a + b, 0);
  const r2 = (v) => Math.round(v * 100) / 100;

  const bars = times.map((timestamp, i) => {
    const open = i === 0 ? day.open : prices[i - 1];
    const close = prices[i];
    const volume = Math.round((day.volume * weights[i]) / wsum);
    return {
      timestamp,
      open: r2(open), close: r2(close),
      high: r2(Math.max(open, close)), low: r2(Math.min(open, close)),
      volume, turnover: volume * close,
    };
  });
  return { prevClose, bars };
}
