import { PERIODS, periodsFor as periodsForCaps } from '../../shared/periods.js';

/**
 * 视图 = { bars: 显示多少根, end: 最右一根的时间戳（null = 跟随最新） }
 * 导播台和渲染页共用同一个视图，各自按自己的宽度计算柱宽，所以显示的区间完全一致。
 * 范围与 server/index.js 的 MIN_BARS / MAX_BARS 保持一致。分时不受视图控制，始终显示全天。
 */
export const MIN_BARS = 40;
export const MAX_BARS = 1000;
export const INTRADAY_POINTS = 241; // 9:30–11:30 + 13:01–15:00

export { PERIODS, PRIMARY_PERIODS, isMinutePeriod } from '../../shared/periods.js';

/**
 * 当前数据源 + 标的可用的周期（从小到大；回车往左更细，Backspace 往右更粗）。
 * 数据源不支持分时 / 分钟 K、或标的是板块（没有分钟数据）时去掉对应周期
 */
export const periodsFor = (status, symbol = null) =>
  periodsForCaps({ intraday: status?.intraday !== false, minutes: !!status?.minutes, indexOnly: status?.indexOnly }, symbol);

/** 键盘可切换的周期：跳过分钟 K（只能点周期按钮进入），日K 和分时直接相邻 */
export const keyPeriods = (list = PERIODS) => list.filter((p) => p.kind !== 'minute');

/** 回车（dir = -1）更细、Backspace（dir = 1）更粗；在分钟 K 上时回车进分时、Backspace 回日K */
export function stepPeriod(period, dir, list = PERIODS) {
  const keys = keyPeriods(list);
  const i = keys.findIndex((p) => p.key === period);
  if (i < 0) return (dir < 0 ? keys[0] : keys.find((p) => p.key === 'D') ?? keys[0]).key;
  return keys[Math.min(keys.length - 1, Math.max(0, i + dir))].key;
}

/** 视图 → 最右一根的下标 */
export function endIndexOf(bars, view) {
  const n = bars.length;
  if (!n) return -1;
  if (view?.end == null) return n - 1;
  let i = n - 1;
  while (i > 0 && bars[i].timestamp > view.end) i--;
  return i;
}

/**
 * 最少显示根数：KLineChart 单根柱宽上限 50px，画面越宽，能放大到的根数越多，
 * 否则直播画面放不下这么"粗"的 K 线，会和导播台显示的区间不一致
 */
export const minBarsFor = (renderWidth) => Math.max(MIN_BARS, Math.ceil(renderWidth / 48));

/** 在当前视图基础上缩放 / 平移，返回规整后的新视图 */
export function moveView(bars, view, { zoom = 1, shift = 0, toLatest = false, toEarliest = false }, minBars = MIN_BARS) {
  const n = bars.length;
  // 数据比最少根数还少时（月K、新上市的板块）就全部显示，不再缩放
  const count = Math.min(MAX_BARS, n, Math.max(minBars, Math.round(view.bars * zoom)));
  let end = toLatest ? n - 1 : toEarliest ? 0 : endIndexOf(bars, view) + shift;
  end = Math.min(n - 1, Math.max(Math.min(n, count) - 1, end));
  return { bars: count, end: end >= n - 1 ? null : bars[end].timestamp };
}

/** 价格小数位：ETF 3 位，外汇 4 位（美元兑离岸人民币），其他 2 位 */
export const priceDigits = (symbol) => symbol?.type === 'etf' ? 3 : symbol?.type === 'fx' ? 4 : 2;

/** 页头行情：当日最新价与涨跌幅（相对昨收），周K/月K 下也是当日涨跌 */
export function quoteOf(data) {
  const { close, prevClose } = data.quote;
  const pct = ((close - prevClose) / prevClose) * 100;
  return {
    close: close.toFixed(priceDigits(data.symbol)),
    pct: (pct > 0 ? '+' : '') + pct.toFixed(2) + '%',
    trend: pct > 0 ? 'up' : pct < 0 ? 'down' : '',
  };
}
