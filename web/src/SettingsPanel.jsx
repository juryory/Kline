import { useEffect, useState } from 'react';
import { INDICATOR_SPECS, RENDER_LIMITS, DEFAULT_SETTINGS, checkIndicator } from '../../shared/settings.js';

const SIZE_PRESETS = [
  [966, 320],
  [1280, 424],
  [1920, 636],
];

// 输入框里存字符串，方便编辑过程中出现空值；保存时再转数字
const toDraft = (s) => ({
  indicators: Object.fromEntries(Object.entries(s.indicators).map(([k, v]) => [k, v.map(String)])),
  render: { width: String(s.render.width), height: String(s.render.height) },
});
const toNumbers = (arr) => arr.map((v) => (v.trim() === '' ? NaN : Number(v)));

function sizeError(k, v) {
  const n = Number(v);
  const { min, max } = RENDER_LIMITS[k];
  return Number.isInteger(n) && n >= min && n <= max ? null : `${min}~${max} 的整数`;
}

/** 导播台设置：指标参数 + 直播画面尺寸。保存后服务端校验、落盘并广播到所有画面 */
export default function SettingsPanel({ settings, onSave, onClose }) {
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
  const invalid = Object.values(errors).some(Boolean) || wErr || hErr;

  const save = () => {
    if (invalid) return;
    onSave({
      indicators: Object.fromEntries(Object.entries(draft.indicators).map(([k, v]) => [k, toNumbers(v)])),
      render: { width: Number(draft.render.width), height: Number(draft.render.height) },
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
