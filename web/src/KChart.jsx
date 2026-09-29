import { useEffect, useRef } from 'react';
import { init, dispose } from 'klinecharts';
import { endIndexOf, moveView, INTRADAY_POINTS } from './view.js';
import { COLORS as C, AVP, indicatorCreate } from './indicators.js';
import { drawStyles, timeToIndex, indexToTime } from './drawTools.js';

const AXIS_TEXT = '#9b8a8a';
const RIGHT_GAP = 8;       // 最右一根与 y 轴之间留的像素
const MAX_BAR_SPACE = 50;  // KLineChart 的上限，超出会被忽略
const CANDLE = 'candle_pane';
const SUB = 'sub_pane';

const pad = (n) => String(n).padStart(2, '0');
export const fmtBig = (v) => {
  v = +v;
  if (Math.abs(v) >= 1e12) return (v / 1e12).toFixed(2) + '万亿';
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(Math.abs(v) >= 1e10 ? 0 : 2) + '亿';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(0) + '万';
  return String(Math.round(v));
};

/** scale：直播画面相对 966×320 的放大倍数，字号和线宽随之放大 */
function chartOptions(terminal, periodRef, scale) {
  const font = Math.round((terminal ? 12 : 11) * scale);
  const line = 1.5 * scale;
  return {
    locale: 'zh-CN',
    customApi: {
      formatBigNumber: fmtBig,
      formatDate: (_, ts, __, type) => {
        const d = new Date(ts);
        const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const p = periodRef.current;
        if (p === 'T') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        if (type === 2 && p === 'D') return md;
        if (type === 2 && p === 'M') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
        return `${d.getFullYear()}-${md}`;
      },
    },
    styles: {
      grid: {
        horizontal: { color: 'rgba(255,255,255,0.06)', style: 'dashed', dashedValue: [3, 3] },
        vertical: { show: false },
      },
      candle: {
        bar: {
          upColor: C.up, downColor: C.down, noChangeColor: C.flat,
          upBorderColor: C.up, downBorderColor: C.down, noChangeBorderColor: C.flat,
          upWickColor: C.up, downWickColor: C.down, noChangeWickColor: C.flat,
        },
        area: {
          lineSize: line, lineColor: '#e8e8ec',
          backgroundColor: [{ offset: 0, color: 'rgba(232,232,236,0.01)' }, { offset: 1, color: 'rgba(232,232,236,0.15)' }],
          point: { show: false },
        },
        priceMark: {
          high: { show: terminal, color: AXIS_TEXT }, low: { show: terminal, color: AXIS_TEXT },
          last: { upColor: C.up, downColor: C.down, noChangeColor: C.flat, line: { style: 'dashed' }, text: { size: font } },
        },
        tooltip: { showRule: terminal ? 'follow_cross' : 'none', text: { color: AXIS_TEXT, size: font } },
      },
      indicator: {
        bars: [{ upColor: C.up, downColor: C.down, noChangeColor: C.flat }],
        // 每条线的样式要写全：KLineChart 默认只有 5 套线条样式，第 6 条以后缺 dashedValue 等字段会导致主图绘制报错、画面卡住
        lines: C.lines.map((color) => ({ color, size: line, style: 'solid', smooth: false, dashedValue: [2, 2] })),
        lastValueMark: { show: false },
        // 直播画面没有鼠标，tooltip 显示的是画面最右一根的指标值
        tooltip: { showRule: 'always', showParams: false, text: { color: AXIS_TEXT, size: font, marginTop: 4 } },
      },
      xAxis: { axisLine: { show: false }, tickLine: { show: false }, tickText: { color: AXIS_TEXT, size: font } },
      yAxis: { axisLine: { show: false }, tickLine: { show: false }, tickText: { color: AXIS_TEXT, size: font } },
      separator: { color: 'rgba(255,255,255,0.08)' },
      crosshair: { show: terminal },
    },
  };
}

