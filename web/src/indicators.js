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

/**
 * 分时图主图指标（extendData = 昨收）：
 *   均价线：bar.avg，只有个股有
 *   领先指标（黄线）+ 红绿柱：bar.lead / bar.up / bar.down，只有大盘指数有（服务端盘后算好，见 server/breadth.js）
 *     红绿柱从昨收线往上（红，上涨家数多）/ 往下（绿）画，长度 = 涨跌家数差，按当天最大值缩放到半个纵轴
 *   昨收虚线；两条透明线把纵轴撑成以昨收为中心上下对称（与同花顺一致，涨跌幅度一眼可比）
 */
const LEAD_COLOR = '#f0b90b';
const TRANSPARENT = 'rgba(0,0,0,0)';
registerIndicator({
  name: 'TIMELINE',
  shortName: '分时',
  precision: 2,
  figures: [
    { key: 'avg', title: '均价 ', type: 'line', styles: () => ({ color: COLORS.lines[0] }) },
    { key: 'lead', title: '领先 ', type: 'line', styles: () => ({ color: LEAD_COLOR }) },
    { key: 'pc', title: '', type: 'line', styles: () => ({ color: 'rgba(232,232,236,0.35)', style: 'dashed', dashedValue: [4, 4] }) },
    { key: 'hi', title: '', type: 'line', styles: () => ({ color: TRANSPARENT }) },
    { key: 'lo', title: '', type: 'line', styles: () => ({ color: TRANSPARENT }) },
  ],
  calc: (list, indicator) => {
    const pc = indicator.extendData;
    if (!Number.isFinite(pc)) return list.map((k) => ({ avg: k.avg, lead: k.lead }));
    let dev = 0, maxAdv = 0;
    for (const k of list) {
      dev = Math.max(dev, Math.abs(k.high - pc), Math.abs(k.low - pc));
      if (k.avg != null) dev = Math.max(dev, Math.abs(k.avg - pc));
      if (k.lead != null) dev = Math.max(dev, Math.abs(k.lead - pc));
      if (k.up != null) maxAdv = Math.max(maxAdv, Math.abs(k.up - k.down));
    }
    dev = dev * 1.08 || pc * 0.01; // 留一点边；全天不动时按 ±1%
    return list.map((k) => ({
      avg: k.avg, lead: k.lead, pc, hi: pc + dev, lo: pc - dev,
      // 红绿柱的顶端（价格坐标）
      ...(k.up != null && maxAdv > 0 && { bar: pc + ((k.up - k.down) / maxAdv) * dev * 0.5 }),
    }));
  },
  // 红绿柱：自己画细竖线（KLineChart 的柱子只能从固定值起画），返回 false 让上面的线照常画
  draw: ({ ctx, indicator, visibleRange, xAxis, yAxis }) => {
    const pc = indicator.extendData;
    if (!Number.isFinite(pc)) return false;
    const y0 = yAxis.convertToPixel(pc);
    ctx.lineWidth = 1;
    for (let i = visibleRange.from; i < visibleRange.to; i++) {
      const v = indicator.result[i]?.bar;
      if (v == null || v === pc) continue;
      const x = Math.round(xAxis.convertToPixel(i)) + 0.5;
      ctx.strokeStyle = v > pc ? COLORS.up : COLORS.down;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, yAxis.convertToPixel(v));
      ctx.stroke();
    }
    return false;
  },
  // 图内左上角：均价（个股）/ 领先指标和涨跌家数（大盘）+ 当前点相对昨收的涨跌幅
  createTooltipDataSource: ({ kLineDataList, crosshair, indicator }) => {
    const k = kLineDataList[crosshair?.dataIndex] ?? kLineDataList.at(-1);
    const pc = indicator.extendData;
    const values = [];
    if (k?.avg != null) values.push({ title: '均价 ', value: { text: k.avg.toFixed(2), color: COLORS.lines[0] } });
    if (k?.lead != null) values.push({ title: '领先 ', value: { text: k.lead.toFixed(2), color: LEAD_COLOR } });
    if (k?.up != null) {
      values.push({ title: '涨 ', value: { text: String(k.up), color: COLORS.up } });
      values.push({ title: '跌 ', value: { text: String(k.down), color: COLORS.down } });
    }
    if (k && Number.isFinite(pc) && pc) {
      const pct = (k.close / pc - 1) * 100;
      values.push({
        title: '涨跌 ',
        value: { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, color: pct > 0 ? COLORS.up : pct < 0 ? COLORS.down : COLORS.flat },
      });
    }
    return { name: '', calcParamsText: '', icons: [], values };
  },
});

export const timelineCreate = (prevClose) => ({ name: 'TIMELINE', extendData: prevClose });
