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

/** 数据同步：触发服务端跑一次盘后同步（tushare → 本地库），同步中轮询进度。与「保存并应用」无关，点了立即执行 */
function SyncSection() {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  const call = (method) => fetch('/api/sync', { method })
    .then((r) => r.json())
    .then((j) => { setInfo(j); setError(method === 'POST' && !j.ok ? j.error : null); })
    .catch((err) => setError(`连接后台失败：${err.message}`));

  useEffect(() => { call('GET'); }, []);
  useEffect(() => {
    if (!info?.running) return;
    const timer = setInterval(() => call('GET'), 2000);
    return () => clearInterval(timer);
  }, [info?.running]);

  let summary = '本次启动后还没有同步过';
  if (info?.running) summary = `同步中…（${fmtTime(info.startedAt)} 开始）`;
  else if (info?.finishedAt) {
    const secs = Math.round((info.finishedAt - info.startedAt) / 1000);
    summary = `上次同步 ${fmtTime(info.finishedAt)}，用时 ${secs}s，${info.exitCode === 0 ? '成功' : '有部分失败，见日志'}`;
  }

  return (
    <section>
      <h3>数据同步</h3>
      <div className="param-row">
        <span className="param-name">盘后数据</span>
        <div className="param-inputs">
          <button className="add" disabled={!info || info.running} onClick={() => call('POST')}>
            {info?.running ? '同步中…' : '立即同步'}
          </button>
          <span className={`sync-summary ${info?.finishedAt && !info.running && info.exitCode !== 0 ? 'bad' : ''}`}>{summary}</span>
        </div>
        {error && <span className="param-error">{error}</span>}
      </div>
      {info?.log?.length > 0 && <pre className="sync-log">{info.log.slice(-8).join('\n')}</pre>}
      <p className="note">从 tushare 拉取最新收盘数据写入本地库（同 npm run sync），平时几十秒到几分钟；同步期间直播不受影响，完成后画面自动刷新。</p>
    </section>
  );
}

/** 导播台设置：指标参数 + 直播画面尺寸 + 画线粗细 + 数据同步。保存后服务端校验、落盘并广播到所有画面 */
export default function SettingsPanel({ settings, canSync, onSave, onClose }) {
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

        {canSync && <SyncSection />}

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
