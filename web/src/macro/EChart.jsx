import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// 按需引入，只打包用到的图表类型和组件
echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, DataZoomComponent, CanvasRenderer]);

const near = (a, b) => Math.abs(a - b) < 0.05;

/**
 * ECharts 容器。
 * 受控状态（导播台 → 直播画面同步）：
 *   zoom       { start, end } 百分比，null = 默认窗口（defaultZoom，最近一段）
 *   legend     { 系列名: 是否显示 }，null = 全部显示
 *   hoverIndex 横轴数据下标，null = 不显示提示框
 * 导播台传 onZoom / onLegend / onHover 回调，用户操作时上报；外部下发的值不会再触发回调（避免回环）
 */
export default function EChart({ option, zoom, defaultZoom, legend, hoverIndex, onZoom, onLegend, onHover }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const cb = useRef();
  cb.current = { onZoom, onLegend, onHover };
  const applied = useRef({ zoom: { start: 0, end: 100 }, hover: null });

  useEffect(() => {
    const chart = echarts.init(elRef.current, null, { renderer: 'canvas' });
    chartRef.current = chart;
    elRef.current.__echarts = chart; // 便于在浏览器控制台 / 自动化测试里检查图表状态

    chart.on('datazoom', () => {
      const dz = chart.getOption().dataZoom?.[0];
      if (!dz || !cb.current.onZoom) return;
      const z = { start: +dz.start.toFixed(2), end: +dz.end.toFixed(2) };
      const a = applied.current.zoom;
      if (near(z.start, a.start) && near(z.end, a.end)) return; // 外部下发引起的，不回传
      applied.current.zoom = z;
      cb.current.onZoom(z);
    });
    // 点击图例触发 legendselectchanged；代码调用 legendSelect / legendUnSelect 触发另外两个，一并上报
    for (const ev of ['legendselectchanged', 'legendselected', 'legendunselected']) {
      chart.on(ev, (e) => cb.current.onLegend?.(e.selected));
    }
    chart.on('updateAxisPointer', (e) => {
      if (!cb.current.onHover) return;
      const idx = e.axesInfo?.[0]?.value;
      const next = Number.isInteger(idx) ? idx : null;
      if (next !== applied.current.hover) { applied.current.hover = next; cb.current.onHover(next); }
    });
    chart.getZr().on('globalout', () => {
      if (cb.current.onHover && applied.current.hover !== null) { applied.current.hover = null; cb.current.onHover(null); }
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(elRef.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // ---- 把受控状态应用到图上 ----
  const applyZoom = () => {
    const chart = chartRef.current;
    if (!chart?.getOption()?.dataZoom?.length) return;
    const t = zoom ?? defaultZoom ?? { start: 0, end: 100 };
    applied.current.zoom = t; // 记下当前生效的范围：用户操作与它不同才上报
    const dz = chart.getOption().dataZoom[0];
    if (near(dz.start, t.start) && near(dz.end, t.end)) return;
    chart.dispatchAction({ type: 'dataZoom', start: t.start, end: t.end });
  };
  const applyLegend = () => {
    const chart = chartRef.current;
    const names = (chart?.getOption()?.series ?? []).map((s) => s.name).filter(Boolean);
    if (!names.length) return;
    chart.setOption({ legend: { selected: Object.fromEntries(names.map((n) => [n, legend?.[n] ?? true])) } });
  };
  const applyHover = () => {
    const chart = chartRef.current;
    if (!chart || onHover) return; // 导播台自己有鼠标，不需要外部驱动
    if (hoverIndex == null) chart.dispatchAction({ type: 'hideTip' });
    else chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: hoverIndex });
  };

  useEffect(() => {
    if (!option || !chartRef.current) return;
    chartRef.current.setOption(option, true);
    // 整体替换 option 后，受控状态要重新应用
    applyZoom();
    applyLegend();
    applyHover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(applyZoom, [zoom?.start, zoom?.end, defaultZoom?.start]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(applyLegend, [JSON.stringify(legend ?? null)]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(applyHover, [hoverIndex]);

  return <div ref={elRef} style={{ width: '100%', height: '100%' }} />;
}
