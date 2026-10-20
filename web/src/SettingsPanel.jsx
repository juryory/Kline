import DataSourceSection from './DataSourceSection.jsx';
import { useEffect, useState } from 'react';
import {
  INDICATOR_SPECS, RENDER_LIMITS, DEFAULT_SETTINGS, DRAW_LINE_PRESETS, DEFAULT_SAFE_AREA, checkIndicator, checkDrawLine,
  checkSafeSide, checkSafeOpacity, checkSafeColor, safeAreaFill,
} from '../../shared/settings.js';
import { DRAW_COLOR } from './drawTools.js';

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
  safeArea: (({ side, color, opacity }) => ({ side: String(side), color, opacity: String(opacity) }))(s.safeArea ?? DEFAULT_SAFE_AREA),
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
        <br />{s.start} 起 {s.days} 个交易日：
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

/** 导播台设置：指标参数 + 直播画面尺寸 + 画线粗细 + 数据同步。保存后服务端校验、落盘并广播到所有画面 */
export default function SettingsPanel({ settings, showSync, canSwitchSource, onSave, onClose }) {
  const [draft, setDraft] = useState(() => toDraft(settings));

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
  const safeErr = safeSideErr || safeOpacityErr || safeColorErr;
  const setSafe = (patch) => setDraft((d) => ({ ...d, safeArea: { ...d.safeArea, ...patch } }));
  const invalid = Object.values(errors).some(Boolean) || wErr || hErr || lineErr || safeErr;

  const save = () => {
    if (invalid) return;
    onSave({
      indicators: Object.fromEntries(Object.entries(draft.indicators).map(([k, v]) => [k, toNumbers(v)])),
      render: { width: Number(draft.render.width), height: Number(draft.render.height) },
      drawLine: Number(draft.drawLine),
      safeArea: { side: Number(draft.safeArea.side), color: draft.safeArea.color, opacity: Number(draft.safeArea.opacity) },
    });
  };

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>设置</h2>
        <DataSourceSection canSwitch={canSwitchSource} />

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

        <section>
          <h3>直播画面尺寸</h3>
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
          <div className="param-row">
            <span className="param-name">安全区外</span>
            <div className="param-inputs">
              <label>左右各 <input value={draft.safeArea.side} inputMode="numeric" onChange={(e) => setSafe({ side: e.target.value })} /> px</label>
              <label>底色 <input type="color" className="color" value={safeColorErr ? '#000000' : draft.safeArea.color} onChange={(e) => setSafe({ color: e.target.value })} /></label>
              <label>透明度 <input value={draft.safeArea.opacity} inputMode="numeric" onChange={(e) => setSafe({ opacity: e.target.value })} /> %</label>
              {!safeErr && Number(draft.safeArea.side) > 0 && (
                <span className="safe-sample" aria-hidden="true">
                  <i style={{ background: safeAreaFill({ color: draft.safeArea.color, opacity: Number(draft.safeArea.opacity) }) }} />
                  <b />
                  <i style={{ background: safeAreaFill({ color: draft.safeArea.color, opacity: Number(draft.safeArea.opacity) }) }} />
                </span>
              )}
            </div>
            {safeErr && <span className="param-error">{safeSideErr ? `宽度 ${safeSideErr}` : safeOpacityErr ? `透明度 ${safeOpacityErr}` : safeColorErr}</span>}
          </div>
          <p className="note">改尺寸后，vMix 里浏览器源的宽高要改成一样的数值。画面比 966×320 大时，文字和线条按比例放大。</p>
          <p className="note">安全区外：画面左右两侧直播时容易被裁掉，这部分只显示底色（透明度 0 = 完全透明），K 线和文字都放在中间。0 = 不留。</p>
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
          <p className="note">线段、射线、画笔等所有画线共用，已画的线也会一起改。直播画面比 966×320 大时按比例加粗。</p>
        </section>

        {showSync && <SyncSection />}

        <footer>
          <button onClick={() => setDraft(toDraft(DEFAULT_SETTINGS))}>恢复默认</button>
          <span className="spacer" />
          <button onClick={onClose}>取消</button>
          <button className="active" disabled={invalid} onClick={save}>保存并应用</button>
        </footer>
      </div>
    </div>
  );
}
