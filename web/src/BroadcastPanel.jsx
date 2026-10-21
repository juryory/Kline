import KChart from './KChart.jsx';
import { periodsFor, quoteOf, PRIMARY_PERIODS } from './view.js';
import { contentSize, renderScale, isSymbolMasked, maskName } from '../../shared/settings.js';
import './panel.css';

export const BRAND = '围炉财经 · 数据中台';
/** 页头 logo：导播台上传过就用上传的（版本号变了浏览器才重新下载），否则用默认图片 */
export const logoSrc = (version) => (version ? `/brand-logo?v=${version}` : '/logo.png');

/**
 * 直播画面，尺寸来自导播台设置（默认 966×320）。
 * 页头：品牌 logo + 标的 + 当日最新价和涨跌，右侧品牌名 + 周期；K 线区间、周期、指标全部跟随导播台，指标数值显示在图内左上角。
 * 画面比 966×320 大时，字号、间距、线宽按比例放大（--s）。
 */
export default function BroadcastPanel({ data, state, status }) {
  const q = quoteOf(data);
  const scale = renderScale(contentSize(state.settings)); // 两侧安全区外不放内容
  // 直播合规：个股名称打码、代码不显示；真实名称和代码不进 DOM（不只是视觉隐藏）
  const masked = isSymbolMasked(state, data.symbol);

  return (
    <div className="panel" style={{ '--s': scale }}>
      <div className="head">
        <div className="title">
          {state.settings.logo.height > 0 && <img className="logo" src={logoSrc(state.logoVersion)} alt="" />}
          <span className="name">{masked ? maskName(data.symbol.name) : data.symbol.name}</span>
          {!masked && <span className="code">{data.symbol.code}</span>}
          <span className={`price ${q.trend}`}>{q.close}</span>
          <span className={`pct ${q.trend}`}>{q.pct}</span>
          {/* 历史某天的分时：标出日期，价格和涨跌是那天的 */}
          {data.date && <span className="day">{data.date}</span>}
        </div>
        <div className="head-right">
          <span className="brand">{BRAND}</span>
          <div className="periods">
            {/* 周期太多放不下：只显示常用的几个 + 当前周期 */}
            {periodsFor(status, data.symbol).filter((p) => PRIMARY_PERIODS.includes(p.key) || p.key === data.period).map((p) => (
              <span key={p.key} className={p.key === data.period ? 'active' : ''}>{p.label}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="chart">
        <KChart
          data={data} view={state.view} main={state.main} sub={state.sub}
          params={state.settings.indicators} scale={scale} subHeight={Math.round(state.settings.subPane.render * scale)}
          drawings={state.drawings?.[data.symbol.code]} lineWidth={state.settings.drawLine}
        />
      </div>

      <div className="foot">
        <b>{BRAND}</b>
      </div>
    </div>
  );
}
