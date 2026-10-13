import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLive } from './useLive.js';
import { renderUrl } from './auth.js';
import KChart from './KChart.jsx';
import SymbolSearch from './SymbolSearch.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import RankBrowser from './RankBrowser.jsx';
import MacroPage from './MacroPage.jsx';
import { endIndexOf, minBarsFor, moveView, periodsFor, quoteOf, stepPeriod } from './view.js';
import { MAIN, SUB } from './indicators.js';
import { DRAW_TOOLS, dragDrawable } from './drawTools.js';
import { isSymbolMasked, maskName } from '../../shared/settings.js';
import './control.css';

// 底部预览框的最大尺寸，直播画面按比例缩小放进去
const PREVIEW_MAX = { width: 980, height: 360 };

/**
 * 顶部导航的页面。当前页即直播画面内容（服务端 state.scene，允许值见 server/index.js 的 SCENES）。
 * 以后加新页面（如宏观数据）：这里加一项，服务端 SCENES 加 key，RenderPage / 导播台各加一个对应组件。
 * requires：需要数据源支持的功能（status 里的开关），不支持时置灰
 */
const PAGES = [
  { key: 'kline', label: 'K 线图' },
  { key: 'rank', label: '板块排名', requires: 'rank', hint: '板块排名需要本地数据源（DATA_SOURCE=local）' },
  { key: 'macro', label: '宏观数据', requires: 'macro', hint: '宏观数据需要本地数据源（DATA_SOURCE=local）' },
];

const DEFAULT_VIEW = { bars: 60, end: null };
const ECHO_GUARD_MS = 1000; // 本机刚操作过，忽略服务端回传的旧视图，避免按住方向键时回跳

/**
 * 本地浏览：这些状态只改本机，不发给服务端，直播画面保持不变。
 * 画线存在服务端（直播画面显示同一标的时会上屏），本地浏览时不允许改。
 */
const LOCAL_KEYS = ['symbol', 'period', 'view', 'main', 'sub', 'scene', 'rank', 'macro'];
const BLOCKED_IN_LOCAL = ['drawPut', 'drawRemove', 'drawClear'];

/** 本地浏览时合并一次修改，规则与服务端 applyPatch 一致（换标的/周期回到最新，换宏观图重置缩放和图例） */
function applyLocal(cur, p) {
  const next = { ...cur };
  for (const k of ['symbol', 'period', 'main', 'sub', 'scene', 'view']) if (p[k] !== undefined) next[k] = p[k];
  if (p.rank) next.rank = { ...cur.rank, ...p.rank };
  if (p.macro) {
    next.macro = p.macro.view && p.macro.view !== cur.macro.view
      ? { view: p.macro.view, zoom: null, legend: null }
      : { ...cur.macro, ...p.macro };
  }
  if (next.symbol !== cur.symbol || next.period !== cur.period) next.view = { ...next.view, end: null };
  return next;
}

// 方向键 → 视图操作
const VIEW_KEYS = {
  ArrowUp: () => ({ zoom: 0.8 }),     // 放大：显示更少的 K 线
  ArrowDown: () => ({ zoom: 1.25 }),  // 缩小：显示更多的 K 线
  ArrowLeft: (e) => ({ shift: e.shiftKey ? -10 : -1 }),
  ArrowRight: (e) => ({ shift: e.shiftKey ? 10 : 1 }),
  Home: () => ({ toEarliest: true }),
  End: () => ({ toLatest: true }),
};
// 周期切换：回车 → 更细（月→周→日→分时），Backspace → 更粗
const PERIOD_KEYS = { Enter: -1, Backspace: 1 };
// 自选切换：当前标的在自选里时，PageUp 上一个、PageDown 下一个（首尾循环）
const WATCH_KEYS = { PageUp: -1, PageDown: 1 };

/** 自选里的上一个/下一个；当前标的不在自选里时返回 null */
function stepWatch(watchlist, code, dir) {
  const i = watchlist.findIndex((x) => x.code === code);
  if (i < 0 || watchlist.length < 2) return null;
  return watchlist[(i + dir + watchlist.length) % watchlist.length].code;
}

