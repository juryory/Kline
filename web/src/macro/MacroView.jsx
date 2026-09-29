import { useMemo } from 'react';
import EChart from './EChart.jsx';
import { useMacro } from './useMacro.js';
import { buildMacro } from './charts.js';
import { findMacroView } from '../../../shared/macro.js';

/**
 * 一张宏观图：标题 + 指标卡 + 图表。
 * terminal = 导播台（tooltip、拖动缩放）；否则为直播画面，字号按 scale 放大（样式见 panel.css / control.css 的 .macro-*）
 * zoom / legend / hoverIndex：导播台的缩放、图例、悬停状态，直播画面据此同步；onZoom 等回调仅导播台传入
 */
export default function MacroView({ viewKey, terminal = false, scale = 1, zoom, legend, hoverIndex, onZoom, onLegend, onHover }) {
  const view = findMacroView(viewKey);
  const { data, error } = useMacro(view?.datasets ?? []);
  const built = useMemo(
    () => (data ? buildMacro(viewKey, data, { terminal, scale }) : null),
    [data, viewKey, terminal, scale],
  );

  const err = error || built?.error;
  if (err) return <div className="macro-empty">{err}</div>;
  if (!built) return <div className="macro-empty">加载中…</div>;

  return (
    <div className="macro-view">
      <div className="macro-title">
        <span className="macro-name">{built.title}</span>
        <span className="macro-asof">数据截至 {built.asOf}</span>
        {built.note && <span className="macro-note">{built.note}</span>}
      </div>
      <div className="macro-kpis">
        {built.kpis.map((k) => (
          <div className="macro-kpi" key={k.label}>
            <span className="k-label">{k.label}</span>
            <span className={`k-value ${k.trend && !k.delta ? k.trend : ''}`}>{k.value}</span>
            {k.delta && <span className={`k-delta ${k.trend ?? ''}`}>{k.delta}</span>}
          </div>
        ))}
      </div>
      <div className="macro-chart">
        <EChart
          option={built.option} zoom={zoom} defaultZoom={built.defaultZoom} legend={legend} hoverIndex={hoverIndex}
          onZoom={onZoom} onLegend={onLegend} onHover={onHover}
        />
      </div>
    </div>
  );
}
