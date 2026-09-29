// 本地行情库：直播时只读本机 SQLite，不访问公网。数据由 npm run sync 盘后写入。
// 股票做前复权（以最新复权因子为基准），指数原样使用。
import { openDb } from '../db.js';
import { ymdToTs } from '../tushare-client.js';
import { computeRanking } from '../rank.js';

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
  const factors = symbol.type === 'stock'
    ? d.prepare('SELECT date, factor FROM adj WHERE code = ? ORDER BY date').all(symbol.code)
    : [];
  const latest = factors.at(-1)?.factor;
  let j = 0;
  const r2 = (v) => Math.round(v * 100) / 100;

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

// 不导出 getIntraday：本地库只有日线，导播台会自动隐藏「分时」
