// 实时直连 tushare（每次切标的都请求公网）。直播推荐用 local 适配器 + npm run sync。
// 指数用 index_daily，同花顺板块用 ths_daily，个股用 daily（未复权）。vol 单位：手。
import { queryAll, ymd, ymdToTs } from '../tushare-client.js';
import { MINUTES_ENABLED, fetchMinutes, retentionStart, toBar, intradayBars } from '../minutes.js';

export const label = 'Tushare';
const YEARS = 3;
const THS_TYPES = (process.env.SYNC_THS_TYPES || 'N,I').split(',').map((s) => s.trim()).filter(Boolean);

/** 全部上市 A 股 + 同花顺板块，用于检索 */
export async function listSymbols() {
  const rows = await queryAll('stock_basic', { list_status: 'L' }, 'ts_code,name');
  const list = rows.map((r) => ({ code: r.ts_code, name: r.name, type: 'stock' }));
  try {
    for (const type of THS_TYPES) {
      const th = await queryAll('ths_index', { exchange: 'A', type }, 'ts_code,name');
      th.forEach((r) => list.push({ code: r.ts_code, name: r.name, type: 'index', category: `TH${type}` }));
    }
  } catch (err) {
    console.warn('[tushare] 同花顺板块列表失败（需 6000 积分）：', err.message);
  }
  return list;
}

// 按标的选接口；各接口 vol 单位均为手
const SOURCES = [
  { test: (s) => s.type === 'etf', api: 'fund_daily' },
  { test: (s) => s.category?.startsWith('TH') || s.code.endsWith('.TI'), api: 'ths_daily' },
  { test: (s) => s.type === 'index', api: 'index_daily' },
  { test: () => true, api: 'daily' },
];

export async function getDaily(symbol) {
  const start = new Date();
  start.setFullYear(start.getFullYear() - YEARS);

  const src = SOURCES.find((x) => x.test(symbol));
  const fields = src.api === 'ths_daily' ? 'trade_date,open,high,low,close,vol' : 'trade_date,open,high,low,close,vol,amount';
  const rows = await queryAll(src.api, { ts_code: symbol.code, start_date: ymd(start) }, fields, 3000);

  return rows
    .map((r) => ({
      timestamp: ymdToTs(r.trade_date),
      open: +r.open, high: +r.high, low: +r.low, close: +r.close,
      volume: +r.vol,
      ...(r.amount != null && { turnover: +r.amount * 1000 }), // 千元 → 元
    }))
    .sort((a, b) => a.timestamp - b.timestamp); // tushare 返回倒序
}

// 分钟 K / 分时：tushare 历史分钟（stk_mins / idx_mins，需单独开通权限），每次直接请求，不落盘（直播请用 local）
async function getMinutesImpl(symbol, freq) {
  return (await fetchMinutes(symbol, freq, retentionStart(freq))).map((r) => toBar(r));
}

async function getIntradayImpl(symbol, date = null) {
  const rows = await fetchMinutes(symbol, 1, retentionStart(1));
  if (!rows.length) throw new Error(`${symbol.code} 没有分时数据`);
  const last = date ? new Date(`${date}T00:00:00+08:00`) : new Date(rows.at(-1).ts);
  const dayStart = new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime();
  const day = rows.filter((r) => r.ts >= dayStart && r.ts < dayStart + 86400_000);
  if (!day.length) throw new Error(`${symbol.name} ${date} 没有分时数据`);
  const daily = await getDaily(symbol);
  const prev = daily.filter((b) => b.timestamp < dayStart).at(-1);
  const bars = intradayBars(day, symbol);
  return { prevClose: prev?.close ?? bars[0].open, bars };
}

export const getMinutes = MINUTES_ENABLED ? getMinutesImpl : undefined;
export const getIntraday = MINUTES_ENABLED ? getIntradayImpl : undefined;
