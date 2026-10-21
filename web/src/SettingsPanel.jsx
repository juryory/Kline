import DataSourceSection from './DataSourceSection.jsx';
import { useEffect, useState } from 'react';
import {
  INDICATOR_SPECS, RENDER_LIMITS, DEFAULT_SETTINGS, DRAW_LINE_PRESETS, DEFAULT_SAFE_AREA, DEFAULT_SUB_PANE, DEFAULT_BRAND, DEFAULT_HEAD_FONT, checkIndicator, checkDrawLine,
  checkSafeSide, checkSafeOpacity, checkSafeColor, checkSafeBorder, checkBrandSize, checkHeadFont, checkSubPane, safeAreaFill,
} from '../../shared/settings.js';
import { DRAW_COLOR } from './drawTools.js';

/** 设置左侧菜单。sync 只在本地库 / iFinD 数据源时显示；当前分类记在本机浏览器 */
const SETTINGS_TABS = [
  { key: 'screen', label: '直播画面' },
  { key: 'chart', label: '图表与画线' },
  { key: 'indicators', label: '指标参数' },
  { key: 'source', label: '数据源' },
  { key: 'sync', label: '数据同步' },
];
const TAB_KEY = 'kline.settingsTab';
// 直播画面页头可调字号的元素：[设置项, 名称, 示意文字]
const FONT_ROWS = [['name', '标的名称', '上证指数'], ['price', '最新价', '3713.03'], ['pct', '涨跌幅', '-0.60%']];

const SIZE_PRESETS = [
  [966, 320],
  [1280, 424],
  [1920, 636],
];

// 输入框里存字符串，方便编辑过程中出现空值；保存时再转数字
const toDraft = (s) => ({
  indicators: Object.fromEntries(Object.entries(s.indicators).map(([k, v]) => [k, v.map(String)])),
  render: { width: String(s.render.width), height: String(s.render.height) },
  drawLine: String(s.drawLine),
  safeArea: (({ side, color, opacity, borderWidth, borderColor, topWidth, topColor }) => ({ side: String(side), color, opacity: String(opacity),
    borderWidth: String(borderWidth ?? DEFAULT_SAFE_AREA.borderWidth), borderColor: borderColor ?? DEFAULT_SAFE_AREA.borderColor,
    topWidth: String(topWidth ?? DEFAULT_SAFE_AREA.topWidth), topColor: topColor ?? DEFAULT_SAFE_AREA.topColor }))(s.safeArea ?? DEFAULT_SAFE_AREA),
  brand: (({ size, color }) => ({ size: String(size), color }))(s.brand ?? DEFAULT_BRAND),
  headFont: Object.fromEntries(Object.keys(DEFAULT_HEAD_FONT).map((k) => [k, String(s.headFont?.[k] ?? DEFAULT_HEAD_FONT[k])])),
  subPane: (({ control, render }) => ({ control: String(control), render: String(render) }))(s.subPane ?? DEFAULT_SUB_PANE),
});
const toNumbers = (arr) => arr.map((v) => (v.trim() === '' ? NaN : Number(v)));

function sizeError(k, v) {
  const n = Number(v);
  const { min, max } = RENDER_LIMITS[k];
  return Number.isInteger(n) && n >= min && n <= max ? null : `${min}~${max} 的整数`;
}

const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });

const fmtHm = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
const fmtMd = (d) => (d ? `${String(d).slice(4, 6)}-${String(d).slice(6, 8)}` : '—');

// 与 server/sync-runner.js 的 DATASETS 一致
const DATASETS = [
  ['stock', '个股'], ['thn', '同花顺概念'], ['thsflow', '概念资金流'], ['thi', '同花顺行业'],
  ['sw1', '申万一级'], ['limit', '涨停'], ['flow', '个股资金流'],
];

const wan = (n) => `${(n / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 万`;

