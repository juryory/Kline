import { RANK_COLUMNS, columnLabel, fmtDate } from './rankColumns.js';
import { renderScale } from '../../shared/settings.js';
import './panel.css';

/**
 * 直播画面：板块排名表（导播台「排名上屏」时显示）。
 * 行高按前 N 名平均分配，填满画面；排序列高亮。
 */
export default function RankPanel({ rank, state }) {
  const scale = renderScale(state.settings.render);
  const title = `${rank.listName} · ${columnLabel(rank.sort)}${rank.desc ? '榜' : '（升序）'}`;

  return (
    <div className="panel rank" style={{ '--s': scale }}>
      <div className="head">
        <div className="title">
          <span className="name">{title}</span>
          <span className="code">{fmtDate(rank.date)}</span>
        </div>
        <span className="code">前 {rank.rows.length} 名</span>
      </div>

      {/* 行高按「前 N 名」固定分配，板块数不足 N 时下方留空，不把行拉高 */}
      <div className="rank-table" style={{ gridTemplateRows: `auto repeat(${Math.max(rank.top, rank.rows.length, 1)}, 1fr)` }}>
        <div className="rank-row rank-headrow">
          <span className="no">#</span>
          <span className="bname">板块名称</span>
          {RANK_COLUMNS.map((c) => (
            <span key={c.key} className={c.key === rank.sort ? 'sorted' : ''}>{c.label}</span>
          ))}
        </div>
        {rank.rows.map((r, i) => (
          <div className="rank-row" key={r.code}>
            <span className="no">{i + 1}</span>
            <span className="bname">{r.name}</span>
            {RANK_COLUMNS.map((c) => (
              <span key={c.key} className={`${c.trend(r[c.key])} ${c.key === rank.sort ? 'sorted' : ''}`}>{c.fmt(r[c.key])}</span>
            ))}
          </div>
        ))}
      </div>

      <div className="foot">
        <b>围炉财经 · 数据中台</b>
      </div>
    </div>
  );
}
