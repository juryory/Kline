import { useEffect, useMemo, useRef } from 'react';
import MacroView from './macro/MacroView.jsx';
import { MACRO_GROUPS, MACRO_VIEWS } from '../../shared/macro.js';

/** 节流：间隔内只发最后一次（拖动缩放、鼠标移动时避免刷屏） */
function throttle(fn, ms) {
  let timer = null, lastArgs = null, lastAt = 0;
  return (...args) => {
    lastArgs = args;
    const wait = lastAt + ms - Date.now();
    if (wait <= 0) { lastAt = Date.now(); fn(...args); return; }
    clearTimeout(timer);
    timer = setTimeout(() => { lastAt = Date.now(); fn(...lastArgs); }, wait);
  };
}

/**
 * 导播台「宏观数据」页：二级导航（分组 + 图表）+ 大图。
 * 选中的图表、缩放范围、图例开关存在服务端（state.macro），悬停位置实时转发，直播画面全部同步。
 * ←/→ 切换上一张 / 下一张。
 */
export default function MacroPage({ macro, setMacro, sendHover, active }) {
  const { view } = macro;
  const latest = useRef();
  latest.current = { view, setMacro };

  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const { view, setMacro } = latest.current;
      const i = MACRO_VIEWS.findIndex((v) => v.key === view);
      const n = MACRO_VIEWS.length;
      setMacro({ view: MACRO_VIEWS[(i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n].key });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const onZoom = useMemo(() => throttle((z) => latest.current.setMacro({ zoom: z }), 80), []);
  const onHover = useMemo(() => throttle((index) => sendHover(latest.current.view, index), 40), [sendHover]);
  const onLegend = (selected) => setMacro({ legend: selected });

  // 切换图表时清掉直播画面上的提示框
  useEffect(() => () => sendHover(view, null), [view, sendHover]);

  return (
    <div className="macro-page">
      <nav className="macro-nav">
        {MACRO_GROUPS.map((g) => (
          <div className="macro-group" key={g.key}>
            <span className="g-label">{g.label}</span>
            {MACRO_VIEWS.filter((v) => v.group === g.key).map((v) => (
              <button key={v.key} className={v.key === view ? 'active' : ''} onClick={() => setMacro({ view: v.key })}>{v.label}</button>
            ))}
          </div>
        ))}
        <span className="macro-hint">← / → 切换图表 · 缩放、图例、鼠标悬停都会同步到直播画面</span>
      </nav>
      <div className="macro-main">
        <MacroView
          viewKey={view} terminal
          zoom={macro.zoom} legend={macro.legend}
          onZoom={onZoom} onLegend={onLegend} onHover={onHover}
        />
      </div>
    </div>
  );
}
