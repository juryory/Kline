// 实时直连 tushare（每次切标的都请求公网）。直播推荐用 local 适配器 + npm run sync。
// 指数用 index_daily，同花顺板块用 ths_daily，个股用 daily（未复权）。vol 单位：手。
import { queryAll, ymd, ymdToTs } from '../tushare-client.js';

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

// 分时：tushare 的分钟数据（stk_mins）需要单独开通权限。接入时在这里导出 getIntraday(symbol)，
// 返回 { prevClose, bars }（见 adapters/index.js），导播台会自动出现「分时」。