/** 分钟历史补全进度（server/backfill-runner.js）：各批完成比例、官方本周用量、预计还要几周 */
function BackfillNote({ info }) {
  const s = info.status;
  // 每周可用于补历史：周一至周四到停止线，周五手动补满，约 1.2 亿
  const weeks = s ? Math.ceil(s.remainingCells / 1.2e8 * 10) / 10 : null;
  return (
    <p className="note">
      分钟历史补全：{info.enabled ? info.window : '未开启（IFIND_BACKFILL=1）'}
      {info.running && ` · 补历史中（${fmtHm(info.startedAt)} 开始）`}
      {!info.running && info.finishedAt && ` · 上一轮 ${fmtTime(info.finishedAt)}${info.exitCode === 0 ? '' : ' 失败'}`}
      {info.official && ` · 官方本周已用 ${wan(info.official.usage)} / ${wan(info.official.limit)}`}
      {s && <>
        {s.coreDaily && <><br />核心指数 {s.coreDaily.years} 年日线（{s.coreDaily.start} 起
          {s.coreDaily.fullHistory?.length > 0 && `，${s.coreDaily.fullHistory.join('、')} 全历史`}）：{s.coreDaily.done >= s.coreDaily.total ? '已补完'
          : `${Math.floor(s.coreDaily.done / s.coreDaily.total * 100)}%`}</>}
        <br />分钟 {s.start} 起 {s.days} 个交易日：
        {s.batches.map((b) => `${b.label} ${b.pending ? '未开始' : `${b.total ? Math.floor(b.done / b.total * 100) : 100}%（${b.codes} 个）`}`).join(' · ')}
        {s.remainingCells > 0 ? `；剩余约 ${wan(s.remainingCells)} 数据量，约 ${weeks} 周` : '；已全部补完'}
        {s.noMinute > 0 && `；${s.noMinute} 个指数没有分钟数据，已跳过`}
      </>}
      {s?.paused && <><br /><span className="param-error">已暂停：{s.paused.reason}。确认后运行 npm run sync:ifind -- --backfill --resume</span></>}
      {info.last && <><br />{info.last}</>}
    </p>
  );
}

/**
 * 数据同步记录（只读）：服务端按 SYNC_WINDOW / SYNC_EVERY 定时从 tushare 同步，这里看每次同步后各数据的最新日期，
 * 「新」= 本次同步新到的数据。用来观察同花顺概念等板块数据每天几点发布
 */
