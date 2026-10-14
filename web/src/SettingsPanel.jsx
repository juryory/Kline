import { useEffect, useState } from 'react';
import {
  INDICATOR_SPECS, RENDER_LIMITS, DEFAULT_SETTINGS, DRAW_LINE_PRESETS, checkIndicator, checkDrawLine,
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
        {DATASETS.map(([k, label]) => `${label} ${arrivals[k] ? fmtHm(arrivals[k]) : '未到'}`).join(' · ')}
      </p>
      {info?.history?.length > 0 ? (
        <div className="sync-table-wrap">
          <table className="sync-table">
            <thead>
              <tr>
                <th>同步时间</th><th>用时</th><th>结果</th>
                {DATASETS.map(([k, label]) => <th key={k}>{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {info.history.map((r) => (
                <tr key={r.startedAt}>
                  <td>{fmtTime(r.startedAt)}{r.trigger === 'manual' && ' 手动'}</td>
                  <td>{Math.round((r.finishedAt - r.startedAt) / 1000)}s</td>
                  <td className={r.exitCode === 0 ? '' : 'bad'}>{r.exitCode === 0 ? '成功' : '部分失败'}</td>
                  {DATASETS.map(([k]) => (
                    <td key={k} className={r.lagging?.includes(k) ? 'lag' : r.arrived?.includes(k) ? 'new' : ''}>
                      {fmtMd(r.after?.[k])}{r.arrived?.includes(k) && ' 新'}
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
        <span className="lag">灰色</span> = 仍落后于个股（tushare 还没发布）。完整日志在服务器 data/sync-logs/。
      </p>
    </section>
  );
}

/** 导播台设置：指标参数 + 直播画面尺寸 + 画线粗细 + 数据同步。保存后服务端校验、落盘并广播到所有画面 */
export default function SettingsPanel({ settings, showSync, onSave, onClose }) {
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
  const invalid = Object.values(errors).some(Boolean) || wErr || hErr || lineErr;

  const save = () => {
    if (invalid) return;
    onSave({
      indicators: Object.fromEntries(Object.entries(draft.indicators).map(([k, v]) => [k, toNumbers(v)])),
      render: { width: Number(draft.render.width), height: Number(draft.render.height) },
      drawLine: Number(draft.drawLine),
    });
  };

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>设置</h2>

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
          <p className="note">改尺寸后，vMix 里浏览器源的宽高要改成一样的数值。画面比 966×320 大时，文字和线条按比例放大。</p>
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
