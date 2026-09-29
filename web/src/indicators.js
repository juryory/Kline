/**
 * 导播台可选的指标。key 列表与 server/index.js 的 MAIN_INDICATORS / SUB_INDICATORS 一致。
 * create 传给 KLineChart 的 createIndicator，参数（calcParams）来自导播台设置，见 shared/settings.js。
 */
import { registerIndicator } from 'klinecharts';

export const COLORS = {
  up: '#f0444a', down: '#16a36a', flat: '#9b8a8a',
  // 线条颜色依次用于 MA5 / MA10 / …，最多 6 条
  lines: ['#f0c89a', '#8fa6e8', '#d98ee0', '#6fd3c7', '#e0e070', '#ff9f68'],
};

// 柱子颜色跟随当根 K 线涨跌
const barColor = (data) => {
  const k = data.current.kLineData;
  return { color: !k ? COLORS.flat : k.close > k.open ? COLORS.up : k.close < k.open ? COLORS.down : COLORS.flat };
};

// 成交量：只要柱子，不要均量线；tooltip 标题留空，显示成「成交量 3.25亿」
const volumeFigure = { key: 'volume', title: '', type: 'bar', baseValue: 0, styles: barColor };

// 成交额（元）：数据里的 turnover 字段；同花顺板块没有成交额，显示为空
registerIndicator({
  name: 'AMT',
  shortName: '成交额',
  series: 'volume',
  precision: 0,
  minValue: 0,
  shouldFormatBigNumber: true,
  figures: [{ key: 'amount', title: '', type: 'bar', baseValue: 0, styles: barColor }],
  calc: (list) => list.map((k) => (k.turnover != null ? { amount: k.turnover } : {})),
});

export const MAIN = [
  { key: 'MA', label: 'MA', create: { name: 'MA' } },
  { key: 'EMA', label: 'EMA', create: { name: 'EMA' } },
  { key: 'BOLL', label: 'BOLL', create: { name: 'BOLL' } },
  { key: 'SAR', label: 'SAR', create: { name: 'SAR' } },
];

export const SUB = [
  {
    key: 'VOL', label: '成交量',
    create: { name: 'VOL', shortName: '成交量', calcParams: [], figures: [volumeFigure], regenerateFigures: () => [volumeFigure] },
  },
  { key: 'AMT', label: '成交额', create: { name: 'AMT' } },
  { key: 'MACD', label: 'MACD', create: { name: 'MACD', precision: 2 } },
  { key: 'KDJ', label: 'KDJ', create: { name: 'KDJ', precision: 2 } },
  { key: 'RSI', label: 'RSI', create: { name: 'RSI', precision: 2 } },
];

/** 指标 key + 设置里的参数 → createIndicator 的入参；成交量没有参数 */
export function indicatorCreate(key, params) {
  const def = [...MAIN, ...SUB].find((x) => x.key === key);
  if (!def) return null;
  const calcParams = params?.[key];
  return calcParams ? { ...def.create, calcParams } : def.create;
}

/** 分时图的均价线 */
export const AVP = { name: 'AVP', shortName: '均价', figures: [{ key: 'avp', title: '', type: 'line' }] };
