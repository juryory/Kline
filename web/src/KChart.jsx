import { useEffect, useRef, useState } from 'react';
import { init, dispose } from 'klinecharts';
import { endIndexOf, moveView, priceDigits, INTRADAY_POINTS } from './view.js';
import { COLORS as C, timelineCreate, indicatorCreate } from './indicators.js';
import { drawStyles, timeToIndex, indexToTime, timeToIndexF, indexToTimeF, dragDrawable, BRUSH, BRUSH_MAX_POINTS } from './drawTools.js';

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
        const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        if (p === 'T') return hm;
        if (p?.startsWith('m')) return type === 2 ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`; // 分钟 K
        if (p === 'Y') return `${d.getFullYear()}`;
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
 * 画线：drawings = 当前标的的画线 [{ id, name, points: [{ t, v }], text?, pane?, sub? }]
 *   直播画面只显示（锁定不可编辑）；导播台可拖动端点修改（onDrawChange）、选中（onDrawSelect），
 *   drawTool = { name, text? } 时进入绘制模式，画完回调 onDrawEnd。主图、副图上都能画，
 *   副图上的线（pane = 'sub'）只在副图是画线时那个指标（sub）时显示
 * onBarDoubleClick(bar)：导播台双击（触屏双击）某根 K 线
 */
export default function KChart({
  data, view, main, sub, params, terminal = false, subHeight = 50, scale = 1, minBars, onViewChange,
  drawings, drawTool, onDrawEnd, onDrawChange, onDrawSelect, onDrawDelete, showDelete = false, lineWidth = 1.5, readOnly = false,
  onBarDoubleClick,
}) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const periodRef = useRef(data.period);
  periodRef.current = data.period;
  const intraday = data.period === 'T';

  // 事件处理和 ResizeObserver 里要读最新的 props
  const latest = useRef();
  latest.current = { data, view, sub, onViewChange, minBars, onDrawEnd, onDrawChange, onDrawSelect, onDrawDelete, showDelete, lineWidth, onBarDoubleClick };
  const styles = () => drawStyles(scale, latest.current.lineWidth);
  // 画线交互状态：鼠标在画线上 / 正在绘制时，不触发拖拽平移
  // hover：鼠标在画线上；editing：正在拖动画线端点（触屏没有 hover，靠它避免同时平移）；dragDraw：触屏拖动画线中
  const drawState = useRef({ hover: false, editing: false, pendingId: null, dragDraw: null, selected: null, shown: new Set() });
  // 选中画线时的删除按钮位置（触屏用，没有 Delete 键），相对图表左上角；null = 不显示
  const [delPos, setDelPos] = useState(null);

  /** 主图 / 副图的绘图区（相对图表左上角）：top、height 来自整个窗格，width 不含 y 轴；没有这个窗格返回 null */
  const paneBox = (paneId) => {
    const chart = chartRef.current;
    const root = chart?.getSize(paneId);
    const main = chart?.getSize(paneId, 'main');
    return root && main ? { top: root.top, height: root.height, width: main.width } : null;
  };

  /** 删除按钮放在选中画线最右侧可见端点的右上方；拖动中、端点都不在所在窗格内时隐藏 */
  const updateDelPos = () => {
    const chart = chartRef.current;
    const st = drawState.current;
    const o = st.selected && chart?.getOverlayById(st.selected);
    const box = o && paneBox(o.paneId ?? CANDLE);
    if (!latest.current.showDelete || !o?.points?.length || st.editing || !box) return setDelPos(null);
    const inside = (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)
      && p.x >= 0 && p.x <= box.width && p.y >= box.top && p.y <= box.top + box.height;
    const px = [chart.convertToPixel(o.points, { paneId: o.paneId ?? CANDLE, absolute: true })].flat().filter(inside);
    if (!px.length) return setDelPos(null);
    const p = px.reduce((a, b) => (b.x > a.x ? b : a));
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    setDelPos({ id: o.id, x: clamp(p.x + 18, 18, box.width - 18), y: clamp(p.y - 24, box.top + 18, box.top + box.height - 18) });
  };

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
    chart.setPriceVolumePrecision(priceDigits(data.symbol), 0);
    chart.applyNewData(data.bars.slice(0, endIdx + 1));

    const w = chart.getSize(CANDLE, 'main')?.width;
    if (!w) return;
    const space = Math.max(1, Math.min(MAX_BAR_SPACE, (w - RIGHT_GAP) / count));
    chart.setBarSpace(space);
    // 分时盘中没走完时，右侧留出剩余时间的位置
    chart.setOffsetRightDistance(RIGHT_GAP + (isT ? (count - n) * space : 0));
    updateDelPos(); // 平移 / 缩放后删除按钮跟着画线走
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
    drawState.current = { hover: false, editing: false, pendingId: null, dragDraw: null, selected: null, shown: new Set() };
    setDelPos(null);

    const ro = new ResizeObserver(() => { chart.resize(); render(); });
    ro.observe(el);
    return () => {
      ro.disconnect();
      dispose(el);
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, scale]);

  // 图形类型与指标：分时 = 面积图 + 均价线 / 昨收线（纵轴以昨收对称），K 线 = 蜡烛 + 导播选的主图指标（参数来自设置）
  const paramsKey = JSON.stringify(params ?? null);
  const prevClose = intraday ? data.prevClose ?? null : null;
  useEffect(() => {
    const chart = chartRef.current;
    chart.setStyles({ candle: { type: intraday ? 'area' : 'candle_solid' } });

    chart.removeIndicator(CANDLE);
    const mainDef = intraday ? timelineCreate(prevClose) : indicatorCreate(main, params);
    if (mainDef) chart.createIndicator(mainDef, true, { id: CANDLE });

    chart.removeIndicator(SUB);
    const subDef = indicatorCreate(sub, params);
    if (subDef) chart.createIndicator(subDef, false, { id: SUB, height: subHeight, dragEnabled: false, gap: { top: 0.3, bottom: 0.05 } });

    render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, scale, intraday, prevClose, main, sub, subHeight, paramsKey]);
  // 注意：要放在画线同步前面。换副图指标时先重建副图窗格，副图上的画线才能放进去


  // ---------------- 画线 ----------------
  // overlay 端点用「完整数据里的下标」定位（当前只喂到视图最右一根，下标与完整数据一致）
  const overlayCallbacks = () => (terminal ? {
    onMouseEnter: () => { drawState.current.hover = true; return false; },
    onMouseLeave: () => { drawState.current.hover = false; return false; },
    onSelected: (e) => {
      drawState.current.selected = e.overlay.id;
      updateDelPos();
      latest.current.onDrawSelect?.(e.overlay.id);
      return false;
    },
    onDeselected: (e) => {
      if (drawState.current.selected === e.overlay.id) drawState.current.selected = null;
      updateDelPos();
      latest.current.onDrawSelect?.(null);
      return false;
    },
    onPressedMoveStart: () => { drawState.current.editing = true; updateDelPos(); return false; },
    onPressedMoveEnd: (e) => {
      drawState.current.editing = false;
      updateDelPos();
      latest.current.onDrawChange?.(toDrawing(e.overlay));
      return false;
    },
  } : {});
  const toDrawing = (o) => {
    const bars = latest.current.data.bars;
    return {
      id: o.id, name: o.name,
      points: o.name === BRUSH
        ? o.points.map((p) => ({ t: indexToTimeF(bars, p.dataIndex), v: +p.value.toFixed(3) }))
        : o.points.map((p) => ({ t: indexToTime(bars, p.dataIndex), v: p.value })),
      ...(o.extendData ? { text: o.extendData } : {}),
      ...(o.paneId === SUB && latest.current.sub ? { pane: 'sub', sub: latest.current.sub } : {}),
    };
  };

  // 服务端画线 → 图上 overlay：新增的创建、已有的更新端点、删掉的移除
  const drawingsKey = JSON.stringify(drawings ?? []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const st = drawState.current;
    const bars = data.bars;
    // 副图上的线：副图换了指标（或关掉）就不显示
    const want = (drawings ?? []).filter((d) => d.pane !== 'sub' || (d.sub === sub && chart.getSize(SUB)));
    const wantIds = new Set(want.map((d) => d.id));
    for (const id of st.shown) {
      if (!wantIds.has(id) && id !== st.pendingId) { chart.removeOverlay(id); st.shown.delete(id); }
    }
    for (const d of want) {
      const toIndex = d.name === BRUSH ? timeToIndexF : timeToIndex;
      const points = d.points.map((p) => ({ dataIndex: toIndex(bars, p.t), value: p.v }));
      if (st.shown.has(d.id) && chart.getOverlayById(d.id)) {
        chart.overrideOverlay({ id: d.id, points, extendData: d.text });
      } else {
        chart.createOverlay({
          id: d.id, groupId: 'drawings', name: d.name, points, extendData: d.text,
          lock: !terminal || readOnly, styles: styles(), ...overlayCallbacks(),
        }, d.pane === 'sub' ? SUB : CANDLE);
        st.shown.add(d.id);
      }
    }
    if (st.selected && !wantIds.has(st.selected)) st.selected = null; // 被删掉了（含其他导播机删除）
    updateDelPos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingsKey, data.symbol.code, data.period, data.bars.length, terminal, scale, sub, intraday]);

  // 只读切换（本地浏览）：已画的线锁定 / 解锁
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !terminal) return;
    for (const id of drawState.current.shown) chart.overrideOverlay({ id, lock: readOnly });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // 设置里改了画线粗细：已画的线全部换新样式
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const id of drawState.current.shown) chart.overrideOverlay({ id, styles: styles() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineWidth]);

  // 导播台：进入绘制模式
  useEffect(() => {
    const chart = chartRef.current;
    const st = drawState.current;
    if (!terminal || !chart || !drawTool) return;
    const id = `d${Date.now().toString(36)}`;
    st.pendingId = id;
    // 画笔、触屏 + 两点工具：不走 KLineChart 的点击绘制，由下面的手势处理按住拖动
    if (dragDrawable(drawTool.name)) {
      st.dragDraw = { id, name: drawTool.name, text: drawTool.text, start: null };
      return () => {
        // 画笔连续画多笔，每笔换新 id，所以按当前这笔清理
        const dd = st.dragDraw;
        if (dd && st.pendingId === dd.id && !st.shown.has(dd.id)) chart.removeOverlay(dd.id);
        st.pendingId = null;
        st.dragDraw = null;
      };
    }
    chart.createOverlay({
      id, groupId: 'drawings', name: drawTool.name, extendData: drawTool.text,
      styles: styles(), ...overlayCallbacks(),
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

  useEffect(render, [data, view?.bars, view?.end]);

  // 导播台：滚轮 / 双指缩放，鼠标 / 单指拖拽平移（分时不响应）
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

    // pointer 事件同时覆盖鼠标和触屏；pointers = 当前按下的手指（鼠标只有一个）
    const pointers = new Map();
    let drag = null;   // 单指 / 鼠标平移
    let pinch = null;  // 双指缩放
    const dist = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    const startDrag = (x) => {
      const w = chartRef.current?.getSize(CANDLE, 'main')?.width ?? el.clientWidth;
      drag = { x, view: latest.current.view, space: (w - RIGHT_GAP) / latest.current.view.bars };
    };

    const local = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const inBox = ({ x, y }, box) => !!box && x >= 0 && x <= box.width && y >= box.top && y <= box.top + box.height;
    /** 按下的位置在主图还是副图（副图要已显示） */
    const paneAt = (e) => [CANDLE, SUB].find((id) => inBox(local(e), paneBox(id))) ?? null;

    // 拖动画线：手指 / 鼠标位置 → 所在窗格（主图或副图）上的 { dataIndex, value }，出了这个窗格不算。
    // 画笔要小数下标（点落在两根 K 线之间），其他工具吸附到整根
    const toPoint = (e, fractional = false, paneId = CANDLE) => {
      const chart = chartRef.current;
      const { x, y } = local(e);
      if (!inBox({ x, y }, paneBox(paneId))) return null;
      const p = chart.convertFromPixel([{ x, y }], { paneId, absolute: true })[0];
      if (!Number.isFinite(p?.dataIndex) || !Number.isFinite(p?.value)) return null;
      if (!fractional) return { dataIndex: p.dataIndex, value: p.value };
      const cx = chart.convertToPixel([{ dataIndex: p.dataIndex, value: p.value }], { paneId, absolute: true })[0]?.x;
      const off = Number.isFinite(cx) ? (x - cx) / chart.getBarSpace() : 0;
      return { dataIndex: p.dataIndex + off, value: p.value };
    };
    const thin = (pts) => pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1); // 点太多时隔一个去一个
    const drawDown = (e) => {
      const dd = drawState.current.dragDraw;
      const pane = paneAt(e);
      const p = pane && toPoint(e, dd.name === BRUSH, pane);
      if (!p || pointers.size) return;
      dd.pane = pane;
      dd.start = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      dd.last = { x: e.clientX, y: e.clientY };
      // 拖动中先锁住，避免 KLineChart 把这次按下当成拖动端点
      chartRef.current.createOverlay({
        id: dd.id, groupId: 'drawings', name: dd.name, extendData: dd.text, points: [p, p], lock: true,
        styles: styles(), ...overlayCallbacks(),
      }, pane);
    };
    const drawMove = (e) => {
      const dd = drawState.current.dragDraw;
      const chart = chartRef.current;
      const points = chart?.getOverlayById(dd.id)?.points;
      if (!points) return;
      if (dd.name === BRUSH) {
        // 移动超过 3px 才记一个点；超过上限时抽稀，整条线形状不变
        if (Math.hypot(e.clientX - dd.last.x, e.clientY - dd.last.y) < 3) return;
        const p = toPoint(e, true, dd.pane);
        if (!p) return;
        dd.last = { x: e.clientX, y: e.clientY };
        let next = [...points.map(({ dataIndex, value }) => ({ dataIndex, value })), p];
        if (next.length > BRUSH_MAX_POINTS) next = thin(next);
        chart.overrideOverlay({ id: dd.id, points: next });
        return;
      }
      const p = toPoint(e, false, dd.pane);
      if (p) chart.overrideOverlay({ id: dd.id, points: [points[0], p] });
    };
    const drawUp = (e) => {
      const st = drawState.current;
      const dd = st.dragDraw;
      const chart = chartRef.current;
      const moved = Math.hypot(e.clientX - dd.start.x, e.clientY - dd.start.y);
      dd.start = null;
      const brush = dd.name === BRUSH;
      // 只是点了一下：不算，继续等待拖动
      if (moved < (brush ? 4 : 12)) { chart.removeOverlay(dd.id); return; }
      chart.overrideOverlay({ id: dd.id, lock: false });
      st.shown.add(dd.id);
      const drawing = toDrawing(chart.getOverlayById(dd.id));
      if (brush) {
        // 画笔保持选中，可以接着画下一笔
        const id = `d${Date.now().toString(36)}`;
        st.pendingId = id;
        st.dragDraw = { ...dd, id, start: null };
      } else {
        st.pendingId = null;
        st.dragDraw = null;
      }
      latest.current.onDrawEnd?.(drawing);
    };

    // 双击（鼠标、触屏一样）：两次没有移动的短按，间隔 350ms 内、位置相近
    let tap = null, lastTap = null;
    const onTap = (e) => {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 20) {
        lastTap = null;
        const { data, onBarDoubleClick } = latest.current;
        const i = Math.round(chartRef.current?.convertFromPixel([{ x: local(e).x }], { paneId: CANDLE })[0]?.dataIndex);
        if (onBarDoubleClick && data.bars[i]) onBarDoubleClick(data.bars[i]);
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
    };

    const onDown = (e) => {
      if (drawState.current.dragDraw) { if (e.button === 0) drawDown(e); return; }
      // 绘制中、或按在画线上（拖动端点）时不平移
      if (e.button !== 0 || locked() || drawState.current.pendingId || drawState.current.hover) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      tap = pointers.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
      if (pointers.size === 1) startDrag(e.clientX);
      else if (pointers.size === 2) {
        drag = null;
        pinch = { d: dist(), view: latest.current.view };
      }
    };
    const onMove = (e) => {
      if (drawState.current.dragDraw?.start?.pointerId === e.pointerId) return drawMove(e);
      if (!pointers.has(e.pointerId)) return;
      if (drawState.current.editing) { drag = null; pinch = null; return; } // 手指在拖画线端点，不平移
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const { data, onViewChange, minBars } = latest.current;
      if (pinch && pointers.size === 2) {
        const d = dist();
        if (d > 10) onViewChange?.(moveView(data.bars, pinch.view, { zoom: pinch.d / d }, minBars)); // 张开 = 放大 = 根数变少
      } else if (drag) {
        const shift = -Math.round((e.clientX - drag.x) / drag.space);
        onViewChange?.(moveView(data.bars, drag.view, { shift }, minBars));
      }
    };
    const onUp = (e) => {
      if (drawState.current.dragDraw?.start?.pointerId === e.pointerId) return drawUp(e);
      if (!pointers.delete(e.pointerId)) return;
      if (tap?.id === e.pointerId && performance.now() - tap.t < 300
        && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 6) onTap(e);
      tap = null;
      pinch = null;
      // 双指松开一根后，剩下那根手指接着平移，避免画面跳动
      if (pointers.size === 1) startDrag([...pointers.values()][0].x);
      else drag = null;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [terminal]);

  // 删除按钮放在图表容器外层，点击不会被当成图上的触摸（不触发平移 / 取消选中）
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={elRef} style={{ width: '100%', height: '100%' }} />
      {delPos && (
        <button
          className="draw-del" title="删除这条画线"
          style={{ left: delPos.x, top: delPos.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => { latest.current.onDrawDelete?.(delPos.id); setDelPos(null); }}
        >×</button>
      )}
    </div>
  );
}
