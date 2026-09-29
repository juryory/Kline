import MacroView from './macro/MacroView.jsx';
import { renderScale } from '../../shared/settings.js';
import './panel.css';

/**
 * 直播画面：宏观数据图。图表、缩放范围、图例开关跟随导播台（state.macro），
 * 导播台鼠标悬停的数据点（hover）在这里显示同样的提示框。
 */
export default function MacroPanel({ state, hover }) {
  const scale = renderScale(state.settings.render);
  const { view, zoom, legend } = state.macro;
  const hoverIndex = hover?.scope === 'macro' && hover.view === view ? hover.index : null;
  return (
    <div className="panel macro" style={{ '--s': scale }}>
      <MacroView viewKey={view} scale={scale} zoom={zoom} legend={legend} hoverIndex={hoverIndex} />
      <div className="foot">
        <b>围炉财经 · 投资的日常</b>
      </div>
    </div>
  );
}
