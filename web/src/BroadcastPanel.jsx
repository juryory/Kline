import KChart from './KChart.jsx';
import { periodsFor, quoteOf } from './view.js';
import { renderScale, isSymbolMasked, maskName } from '../../shared/settings.js';
import './panel.css';

/**
 * 直播画面，尺寸来自导播台设置（默认 966×320）。
 * 页头显示当日最新价和涨跌；K 线区间、周期、指标全部跟随导播台，指标数值显示在图内左上角。
 * 画面比 966×320 大时，字号、间距、线宽按比例放大（--s）。
 */
export default function BroadcastPanel({ data, state, status }) {
  const q = quoteOf(data);
  const scale = renderScale(state.settings.render);
  // 直播合规：个股名称打码、代码不显示；真实名称和代码不进 DOM（不只是视觉隐藏）
  const masked = isSymbolMasked(state, data.symbol);

  return (
    <div className="panel" style={{ '--s': scale }}>
      <div className="head">
        <div className="title">
          <span className="name">{masked ? maskName(data.symbol.name) : data.symbol.name}</span>
          {!masked && <span className="code">{data.symbol.code}</span>}
          <span className={`price ${q.trend}`}>{q.close}</span>
          <span className={`pct ${q.trend}`}>{q.pct}</span>
        </div>
        <div className="periods">
          {periodsFor(status).map((p) => (
            <span key={p.key} className={p.key === data.period ? 'active' : ''}>{p.label}</span>
          ))}
        </div>
      </div>

      <div className="chart">
        <KChart
          data={data} view={state.view} main={state.main} sub={state.sub}
          params={state.settings.indicators} scale={scale} subHeight={Math.round(60 * scale)}
          drawings={state.drawings?.[data.symbol.code]} lineWidth={state.settings.drawLine}
        />
      </div>

      <div className="foot">
        <b>围炉财经 · 投资的日常</b>
      </div>
    </div>
  );
}
