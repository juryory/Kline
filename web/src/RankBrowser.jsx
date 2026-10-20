import { useEffect, useMemo, useRef, useState } from 'react';
import { RANK_COLUMNS, RANK_LISTS, sortRows, fmtDate } from './rankColumns.js';

/**
 * 导播台「板块排名」页。列表 / 排序 / 前 N 名存在服务端（state.rank），改动立即反映到直播画面。
 * ↑↓ 选择，Enter / 双击 打开该板块 K 线（直播画面同步切到 K 线）。
 */
export default function RankBrowser({ active, rank, setRank, onOpen, syncedAt }) {
  const { list, sort, desc, top } = rank;
  const [res, setRes] = useState(null);
  const [sel, setSel] = useState(0);
  const [topDraft, setTopDraft] = useState(String(top));
  const tableRef = useRef(null);

  useEffect(() => setTopDraft(String(top)), [top]);

  // 盘中实时排行：页面打开时每分钟重新拉（服务端有缓存，盘外不访问数据源）
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [active]);

  // 切换列表、后台定时同步完成（syncedAt 变化）、每分钟刷新时重新拉取
  useEffect(() => {
    fetch(`/api/rank?list=${list}`)
      .then((r) => r.json())
      .then(setRes)
      .catch((err) => setRes({ error: err.message }));
  }, [list, syncedAt, tick]);

  // 当前数据源不提供的列（如 iFinD 没有主力净额）不展示，按它排序时改按涨幅
  const columns = RANK_COLUMNS.filter((c) => !res?.hidden?.includes(c.key));
  const by = res?.hidden?.includes(sort) ? 'pct' : sort;
  const rows = useMemo(() => (res?.rows ? sortRows(res.rows, by, desc) : []), [res, by, desc]);

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
        {res?.date && <span className="muted">数据日期 {fmtDate(res.date)}{res.liveAt ? ` · 实时 ${res.liveAt.slice(0, 5)}` : ''} · 共 {rows.length} 个</span>}
      </div>

      {res?.marketDate && res.date < res.marketDate && (
        <div className="rank-stale">
          板块行情只到 {fmtDate(res.date)}，个股行情已到 {fmtDate(res.marketDate)}：当天的板块数据还没发布。
          后台收盘后定时同步，发布后会自动补上（设置 → 数据同步 可看每次同步记录）。
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
                {columns.map((c) => (
                  <th key={c.key} className={c.key === by ? 'sorted' : ''} onClick={() => clickHeader(c.key)}>
                    {c.label}{c.key === by ? (desc ? ' ↓' : ' ↑') : ''}
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
                  {columns.map((c) => (
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