function SyncSection() {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = () => fetch('/api/sync').then((r) => r.json()).then((j) => { setInfo(j); setError(null); })
      .catch((err) => setError(`连接后台失败：${err.message}`));
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, []);

  const arrivals = info?.arrivals ?? {};
  const datasets = info?.datasets?.map((s) => [s.key, s.label]) ?? DATASETS;
  return (
    <section>
      <h3>数据同步</h3>
      <p className="note">
        自动同步：{info?.schedule ?? '…'}
        {info?.running && ` · 同步中（${fmtHm(info.startedAt)} 开始）`}
        {error && <span className="param-error"> {error}</span>}
      </p>
      <p className="note">
        今天数据到达：
        {datasets.map(([k, label]) => `${label} ${arrivals[k] ? fmtHm(arrivals[k]) : '未到'}`).join(' · ')}
      </p>
      {info?.quota?.profile === 'trial' && <p className="note">
        iFinD 本周本机预留/使用：{info.quota.used.toLocaleString()} / {info.quota.total.toLocaleString()} 单元格，
        其中补历史 {info.quota.historyUsed.toLocaleString()}；保留额度 {info.quota.reserve.toLocaleString()}。
        不包含其他终端用量，以官方账户为准。盘中实时数据按需拉取：只请求正在查看的标的和排行，不看的不更新。
      </p>}
      {info?.backfill && <BackfillNote info={info.backfill} />}
      {info?.latest && <p className="note">
        iFinD 已保存日期：{datasets.map(([key,label]) => `${label} ${fmtMd(info.latest[key])}${
          info.coverage?.[key] ? `（${info.coverage[key][0]}/${info.coverage[key][1]}）` : ''}`).join(' · ')}。
        最新日期不代表历史完整。
      </p>}
      {info?.history?.length > 0 ? (
        <div className="sync-table-wrap">
          <table className="sync-table">
            <thead>
              <tr>
                <th>同步时间</th><th>用时</th><th>结果</th>
                {datasets.map(([k, label]) => <th key={k}>{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {info.history.map((r) => (
                <tr key={r.startedAt}>
                  <td>{fmtTime(r.startedAt)}{r.trigger === 'manual' && ' 手动'}</td>
                  <td>{Math.round((r.finishedAt - r.startedAt) / 1000)}s</td>
                  <td className={r.exitCode === 0 ? '' : 'bad'}>{r.exitCode === 0 ? '成功' : '部分失败'}</td>
                  {datasets.map(([k]) => (
                    <td key={k} className={r.lagging?.includes(k) ? 'lag' : r.arrived?.includes(k) ? 'new' : ''}>
                      {fmtMd(r.after?.[k])}{r.arrived?.includes(k) && ' 新'}
                      {/* 板块只到了一部分：显示 已到 / 应有 */}
                      {r.coverage?.[k] && r.coverage[k][0] < r.coverage[k][1] && (
                        <span className="cov"> {r.coverage[k][0]}/{r.coverage[k][1]}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="note">还没有同步记录。</p>
      )}
      <p className="note">
        日期 = 同步后本地库里该数据的最新交易日；<b className="new">新</b> = 本次同步新到；
        板块列后面的 312/420 = 只有 312 个板块到了最新日期（数据源分批发布，后面的同步会补齐）；
        <span className="lag">灰色</span> = 仍落后于个股（数据源还没发布）。完整日志在服务器 data/sync-logs/。
      </p>
    </section>
  );
}

/**
 * 导播台设置：左侧分类菜单（直播画面 / 图表与画线 / 指标参数 / 数据源 / 数据同步），右侧是该分类的设置项。
 * 各分类的修改先存在草稿里，「保存并应用」一起提交；服务端校验、落盘并广播到所有画面。数据源切换即时生效，不走保存
 */
export default function SettingsPanel({ settings, showSync, canSwitchSource, onSave, onClose }) {
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem(TAB_KEY) || 'screen'; } catch { return 'screen'; }
  });
  const pickTab = (key) => {
    setTab(key);
    try { localStorage.setItem(TAB_KEY, key); } catch { /* 隐私模式等，忽略 */ }
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setParams = (key, params) => setDraft((d) => ({ ...d, indicators: { ...d.indicators, [key]: params } }));
  const setSize = (k, v) => setDraft((d) => ({ ...d, render: { ...d.render, [k]: v } }));

  const errors = Object.fromEntries(
    Object.keys(INDICATOR_SPECS).map((k) => [k, checkIndicator(k, toNumbers(draft.indicators[k]))]),
  );
  const wErr = sizeError('width', draft.render.width);
  const hErr = sizeError('height', draft.render.height);
  const lineErr = checkDrawLine(draft.drawLine.trim() === '' ? NaN : Number(draft.drawLine));
  const safeSideErr = wErr ? null : checkSafeSide(Number(draft.safeArea.side), Number(draft.render.width));
  const safeOpacityErr = checkSafeOpacity(Number(draft.safeArea.opacity));
  const safeColorErr = checkSafeColor(draft.safeArea.color);
  const borderErr = checkSafeBorder(Number(draft.safeArea.borderWidth)) || checkSafeColor(draft.safeArea.borderColor);
  const topErr = checkSafeBorder(Number(draft.safeArea.topWidth)) || checkSafeColor(draft.safeArea.topColor);
  const brandErr = checkBrandSize(Number(draft.brand.size)) || checkSafeColor(draft.brand.color);
  const fontErr = Object.fromEntries(Object.keys(DEFAULT_HEAD_FONT).map((k) => [k, checkHeadFont(Number(draft.headFont[k]))]));
  const setFont = (k, v) => setDraft((d) => ({ ...d, headFont: { ...d.headFont, [k]: v } }));
  const setBrand = (patch) => setDraft((d) => ({ ...d, brand: { ...d.brand, ...patch } }));
  const fillErr = safeOpacityErr || safeColorErr;
  const fill = fillErr ? null : safeAreaFill({ color: draft.safeArea.color, opacity: Number(draft.safeArea.opacity) });
  // 示意图里的边框：按比例缩小，有边框时至少 1px
  const sampleBorder = !borderErr && Number(draft.safeArea.borderWidth) > 0
    ? `${Math.max(1, Math.round(Number(draft.safeArea.borderWidth) / 3))}px solid ${draft.safeArea.borderColor}` : undefined;
  const setSafe = (patch) => setDraft((d) => ({ ...d, safeArea: { ...d.safeArea, ...patch } }));
  const subErr = { control: checkSubPane('control', Number(draft.subPane.control)), render: checkSubPane('render', Number(draft.subPane.render)) };
  const setSub = (k, v) => setDraft((d) => ({ ...d, subPane: { ...d.subPane, [k]: v } }));
  const invalid = Object.values(errors).some(Boolean) || wErr || hErr || lineErr || safeSideErr || borderErr || topErr || brandErr || Object.values(fontErr).some(Boolean) || fillErr || subErr.control || subErr.render;

  const save = () => {
    if (invalid) return;
    onSave({
      indicators: Object.fromEntries(Object.entries(draft.indicators).map(([k, v]) => [k, toNumbers(v)])),
      render: { width: Number(draft.render.width), height: Number(draft.render.height) },
      drawLine: Number(draft.drawLine),
      safeArea: {
        side: Number(draft.safeArea.side), color: draft.safeArea.color, opacity: Number(draft.safeArea.opacity),
        borderWidth: Number(draft.safeArea.borderWidth), borderColor: draft.safeArea.borderColor,
        topWidth: Number(draft.safeArea.topWidth), topColor: draft.safeArea.topColor,
      },
      brand: { size: Number(draft.brand.size), color: draft.brand.color },
      headFont: Object.fromEntries(Object.entries(draft.headFont).map(([k, v]) => [k, Number(v)])),
      subPane: { control: Number(draft.subPane.control), render: Number(draft.subPane.render) },
    });
  };

  // 每个分类里有不合法的输入时，左侧菜单标红点（保存按钮不可用时能找到是哪一页）
  const tabErr = {
    screen: !!(wErr || hErr || fillErr || safeSideErr || borderErr || topErr || brandErr || Object.values(fontErr).some(Boolean)),
    chart: !!(subErr.control || subErr.render || lineErr),
    indicators: Object.values(errors).some(Boolean),
  };
  const tabs = SETTINGS_TABS.filter((t) => t.key !== 'sync' || showSync);
  const current = tabs.some((t) => t.key === tab) ? tab : tabs[0].key;
  const color = (value, onChange) => (
    <input type="color" className="color" value={checkSafeColor(value) ? '#000000' : value} onChange={(e) => onChange(e.target.value)} />
  );

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>设置</h2>
          <button className="close" title="关闭（Esc）" onClick={onClose}>×</button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav">
            {tabs.map((t) => (
              <button key={t.key} className={current === t.key ? 'active' : ''} onClick={() => pickTab(t.key)}>
                {t.label}{tabErr[t.key] && <i className="dot" title="有不合法的输入" />}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {current === 'screen' && <>
              <section>
                <h3>尺寸</h3>
                <div className="param-row">
                  <span className="param-name">宽 × 高</span>
                  <div className="param-inputs">
                    <label><input value={draft.render.width} inputMode="numeric" onChange={(e) => setSize('width', e.target.value)} /></label>
                    ×
                    <label><input value={draft.render.height} inputMode="numeric" onChange={(e) => setSize('height', e.target.value)} /></label>
                    {SIZE_PRESETS.map(([w, h]) => (
                      <button key={w} className="add" onClick={() => setDraft((d) => ({ ...d, render: { width: String(w), height: String(h) } }))}>
                        {w}×{h}
                      </button>
                    ))}
                  </div>
                  {(wErr || hErr) && <span className="param-error">宽 {wErr ?? '✓'}，高 {hErr ?? '✓'}</span>}
                </div>
                <p className="note">改尺寸后，vMix 里浏览器源的宽高要改成一样的数值。画面比 966×320 大时，文字和线条按比例放大。</p>
              </section>

              <section>
                <h3>底色与边框</h3>
                <div className="param-row">
                  <span className="param-name">画面底色</span>
                  <div className="param-inputs">
                    <label>颜色 {color(draft.safeArea.color, (v) => setSafe({ color: v }))}</label>
                    <label>透明度 <input value={draft.safeArea.opacity} inputMode="numeric" onChange={(e) => setSafe({ opacity: e.target.value })} /> %</label>
                    {fill && (
                      <span className="safe-sample" aria-hidden="true">
                        {!topErr && Number(draft.safeArea.topWidth) > 0 && <s style={{ background: draft.safeArea.topColor }} />}
                        {Number(draft.safeArea.side) > 0 && <i style={{ background: fill, borderRight: sampleBorder }} />}
                        <b style={{ background: fill }} />
                        {Number(draft.safeArea.side) > 0 && <i style={{ background: fill, borderLeft: sampleBorder }} />}
                      </span>
                    )}
                  </div>
                  {fillErr && <span className="param-error">{safeOpacityErr ? `透明度 ${safeOpacityErr}` : safeColorErr}</span>}
                </div>
                <div className="param-row">
                  <span className="param-name">安全区外</span>
                  <div className="param-inputs">
                    <label>左右各 <input value={draft.safeArea.side} inputMode="numeric" onChange={(e) => setSafe({ side: e.target.value })} /> px</label>
                  </div>
                  {safeSideErr && <span className="param-error">宽度 {safeSideErr}</span>}
                </div>
                <div className="param-row">
                  <span className="param-name">左右边框</span>
                  <div className="param-inputs">
                    <label>宽度 <input value={draft.safeArea.borderWidth} inputMode="numeric" onChange={(e) => setSafe({ borderWidth: e.target.value })} /> px</label>
                    <label>颜色 {color(draft.safeArea.borderColor, (v) => setSafe({ borderColor: v }))}</label>
                  </div>
                  {borderErr && <span className="param-error">{borderErr}</span>}
                </div>
                <div className="param-row">
                  <span className="param-name">上边框</span>
                  <div className="param-inputs">
                    <label>宽度 <input value={draft.safeArea.topWidth} inputMode="numeric" onChange={(e) => setSafe({ topWidth: e.target.value })} /> px</label>
                    <label>颜色 {color(draft.safeArea.topColor, (v) => setSafe({ topColor: v }))}</label>
                  </div>
                  {topErr && <span className="param-error">{topErr}</span>}
                </div>
                <p className="note">画面底色：K 线、排名、宏观图的背景和两侧安全区外共用（透明度 0 = 完全透明，vMix 里只叠加内容）。</p>
                <p className="note">安全区外：画面左右两侧直播时容易被裁掉，只铺底色，K 线和文字放在中间，0 = 不留。左右边框画在安全区外靠内容的一侧，不占内容宽度；上边框横跨整个画面最上方。边框宽度 0 = 不画。</p>
              </section>

              <section>
                <h3>字体</h3>
                {FONT_ROWS.map(([k, label, sample]) => (
                  <div className="param-row" key={k}>
                    <span className="param-name">{label}</span>
                    <div className="param-inputs">
                      <label>字号 <input value={draft.headFont[k]} inputMode="numeric" onChange={(e) => setFont(k, e.target.value)} /> px</label>
                      {!fontErr[k] && <span className={`font-sample ${k}`} style={{ fontSize: Number(draft.headFont[k]) }}>{sample}</span>}
                    </div>
                    {fontErr[k] && <span className="param-error">{fontErr[k]}</span>}
                  </div>
                ))}
                <div className="param-row">
                  <span className="param-name">品牌文字</span>
                  <div className="param-inputs">
                    <label>字号 <input value={draft.brand.size} inputMode="numeric" onChange={(e) => setBrand({ size: e.target.value })} /> px</label>
                    <label>颜色 {color(draft.brand.color, (v) => setBrand({ color: v }))}</label>
                    {!brandErr && <span className="brand-sample" style={{ color: draft.brand.color, fontSize: Number(draft.brand.size) }}>围炉财经 · 数据中台</span>}
                  </div>
                  {brandErr && <span className="param-error">{brandErr}</span>}
                </div>
                <p className="note">直播画面页头的字号，按 966×320 计算，画面放大时按比例放大。品牌文字 = 周期按钮左边的「围炉财经 · 数据中台」，标的名称在板块排名页同样生效。</p>
              </section>
            </>}

            {current === 'chart' && <>
              <section>
                <h3>副图</h3>
                <div className="param-row">
                  <span className="param-name">高度</span>
                  <div className="param-inputs">
                    <label>导播台 <input value={draft.subPane.control} inputMode="numeric" onChange={(e) => setSub('control', e.target.value)} /> px</label>
                    <label>直播画面 <input value={draft.subPane.render} inputMode="numeric" onChange={(e) => setSub('render', e.target.value)} /> px</label>
                  </div>
                  {(subErr.control || subErr.render) && <span className="param-error">导播台 {subErr.control ?? '✓'}，直播画面 {subErr.render ?? '✓'}</span>}
                </div>
                <p className="note">成交量、MACD 等副图的高度。直播画面按 966×320 计算，画面放大时按比例加高。</p>
              </section>

              <section>
                <h3>画线</h3>
                <div className="param-row">
                  <span className="param-name">线条粗细</span>
                  <div className="param-inputs">
                    <label><input value={draft.drawLine} inputMode="decimal" onChange={(e) => setDraft((d) => ({ ...d, drawLine: e.target.value }))} /> px</label>
                    {DRAW_LINE_PRESETS.map((w) => (
                      <button
                        key={w} className={`add ${Number(draft.drawLine) === w ? 'active' : ''}`}
                        onClick={() => setDraft((d) => ({ ...d, drawLine: String(w) }))}
                      >
                        {w}
                      </button>
                    ))}
                    {!lineErr && (
                      <svg className="line-sample" width="80" height="16" aria-hidden="true">
                        <line x1="4" y1="8" x2="76" y2="8" stroke={DRAW_COLOR} strokeWidth={Number(draft.drawLine)} strokeLinecap="round" />
                      </svg>
                    )}
                  </div>
                  {lineErr && <span className="param-error">{lineErr}</span>}
                </div>
                <p className="note">线段、射线、方框、画笔等所有画线共用，已画的线也会一起改。直播画面比 966×320 大时按比例加粗。</p>
              </section>
            </>}

            {current === 'indicators' && (
              <section>
                <h3>指标参数</h3>
                {Object.entries(INDICATOR_SPECS).map(([key, spec]) => {
                  const params = draft.indicators[key];
                  return (
                    <div className="param-row" key={key}>
                      <span className="param-name">{spec.label}</span>
                      <div className="param-inputs">
                        {spec.kind === 'list' ? (
                          <>
                            {params.map((v, i) => (
                              <span className="chip" key={i}>
                                <input
                                  value={v} inputMode="numeric"
                                  onChange={(e) => setParams(key, params.map((x, j) => (j === i ? e.target.value : x)))}
                                />
                                {params.length > 1 && (
                                  <button title="删除" onClick={() => setParams(key, params.filter((_, j) => j !== i))}>×</button>
                                )}
                              </span>
                            ))}
                            {params.length < spec.maxCount && (
                              <button className="add" onClick={() => setParams(key, [...params, ''])}>+ 添加</button>
                            )}
                          </>
                        ) : (
                          spec.fields.map((f, i) => (
                            <label key={i}>
                              {f.label}
                              <input
                                value={params[i]} inputMode="decimal"
                                onChange={(e) => setParams(key, params.map((x, j) => (j === i ? e.target.value : x)))}
                              />
                            </label>
                          ))
                        )}
                      </div>
                      {errors[key] && <span className="param-error">{errors[key]}</span>}
                    </div>
                  );
                })}
              </section>
            )}

            {current === 'source' && <DataSourceSection canSwitch={canSwitchSource} />}
            {current === 'sync' && <SyncSection />}
          </div>
        </div>

        <footer>
          <button title="所有分类恢复默认（数据源不变）" onClick={() => setDraft(toDraft(DEFAULT_SETTINGS))}>恢复默认</button>
          <span className="spacer" />
          {invalid && <span className="param-error">有不合法的输入（左侧红点的分类）</span>}
          <button onClick={onClose}>取消</button>
          <button className="active" disabled={invalid} onClick={save}>保存并应用</button>
        </footer>
      </div>
    </div>
  );
}
