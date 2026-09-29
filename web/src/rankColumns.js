/** 板块排名的列定义，导播台浏览和直播上屏共用。key 与 server/rank.js 的 RANK_SORTS 一致 */
const signed = (v, digits, suffix = '') => (v == null ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`);
const trendOf = (v) => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');

export const RANK_COLUMNS = [
  { key: 'pct', label: '涨幅', fmt: (v) => signed(v, 2, '%'), trend: trendOf },
  { key: 'pct5', label: '5日涨幅', fmt: (v) => signed(v, 2, '%'), trend: trendOf },
  { key: 'pct10', label: '10日涨幅', fmt: (v) => signed(v, 2, '%'), trend: trendOf },
  { key: 'pct20', label: '20日涨幅', fmt: (v) => signed(v, 2, '%'), trend: trendOf },
  { key: 'ytd', label: '年初至今', fmt: (v) => signed(v, 2, '%'), trend: trendOf },
  { key: 'limitUp', label: '涨停数', fmt: (v) => (v == null ? '--' : String(v)), trend: () => '' },
  { key: 'mainNet', label: '主力净额(亿)', fmt: (v) => signed(v, 2), trend: trendOf },
];

export const RANK_LISTS = [
  { key: 'THN', label: '同花顺概念' },
  { key: 'SW1', label: '申万一级' },
];

export const columnLabel = (key) => RANK_COLUMNS.find((c) => c.key === key)?.label ?? key;

/** 排序：空值一律排最后（与服务端一致） */
export function sortRows(rows, sort, desc) {
  return [...rows].sort((a, b) => {
    const x = a[sort], y = b[sort];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return desc ? y - x : x - y;
  });
}

export const fmtDate = (d) => (d ? `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6, 8)}` : '');