/**
 * K 线图。数据只喂到视图最右一根为止，再按 宽度/根数 设柱宽，
 * 不依赖图表内部的滚动状态，导播台和直播画面显示的区间必然一致。
 *
 * terminal：导播台模式，带十字光标、滚轮缩放、拖拽平移（通过 onViewChange 回传）
 * params：指标参数（导播台设置），scale：字号/线宽放大倍数，minBars：最少显示根数
 *
 * 画线：drawings = 当前标的的画线 [{ id, name, points: [{ t, v }], text? }]
 *   直播画面只显示（锁定不可编辑）；导播台可拖动端点修改（onDrawChange）、选中（onDrawSelect），
 *   drawTool = { name, text? } 时进入绘制模式，画完回调 onDrawEnd
 */
export default function KChart({
  data, view, main, sub, params, terminal = false, subHeight = 50, scale = 1, minBars, onViewChange,
  drawings, drawTool, onDrawEnd, onDrawChange, onDrawSelect,
}) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const periodRef = useRef(data.period);
  periodRef.current = data.period;
  const intraday = data.period === 'T';

  // 事件处理和 ResizeObserver 里要读最新的 props
  const latest = useRef();
  latest.current = { data, view, onViewChange, minBars, onDrawEnd, onDrawChange, onDrawSelect };
  // 画线交互状态：鼠标在画线上 / 正在绘制时，不触发拖拽平移
  const drawState = useRef({ hover: false, pendingId: null, shown: new Set() });

  const render = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const { data, view } = latest.current;
    const isT = data.period === 'T';
    const n = data.bars.length;
    const endIdx = isT ? n - 1 : endIndexOf(data.bars, view);
    // K 线：数据不足视图根数时（如从日K切到月K），按实际根数铺满，不在左侧留空
    const count = isT ? Math.max(INTRADAY_POINTS, n) : Math.min(view.bars, n);

    // 分时的最新价标签按"相对昨收"着色，K 线按最后一根涨跌
    const lastColor = isT && (data.bars[n - 1].close >= data.prevClose ? C.up : C.down);
    chart.setStyles({
      candle: {
        priceMark: {
          last: {
            show: endIdx === n - 1,
            upColor: lastColor || C.up, downColor: lastColor || C.down, noChangeColor: lastColor || C.flat,
          },
        },
      },
    });
    chart.applyNewData(data.bars.slice(0, endIdx + 1));

    const w = chart.getSize(CANDLE, 'main')?.width;
    if (!w) return;
    const space = Math.max(1, Math.min(MAX_BAR_SPACE, (w - RIGHT_GAP) / count));
    chart.setBarSpace(space);
    // 分时盘中没走完时，右侧留出剩余时间的位置
    chart.setOffsetRightDistance(RIGHT_GAP + (isT ? (count - n) * space : 0));
  };

  // 创建 / 销毁图表
  useEffect(() => {
    const el = elRef.current;
    const chart = init(el, chartOptions(terminal, periodRef, scale));
    chart.setPriceVolumePrecision(2, 0);
    chart.setZoomEnabled(false);   // 缩放/平移统一走 view，由导播台控制
    chart.setScrollEnabled(false);
    chartRef.current = chart;
    el.__kchart = chart; // 便于在浏览器控制台 / 自动化测试里检查图表状态
    drawState.current = { hover: false, pendingId: null, shown: new Set() };

    const ro = new ResizeObserver(() => { chart.resize(); render(); });
    ro.observe(el);
    return () => {
      ro.disconnect();
      dispose(el);
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, scale]);

  // ---------------- 画线 ----------------
  // overlay 端点用「完整数据里的下标」定位（当前只喂到视图最右一根，下标与完整数据一致）
  const overlayCallbacks = () => (terminal ? {
    onMouseEnter: () => { drawState.current.hover = true; return false; },
    onMouseLeave: () => { drawState.current.hover = false; return false; },
    onSelected: (e) => { latest.current.onDrawSelect?.(e.overlay.id); return false; },
    onDeselected: () => { latest.current.onDrawSelect?.(null); return false; },
    onPressedMoveEnd: (e) => { latest.current.onDrawChange?.(toDrawing(e.overlay)); return false; },
  } : {});
  const toDrawing = (o) => {
    const bars = latest.current.data.bars;
    return {
      id: o.id, name: o.name,
      points: o.points.map((p) => ({ t: indexToTime(bars, p.dataIndex), v: p.value })),
      ...(o.extendData ? { text: o.extendData } : {}),
    };
  };

  // 服务端画线 → 图上 overlay：新增的创建、已有的更新端点、删掉的移除
  const drawingsKey = JSON.stringify(drawings ?? []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const st = drawState.current;
    const bars = data.bars;
    const want = drawings ?? [];
    const wantIds = new Set(want.map((d) => d.id));
    for (const id of st.shown) {
      if (!wantIds.has(id) && id !== st.pendingId) { chart.removeOverlay(id); st.shown.delete(id); }
    }
    for (const d of want) {
      const points = d.points.map((p) => ({ dataIndex: timeToIndex(bars, p.t), value: p.v }));
      if (st.shown.has(d.id) && chart.getOverlayById(d.id)) {
        chart.overrideOverlay({ id: d.id, points, extendData: d.text });
      } else {
        chart.createOverlay({
          id: d.id, groupId: 'drawings', name: d.name, points, extendData: d.text,
          lock: !terminal, styles: drawStyles(scale), ...overlayCallbacks(),
        });
        st.shown.add(d.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingsKey, data.symbol.code, data.period, data.bars.length, terminal, scale]);

  // 导播台：进入绘制模式
  useEffect(() => {
    const chart = chartRef.current;
    const st = drawState.current;
    if (!terminal || !chart || !drawTool) return;
    const id = `d${Date.now().toString(36)}`;
    st.pendingId = id;
    chart.createOverlay({
      id, groupId: 'drawings', name: drawTool.name, extendData: drawTool.text,
      styles: drawStyles(scale), ...overlayCallbacks(),
      onDrawEnd: (e) => {
        st.pendingId = null;
        st.shown.add(id);
        latest.current.onDrawEnd?.(toDrawing(e.overlay));
        return false;
      },
    });
    return () => {
      // 没画完就取消（换工具、按 Esc、切标的）
      if (st.pendingId === id) { chart.removeOverlay(id); st.pendingId = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawTool, terminal]);

  // 图形类型与指标：分时 = 面积图 + 均价线，K 线 = 蜡烛 + 导播选的主图指标（参数来自设置）
  const paramsKey = JSON.stringify(params ?? null);
  useEffect(() => {
    const chart = chartRef.current;
    chart.setStyles({ candle: { type: intraday ? 'area' : 'candle_solid' } });

    chart.removeIndicator(CANDLE);
    const mainDef = intraday ? AVP : indicatorCreate(main, params);
    if (mainDef) chart.createIndicator(mainDef, true, { id: CANDLE });

    chart.removeIndicator(SUB);
    const subDef = indicatorCreate(sub, params);
    if (subDef) chart.createIndicator(subDef, false, { id: SUB, height: subHeight, dragEnabled: false, gap: { top: 0.3, bottom: 0.05 } });

    render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, scale, intraday, main, sub, subHeight, paramsKey]);

  useEffect(render, [data, view?.bars, view?.end]);

  // 导播台：滚轮缩放、拖拽平移（分时不响应）
  useEffect(() => {
    if (!terminal) return;
    const el = elRef.current;
    const locked = () => latest.current.data.period === 'T';

    const onWheel = (e) => {
      e.preventDefault();
      if (locked()) return;
      const { data, view, onViewChange, minBars } = latest.current;
      onViewChange?.(moveView(data.bars, view, { zoom: e.deltaY < 0 ? 0.85 : 1 / 0.85 }, minBars));
    };

    let drag = null;
    const onDown = (e) => {
      // 绘制中、或按在画线上（拖动端点）时不平移
      if (e.button !== 0 || locked() || drawState.current.pendingId || drawState.current.hover) return;
      const w = chartRef.current?.getSize(CANDLE, 'main')?.width ?? el.clientWidth;
      drag = { x: e.clientX, view: latest.current.view, space: (w - RIGHT_GAP) / latest.current.view.bars };
    };
    const onMove = (e) => {
      if (!drag) return;
      const shift = -Math.round((e.clientX - drag.x) / drag.space);
      const { data, onViewChange, minBars } = latest.current;
      onViewChange?.(moveView(data.bars, drag.view, { shift }, minBars));
    };
    const onUp = () => { drag = null; };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [terminal]);

  return <div ref={elRef} style={{ width: '100%', height: '100%' }} />;
}
