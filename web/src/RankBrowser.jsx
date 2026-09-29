import { useEffect, useMemo, useRef, useState } from 'react';
import { RANK_COLUMNS, RANK_LISTS, sortRows, fmtDate } from './rankColumns.js';

/**
 * 导播台「板块排名」页。列表 / 排序 / 前 N 名存在服务端（state.rank），改动立即反映到直播画面。
 * ↑↓ 选择，Enter / 双击 打开该板块 K 线（直播画面同步切到 K 线）。
 */
export default function RankBrowser({ active, rank, setRank, onOpen }) {
  const { list, sort, desc, top } = rank;
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const [topDraft, setTopDraft] = useState(String(top));
  const tableRef = useRef(null);

  useEffect(() => setTopDraft(String(top)), [top]);

  const load = () => {
    setLoading(true);
    fetch(`/api/rank?list=${list}`)
      .then((r) => r.json())
      .then(setRes)
      .catch((err) => setRes({ error: err.message }))
      .finally(() => setLoading(false));
  };
  useEffect(load, [list]);

  const rows = useMemo(() => (res?.rows ? sortRows(res.rows, sort, desc) : []), [res, sort, desc]);

  // 前 N 名：输入完回车或失焦时提交（3~30）
  const commitTop = () => {
    const n = parseInt(topDraft, 10);
    if (n >= 3 && n <= 30) { if (n !== top) setRank({ top: n }); } else setTopDraft(String(top));
  };

  // 键盘：↑↓ 选择，Enter 打开 K 线
  const latest = useRef();
  latest.current = { rows, sel, onOpen };
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      const { rows, sel, onOpen } = latest.current;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((i) => Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === 'Enter' && rows[sel]) {
        e.preventDefault();
        onOpen(rows[sel].code);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  useEffect(() => {
    tableRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const clickHeader = (key) => {
    setRank(key === sort ? { desc: !desc } : { sort: key, desc: true });
    setSel(0);
  };

  return (
    <div className="rank-browser">
      <div className="rank-bar">
        <div className="seg">
          {RANK_LISTS.map((l) => (
            <button key={l.key} className={l.key === list ? 'active' : ''} onClick={() => { setRank({ list: l.key }); setSel(0); }}>
              {l.label}
            </button>
          ))}
        </div>
        <label>
          直播显示前
          <input
            value={topDraft} inputMode="numeric"
            onChange={(e) => setTopDraft(e.target.value)}
            onBlur={commitTop}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
          名
        </label>
        <span className="spacer" />
        {res?.date && <span className="muted">数据日期 {fmtDate(res.date)} · 共 {rows.length} 个</span>}
        <button className="link" onClick={load} disabled={loading}>{loading ? '加载中…' : '刷新'}</button>
      </div>

      {res?.marketDate && res.date < res.marketDate && (
        <div className="rank-stale">
          板块行情只到 {fmtDate(res.date)}，个股行情已到 {fmtDate(res.marketDate)}：同步时 tushare 还没发布当天的板块数据
          （申万约 18:30，同花顺板块、涨停列表通常更晚）。晚些时候重新运行 <code>npm run sync</code> 即可补上。
        </div>
      )}

      {res?.error ? (
        <div className="error">{res.error}</div>
      ) : (
        <div className="rank-scroll" ref={tableRef}>
          <table>
            <thead>
              <tr>
                <th className="no">#</th>
                <th className="bname">板块名称</th>
                {RANK_COLUMNS.map((c) => (
                  <th key={c.key} className={c.key === sort ? 'sorted' : ''} onClick={() => clickHeader(c.key)}>
                    {c.label}{c.key === sort ? (desc ? ' ↓' : ' ↑') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.code} data-i={i}
                  className={`${i === sel ? 'sel' : ''} ${i < top ? 'in-top' : ''}`}
                  onClick={() => setSel(i)}
                  onDoubleClick={() => onOpen(r.code)}
                >
                  <td className="no">{i + 1}</td>
                  <td className="bname">{r.name}</td>
                  {RANK_COLUMNS.map((c) => (
                    <td key={c.key} className={c.trend(r[c.key])}>{c.fmt(r[c.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="rank-hint">
        点表头排序（再点切换升降序）· ↑↓ 选择 · Enter 或双击打开该板块 K 线 · 序号标黄的前 {top} 行即直播画面显示的内容
      </p>
    </div>
  );
}