const pad = (n) => String(n).padStart(2, '0');
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const fmtDay = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function Seg({ items, value, onPick, disabled, allowNone }) {
  return (
    <div className="seg">
      {items.map((x) => (
        <button key={x.key} disabled={disabled} className={value === x.key ? 'active' : ''} onClick={() => onPick(x.key)}>
          {x.label}
        </button>
      ))}
      {allowNone && (
        <button disabled={disabled} className={value == null ? 'active' : ''} onClick={() => onPick(null)}>无</button>
      )}
    </div>
  );
}

// 触屏为主的设备（iPad）：不显示底部的直播预览和快捷键说明，K 线区域占满剩余高度
const TOUCH_QUERY = '(pointer: coarse)';
function useTouchDevice() {
  const [touch, setTouch] = useState(() => matchMedia(TOUCH_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(TOUCH_QUERY);
    const onChange = () => setTouch(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return touch;
}

export default function ControlPage() {
  const { state: liveState, data: liveData, status, connected, send, auth, authError } = useLive('control');
  // 本地浏览：local = 本机自己的标的/周期/视图/指标/页面等（null = 未开启），localData = 按需拉的 K 线
  const [local, setLocal] = useState(null);
  const [localData, setLocalData] = useState(null);
  const [localError, setLocalError] = useState(null);
  // 下面的界面统一用 state / data：本地浏览时是「服务端状态 + 本机覆盖」，否则就是服务端状态
  const state = useMemo(() => (local && liveState ? { ...liveState, ...local } : liveState), [liveState, local]);
  const data = local ? localData : liveData;
  const [view, setView] = useState(DEFAULT_VIEW);
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const touch = useTouchDevice();

  // 导播台固定一屏：整页不滚动、iPad 上不回弹（只在导播台生效，渲染页另有设置）
  useEffect(() => {
    const els = [document.documentElement, document.body];
    els.forEach((el) => { el.style.overflow = 'hidden'; el.style.overscrollBehavior = 'none'; });
    return () => els.forEach((el) => { el.style.overflow = ''; el.style.overscrollBehavior = ''; });
  }, []);
  const [drawTool, setDrawTool] = useState(null);       // 正在使用的画线工具 { name, text? }
  const [moreTools, setMoreTools] = useState(false);    // 工具栏「更多」是否展开
  const [selectedDraw, setSelectedDraw] = useState(null); // 选中的画线 id（Delete 删除）
  // 导播台当前页 = 直播画面内容（服务端 scene），切页即切直播画面；多台导播机保持一致
  const tab = state?.scene ?? 'kline';
  const inputRef = useRef(null);
  const lastEdit = useRef(0);

  // 事件处理里要读最新值
  const latest = useRef();
  const periods = periodsFor(status);
  const render = state?.settings.render ?? { width: 966, height: 320 };
  const minBars = minBarsFor(render.width);
  latest.current = { data, view, state, send, periods, minBars, settingsOpen, tab, drawTool, selectedDraw, local };

  // 本地浏览时：LOCAL_KEYS 只改本机，画线操作丢弃，其余（自选、设置、画面开关）照常发给服务端
  const set = (patch) => {
    if (!latest.current.local) return latest.current.send({ type: 'set', patch });
    const own = {}, rest = {};
    for (const [k, v] of Object.entries(patch)) {
      if (LOCAL_KEYS.includes(k)) own[k] = v;
      else if (!BLOCKED_IN_LOCAL.includes(k)) rest[k] = v;
    }
    if (Object.keys(own).length) setLocal((cur) => applyLocal(cur, own));
    if (Object.keys(rest).length) latest.current.send({ type: 'set', patch: rest });
  };
  const toggleLocal = () => {
    if (local) {
      setLocal(null);
      setLocalData(null);
      if (liveState) setView(liveState.view); // 回到直播画面当前的视图
      return;
    }
    if (!liveState) return;
    setLocal(Object.fromEntries(LOCAL_KEYS.map((k) => [k, k === 'view' ? view : liveState[k]])));
    setLocalData(liveData); // 先沿用当前数据，避免闪一下空白
    setDrawTool(null);
    setSelectedDraw(null);
  };

  // 本地浏览：标的 / 周期变化时拉 K 线；服务端刷新行情（updatedAt 变化）后也重拉
  const localKey = local ? `${local.symbol}|${local.period}` : null;
  useEffect(() => {
    if (!localKey) return;
    const [symbol, period] = localKey.split('|');
    let stale = false;
    fetch(`/api/kline?symbol=${encodeURIComponent(symbol)}&period=${period}`)
      .then((r) => r.json())
      .then((msg) => {
        if (stale) return;
        if (msg.error) setLocalError(msg.error);
        else { setLocalError(null); setLocalData(msg); }
      })
      .catch((err) => !stale && setLocalError(err.message));
    return () => { stale = true; };
  }, [localKey, status?.updatedAt]);
  const goPage = (key) => set({ scene: key });
  // 宏观图悬停位置：高频、不落盘，服务端原样转发给直播画面
  const sendHover = useCallback((view, index) => {
    if (!latest.current.local) send({ type: 'hover', scope: 'macro', view, index }); // 本地浏览时不同步悬停
  }, [send]);

  // 视图：本地先改（跟手），同时发给服务端广播到直播画面
  const applyView = (next) => {
    const cur = latest.current.view;
    if (next.bars === cur.bars && next.end === cur.end) return;
    lastEdit.current = Date.now();
    setView(next);
    set({ view: next });
  };

  // 服务端视图 → 本地：换标的/周期时一定同步；否则只在本机最近没操作时同步（多个导播台）
  const prevKey = useRef('');
  useEffect(() => {
    if (!state?.view) return;
    const key = `${state.symbol}|${state.period}`;
    if (key !== prevKey.current || Date.now() - lastEdit.current > ECHO_GUARD_MS) setView(state.view);
    prevKey.current = key;
  }, [state]);

  // 全局键盘：方向键控制视图，回车/Backspace 切周期，字母数字唤起检索
  useEffect(() => {
    const onKey = (e) => {
      const { data, view, state, periods, minBars, settingsOpen, tab, drawTool, selectedDraw } = latest.current;
      if (settingsOpen || e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      // 画线：Esc 取消绘制；选中画线时 Delete 删除该画线（否则 Delete 仍是移出自选）
      if (tab === 'kline' && e.key === 'Escape' && drawTool) { e.preventDefault(); setDrawTool(null); return; }
      if (tab === 'kline' && e.key === 'Delete' && selectedDraw && data) {
        e.preventDefault();
        set({ drawRemove: { symbol: data.symbol.code, id: selectedDraw } });
        setSelectedDraw(null);
        return;
      }
      // 非 K 线页：方向键、回车、周期键、自选键交给该页自己处理，不操作看不见的 K 线
      if (tab !== 'kline' && (e.key in VIEW_KEYS || e.key in PERIOD_KEYS || e.key in WATCH_KEYS)) return;

      const move = VIEW_KEYS[e.key]?.(e);
      if (move) {
        e.preventDefault();
        if (data && data.period !== 'T') applyView(moveView(data.bars, view, move, minBars));
        return;
      }
      if (e.key in PERIOD_KEYS) {
        e.preventDefault(); // 也阻止回车触发当前聚焦的按钮
        if (state) {
          const next = stepPeriod(state.period, PERIOD_KEYS[e.key], periods);
          if (next !== state.period) set({ period: next });
        }
        return;
      }
      if (e.key in WATCH_KEYS) {
        e.preventDefault(); // 阻止页面滚动
        const next = state && stepWatch(state.watchlist, state.symbol, WATCH_KEYS[e.key]);
        if (next) set({ symbol: next });
        return;
      }
      if (e.key === 'Insert' && state) { e.preventDefault(); set({ watchAdd: state.symbol }); return; }
      if (e.key === 'Delete' && state) { e.preventDefault(); set({ watchRemove: state.symbol }); return; }
      if (/^[0-9a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        setQuery(e.key);
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = !!(connected && state);
  const q = data?.quote && quoteOf(data);
  const previewScale = Math.min(1, PREVIEW_MAX.width / render.width, PREVIEW_MAX.height / render.height);
  const loading = data && state && (data.symbol.code !== state.symbol || data.period !== state.period);
  const inWatch = !!state?.watchlist.some((x) => x.code === state.symbol);
  const masked = !local && data && isSymbolMasked(state, data.symbol);
  // 当前图上标的的画线（按图表数据的标的取，切换标的加载中时不串线）
  const drawings = (data && state?.drawings?.[data.symbol.code]) ?? [];

  // 切换标的 / 周期 / 页面时退出绘制、清掉选中
  useEffect(() => { setDrawTool(null); setSelectedDraw(null); }, [data?.symbol.code, data?.period, tab]);

  let range = null;
  if (data && data.period === 'T') {
    range = { text: `分时 · ${fmtDay(data.bars[0].timestamp)}`, latest: true };
  } else if (data) {
    const endIdx = endIndexOf(data.bars, view);
    const startIdx = Math.max(0, endIdx - view.bars + 1);
    range = {
      text: `${view.bars} 根 · ${fmtDay(data.bars[startIdx].timestamp)} ~ ${fmtDay(data.bars[endIdx].timestamp)}`,
      latest: view.end == null,
    };
  }

  // 正在用的工具在「更多」里时，收起会让它看不见，所以收起按钮在这种情况下不可用
  const moreActive = DRAW_TOOLS.some((t) => t.more && t.key === drawTool?.name);
  const moreButton = (
    <button
      key="more" className="more" title={moreTools ? '收起' : '更多画线工具'}
      disabled={moreTools && moreActive}
      onClick={() => setMoreTools((v) => !v)}
    >
      <span className="i">{moreTools ? '▴' : '▾'}</span>
      <span className="l">{moreTools ? '收起' : '更多'}</span>
    </button>
  );

  return (
    <div className="term">
      {/* ---- 顶部导航：页面切换（= 直播画面内容）+ 全局操作 ---- */}
      <header className="topnav">
        <nav className="pages">
          {PAGES.map((p) => {
            const unsupported = p.requires && status && !status[p.requires];
            return (
              <button
                key={p.key}
                className={tab === p.key ? 'active' : ''}
                disabled={!ready || unsupported}
                title={unsupported ? p.hint : '切换页面，直播画面同步切换'}
                onClick={() => goPage(p.key)}
              >
                {p.label}
              </button>
            );
          })}
        </nav>

        <SymbolSearch
          inputRef={inputRef} query={query} setQuery={setQuery}
          onSelect={(s) => set({ symbol: s.code, scene: 'kline' })}
        />

        <span className="spacer" />

        <button
          disabled={!ready}
          className={`onair ${state?.visible ? 'live' : ''}`}
          onClick={() => set({ visible: !state.visible })}
        >
          {state?.visible ? '● 画面显示中' : '画面已隐藏'}
        </button>

        <button
          disabled={!ready}
          className={`mask ${state?.hideSymbol ? 'on' : ''}`}
          title="开启后，直播画面上个股名称中间打码、不显示代码；指数和板块不受影响"
          onClick={() => set({ hideSymbol: !state.hideSymbol })}
        >
          {state?.hideSymbol ? '◉ 隐藏个股：开' : '隐藏个股：关'}
        </button>

        <button
          disabled={!ready}
          className={`localmode ${local ? 'on' : ''}`}
          title="开启后，切换标的、周期、缩放、指标、翻页都只在本机生效，直播画面保持不变"
          onClick={toggleLocal}
        >
          {local ? '◉ 本地浏览：开' : '本地浏览：关'}
        </button>

      </header>

      {settingsOpen && state && (
        <SettingsPanel
          settings={state.settings}
          canSync={status?.source === 'local' && auth?.role === 'admin'}
          onClose={() => setSettingsOpen(false)}
          onSave={(settings) => { set({ settings }); setSettingsOpen(false); }}
        />
      )}

      {authError && (
        <div className="error">
          {authError === 'origin'
            ? '连接被拒绝：当前页面的来源不在允许列表里（服务端 ALLOWED_ORIGINS）'
            : '未登录或登录已过期：请从围炉工作台重新打开导播台'}
        </div>
      )}
      {status?.error && <div className="error">行情拉取失败，画面保持上一份数据：{status.error}</div>}
      {local && (
        <div className="local-banner">
          本地浏览中：这里的操作只在本机生效，不会同步到直播画面
          {liveData && <>（直播画面仍是「{isSymbolMasked(liveState, liveData.symbol) ? maskName(liveData.symbol.name) : liveData.symbol.name}」）</>}
          ；本地浏览时不能画线
          {localError && <span className="err"> · 加载失败：{localError}</span>}
          <button onClick={toggleLocal}>退出本地浏览</button>
        </div>
      )}

      {/* ---- K 线页工具栏 ---- */}
      {tab === 'kline' && (
        <div className="toolbar">
          {data && q && (
            <div className="quote">
              <b>{data.symbol.name}</b>
              <span className="code">{data.symbol.code}</span>
              <span className={`price ${q.trend}`}>{q.close}</span>
              <span className={q.trend}>{q.pct}</span>
              {/* 行情本身的日期，不是读取时间：同步失败时导播能一眼看出数据没更新 */}
              <span className="asof">数据截至 {fmtDay(data.bars[data.bars.length - 1].timestamp)} {WEEKDAY[new Date(data.bars[data.bars.length - 1].timestamp).getDay()]}</span>
              {loading && <span className="loading">加载中…</span>}
              {masked && <span className="hidden-tag">直播画面显示为「{maskName(data.symbol.name)}」，不显示代码</span>}
            </div>
          )}
          {state && (
            <button
              disabled={!ready}
              className={`star ${inWatch ? 'on' : ''}`}
              title={inWatch ? '移出自选（Delete）' : '加入自选（Insert）'}
              onClick={() => set(inWatch ? { watchRemove: state.symbol } : { watchAdd: state.symbol })}
            >
              {inWatch ? '★ 已自选' : '☆ 加自选'}
            </button>
          )}
          <span className="spacer" />
          <Seg items={periods} value={state?.period} disabled={!ready} onPick={(k) => set({ period: k })} />
          <span className="label">主图</span>
          <Seg items={MAIN} value={state?.main} disabled={!ready || data?.period === 'T'} allowNone onPick={(k) => set({ main: k })} />
          <span className="label">副图</span>
          <Seg items={SUB} value={state?.sub} disabled={!ready} allowNone onPick={(k) => set({ sub: k })} />
          <button disabled={!ready} onClick={() => setSettingsOpen(true)}>⚙ 设置</button>
        </div>
      )}

      {/* ---- 板块排名页：操作实时反映到直播画面 ---- */}
      {tab === 'rank' && state && (
        <div className="body">
          <RankBrowser
            active={!settingsOpen}
            rank={state.rank}
            setRank={(patch) => set({ rank: { ...state.rank, ...patch } })}
            onOpen={(code) => set({ symbol: code, scene: 'kline' })}
          />
        </div>
      )}

      {/* ---- 宏观数据页：选中的图表同步到直播画面 ---- */}
      {tab === 'macro' && state && (
        <div className="body">
          <MacroPage
            active={!settingsOpen}
            macro={state.macro}
            setMacro={(patch) => {
              const cur = latest.current.state.macro;
              // 换图时只发 view：缩放、图例由服务端重置，不带到新图上
              set({ macro: patch.view && patch.view !== cur.view ? { view: patch.view } : { ...cur, ...patch } });
            }}
            sendHover={sendHover}
          />
        </div>
      )}

      <div className="body" style={tab === 'kline' ? undefined : { display: 'none' }}>
        {/* 画线工具栏：点工具后在图上依次点击端点；画好的线同步到直播画面。不常用的收在「更多」里 */}
        <aside className="draw-bar">
          {DRAW_TOOLS.filter((t) => !t.more || moreTools).map((t, i, list) => (
            <Fragment key={t.key}>
            {t.more && !list[i - 1]?.more && moreButton}
            <button
              key={t.key}
              className={drawTool?.name === t.key ? 'active' : ''}
              title={t.label}
              disabled={!data || data.period === 'T' || !!local}
              onClick={() => {
                if (drawTool?.name === t.key) { setDrawTool(null); return; }
                if (t.key === 'simpleAnnotation') {
                  const text = window.prompt('标注文字', '');
                  if (!text) return;
                  setDrawTool({ name: t.key, text: text.slice(0, 40) });
                } else setDrawTool({ name: t.key });
              }}
            >
              <span className="i">{t.icon}</span>
              <span className="l">{t.label}</span>
            </button>
            </Fragment>
          ))}
          {!moreTools && moreButton}
          <button
            className="clear"
            title="清除当前标的的全部画线"
            disabled={!drawings.length || !!local}
            onClick={() => {
              if (window.confirm(`清除「${data.symbol.name}」的全部 ${drawings.length} 条画线？`)) {
                set({ drawClear: data.symbol.code });
                setSelectedDraw(null);
              }
            }}
          >
            <span className="i">✕</span>
            <span className="l">清除</span>
          </button>
        </aside>

        <main className={`chart ${drawTool ? 'drawing' : ''}`}>
          {drawTool && <div className="draw-hint">正在画「{DRAW_TOOLS.find((t) => t.key === drawTool.name)?.label}」：{drawTool.name === 'brush' ? '按住拖动自由画线，可连续画多笔 · 再点「画笔」或 Esc 退出'
            : dragDrawable(drawTool.name) ? '按住拖动画线，松手完成' : '在图上依次点击端点 · Esc 取消'}</div>}
          {data && state && (
            <KChart
              data={data} view={view} main={state.main} sub={state.sub} params={state.settings.indicators}
              terminal subHeight={140} minBars={minBars} onViewChange={applyView}
              drawings={drawings} drawTool={drawTool} lineWidth={state.settings.drawLine}
              onDrawEnd={(d) => {
                set({ drawPut: { symbol: latest.current.data.symbol.code, drawing: d } });
                if (d.name !== 'brush') setDrawTool(null); // 画笔连续画，不退出
              }}
              onDrawChange={(d) => set({ drawPut: { symbol: latest.current.data.symbol.code, drawing: d } })}
              onDrawSelect={setSelectedDraw}
              showDelete={touch && !local} readOnly={!!local}
              onDrawDelete={(id) => { set({ drawRemove: { symbol: latest.current.data.symbol.code, id } }); setSelectedDraw(null); }}
            />
          )}
        </main>

        <aside className="watch">
          <h3>自选 <small>{state?.watchlist.length ?? 0}</small></h3>
          {state?.watchlist.length ? (
            <ul>
              {state.watchlist.map((s) => (
                <li
                  key={s.code}
                  className={s.code === state.symbol ? 'active' : ''}
                  onClick={() => set({ symbol: s.code })}
                >
                  <span className="name">{s.name}</span>
                  <span className="code">{s.code}</span>
                  <button title="移出自选" onClick={(e) => { e.stopPropagation(); set({ watchRemove: s.code }); }}>×</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">点顶栏「☆ 加自选」或按 Insert 把当前标的加入自选</p>
          )}
          {state?.watchlist.length > 0 && !inWatch && <p className="empty">当前标的不在自选里，PageUp / PageDown 不可用</p>}
        </aside>
      </div>

      {!touch && <footer>
        <div className="preview" style={{ width: render.width * previewScale, height: render.height * previewScale }}>
          <iframe
            title="直播画面" src="/render?preview" width={render.width} height={render.height}
            style={{ transform: `scale(${previewScale})` }}
          />
        </div>
        <div className="side">
          <h3>直播画面 · {render.width}×{render.height}{previewScale < 1 && `（预览缩小到 ${Math.round(previewScale * 100)}%）`}</h3>
          {range && tab === 'kline' && !local && (
            <p className="range">
              {range.text}
              <span className={range.latest ? 'tag latest' : 'tag'}>{range.latest ? '跟随最新' : '历史区间'}</span>
            </p>
          )}
          <dl className="keys">
            <dt>↑ / ↓</dt><dd>放大 / 缩小（也可用滚轮）</dd>
            <dt>← / →</dt><dd>左右移动 1 根，Shift 加速 10 根（也可拖拽）</dd>
            <dt>Home / End</dt><dd>最早 / 回到最新</dd>
            <dt>Enter</dt><dd>更小周期：{[...periods].reverse().map((p) => p.label).join(' → ')}</dd>
            <dt>Backspace</dt><dd>更大周期：{periods.map((p) => p.label).join(' → ')}</dd>
            <dt>PgUp / PgDn</dt><dd>自选里的上一个 / 下一个（当前标的需在自选里）</dd>
            <dt>Insert / Delete</dt><dd>加入 / 移出自选（选中画线时 Delete 删除画线）</dd>
            <dt>画线</dt><dd>左侧工具栏选工具，在图上点击端点；拖动端点修改；Esc 取消</dd>
            <dt>排名页</dt><dd>↑↓ 选择，Enter / 双击 打开板块 K 线（直播画面同步切换）</dd>
            <dt>宏观页</dt><dd>← / → 切换上一张 / 下一张图表</dd>
            <dt>字母 / 数字</dt><dd>检索标的：000001、SZZS、shangzheng、上证指数</dd>
            <dt>Esc</dt><dd>关闭检索</dd>
          </dl>
          <p className="hint">vMix 浏览器源：<code>{renderUrl(auth?.renderKey)}</code></p>
        </div>
      </footer>}
    </div>
  );
}
