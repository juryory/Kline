import { registerOverlay } from 'klinecharts';

/**
 * K 线画线工具：KLineChart 内置 overlay（画笔 brush 为自定义）。key 与 server/index.js 的 DRAW_TOOLS 一致。
 * 画线按「时间戳 + 价格」存在服务端，各周期共用（日K 上画的线在周K / 月K 上也在对应位置）。
 */
// more = 收在工具栏「更多」里，点开才显示
export const DRAW_TOOLS = [
  { key: 'segment', label: '线段', icon: '╱' },
  { key: 'rayLine', label: '射线', icon: '↗' },
  { key: 'straightLine', label: '直线', icon: '⟋' },
  { key: 'simpleAnnotation', label: '文字标注', icon: 'T' },
  { key: 'brush', label: '画笔', icon: '✎' },
  { key: 'horizontalStraightLine', label: '水平线', icon: '―', more: true },
  { key: 'priceLine', label: '价格线', icon: '⊢', more: true },
  { key: 'parallelStraightLine', label: '平行线', icon: '∥', more: true },
  { key: 'priceChannelLine', label: '通道线', icon: '⫽', more: true },
  { key: 'fibonacciLine', label: '黄金分割', icon: 'φ', more: true },
];

/**
 * 画笔：按住拖动自由画线，经过的点连成折线。端点用小数下标（落在两根 K 线之间），线条才连续；
 * 存储时换成按相邻 K 线插值的时间戳，切周期后同样按比例落位。最多 BRUSH_MAX_POINTS 个点（与服务端一致）
 */
export const BRUSH = 'brush';
export const BRUSH_MAX_POINTS = 200;
registerOverlay({
  name: BRUSH,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates }) =>
    coordinates.length > 1 ? [{ type: 'line', attrs: { coordinates } }] : [],
});

/** 两个端点的工具：触屏上改为按住拖动画线（按下 = 起点，松手 = 终点），鼠标仍是依次点击。画笔始终是拖动 */
export const DRAG_TOOLS = new Set(['segment', 'rayLine', 'straightLine', 'fibonacciLine']);
export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches;
export const dragDrawable = (name) => name === 'brush' || (DRAG_TOOLS.has(name) && isTouchDevice());

export const DRAW_COLOR = '#ffcc4d';

/** 画线样式：lineWidth = 设置里的画线粗细；直播画面按 scale 放大线宽与字号 */
export const drawStyles = (scale = 1, lineWidth = 1.5) => ({
  line: { color: DRAW_COLOR, size: lineWidth * scale },
  // 文字（标注、黄金分割比例、价格线价格）：黄底深色字，和画线同色系
  text: { color: '#1a1a1a', backgroundColor: DRAW_COLOR, borderColor: DRAW_COLOR, size: Math.round(12 * scale) },
  polygon: { color: DRAW_COLOR }, // 标注的箭头
  point: {
    color: DRAW_COLOR, borderColor: 'rgba(255,204,77,0.35)',
    activeColor: DRAW_COLOR, activeBorderColor: 'rgba(255,204,77,0.35)',
  },
});

// 最近若干根 K 线的中位间隔，用于推算数据范围之外的时间位置
function stepOf(bars) {
  const n = bars.length;
  if (n < 2) return 86_400_000;
  const gaps = [];
  for (let i = Math.max(1, n - 20); i < n; i++) gaps.push(bars[i].timestamp - bars[i - 1].timestamp);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 86_400_000;
}

/**
 * 时间戳 → 在完整数据里的下标（最近的一根）。超出数据范围时按平均间隔外推，
 * 这样画线端点不在当前显示区间内时，线的位置和斜率仍然正确。
 */
export function timeToIndex(bars, t) {
  const n = bars.length;
  if (!n) return 0;
  if (t > bars[n - 1].timestamp) return n - 1 + Math.round((t - bars[n - 1].timestamp) / stepOf(bars));
  if (t < bars[0].timestamp) return Math.round((t - bars[0].timestamp) / stepOf(bars));
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp <= t) lo = mid; else hi = mid;
  }
  return t - bars[lo].timestamp <= bars[hi].timestamp - t ? lo : hi;
}

/** 时间戳 → 小数下标（画笔用）：落在两根 K 线之间时按时间线性插值，超出范围按平均间隔外推 */
export function timeToIndexF(bars, t) {
  const n = bars.length;
  if (!n) return 0;
  if (t >= bars[n - 1].timestamp) return n - 1 + (t - bars[n - 1].timestamp) / stepOf(bars);
  if (t <= bars[0].timestamp) return (t - bars[0].timestamp) / stepOf(bars);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp <= t) lo = mid; else hi = mid;
  }
  return lo + (t - bars[lo].timestamp) / (bars[hi].timestamp - bars[lo].timestamp);
}

/** 小数下标 → 时间戳（timeToIndexF 的逆运算） */
export function indexToTimeF(bars, idx) {
  const n = bars.length;
  if (!n) return Date.now();
  if (idx >= n - 1) return Math.round(bars[n - 1].timestamp + (idx - n + 1) * stepOf(bars));
  if (idx <= 0) return Math.round(bars[0].timestamp + idx * stepOf(bars));
  const i = Math.floor(idx);
  return Math.round(bars[i].timestamp + (idx - i) * (bars[i + 1].timestamp - bars[i].timestamp));
}

/** 下标 → 时间戳（数据范围外同样外推） */
export function indexToTime(bars, idx) {
  const n = bars.length;
  const i = Math.round(idx);
  if (i >= 0 && i < n) return bars[i].timestamp;
  if (!n) return Date.now();
  return i >= n ? bars[n - 1].timestamp + (i - n + 1) * stepOf(bars) : bars[0].timestamp + i * stepOf(bars);
}
