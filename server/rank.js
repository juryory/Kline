/**
 * 板块排名：从本地库计算每个板块的涨幅 / 5 日 / 10 日 / 20 日 / 年初至今 / 涨停数 / 主力净额。
 * 取「该列表里最新的交易日」为排名日期，当天没有行情的板块不参与排名。
 */
export const RANK_LISTS = {
  SW1: { name: '申万一级', category: 'SW1' },
  THN: { name: '同花顺概念', category: 'THN' },
};

// 结果缓存：数据只在盘后同步时变化，按「列表 + 库里最新日期」缓存
const cache = new Map();
const CACHE_MS = 60_000;

export function computeRanking(db, listKey) {
  const list = RANK_LISTS[listKey];
  if (!list) throw new Error(`未知排名列表 ${listKey}`);

  const boards = db.prepare('SELECT code, name FROM symbols WHERE category = ?').all(list.category);
  if (!boards.length) throw new Error(`本地库没有${list.name}数据，请先运行 npm run sync`);

  const date = db.prepare(`
    SELECT MAX(d.date) AS d FROM daily d JOIN symbols s ON s.code = d.code WHERE s.category = ?`).get(list.category).d;
  if (!date) throw new Error(`本地库没有${list.name}行情，请先运行 npm run sync`);

  const hit = cache.get(listKey);
  if (hit && hit.date === date && Date.now() - hit.at < CACHE_MS) return hit.value;

  // 取到上一年 11 月，保证 1 月时也能算 20 日涨幅和年初至今
  const year = Math.floor(date / 10000);
  const from = (year - 1) * 10000 + 1101;
  const rows = db.prepare(`
    SELECT d.code, d.date, d.close FROM daily d JOIN symbols s ON s.code = d.code
    WHERE s.category = ? AND d.date >= ? AND d.date <= ? ORDER BY d.code, d.date`).all(list.category, from, date);
  const series = new Map();
  for (const r of rows) {
    if (!series.has(r.code)) series.set(r.code, []);
    series.get(r.code).push(r);
  }

  // 涨停数：成分股里当天涨停的个数
  const limitUp = new Map(db.prepare(`
    SELECT m.board, COUNT(*) AS n FROM members m JOIN limit_up l ON l.code = m.stock
    WHERE l.date = ? GROUP BY m.board`).all(date).map((r) => [r.board, r.n]));
  const hasLimit = !!db.prepare('SELECT 1 FROM limit_up WHERE date = ? LIMIT 1').get(date);
  const hasMembers = !!db.prepare('SELECT 1 FROM members WHERE board IN (SELECT code FROM symbols WHERE category = ?) LIMIT 1').get(list.category);

  // 主力净额（亿元）：同花顺概念用官方板块资金流；申万一级按成分股个股资金流汇总
  let flow;
  if (listKey === 'THN') {
    flow = new Map(db.prepare('SELECT code, net FROM board_flow WHERE date = ?').all(date).map((r) => [r.code, r.net]));
  } else {
    flow = new Map(db.prepare(`
      SELECT m.board, SUM(f.main_net) / 10000.0 AS net FROM members m JOIN stock_flow f ON f.code = m.stock
      WHERE f.date = ? GROUP BY m.board`).all(date).map((r) => [r.board, r.net]));
  }

  const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);
  const out = [];
  for (const b of boards) {
    const s = series.get(b.code);
    if (!s?.length || s[s.length - 1].date !== date) continue; // 当天无行情（停发、新设）
    const n = s.length - 1;
    const close = s[n].close;
    const back = (k) => (n - k >= 0 ? s[n - k].close : null);
    const lastOfPrevYear = [...s].reverse().find((x) => Math.floor(x.date / 10000) < year)?.close ?? null;
    out.push({
      code: b.code,
      name: b.name,
      close,
      pct: pct(close, back(1)),
      pct5: pct(close, back(5)),
      pct10: pct(close, back(10)),
      pct20: pct(close, back(20)),
      ytd: pct(close, lastOfPrevYear),
      limitUp: hasLimit && hasMembers ? (limitUp.get(b.code) ?? 0) : null,
      mainNet: flow.get(b.code) ?? null,
    });
  }

  // 个股行情已同步到的最新交易日；板块日期落后于它，说明板块行情还没发布（同步早了）
  const marketDate = db.prepare("SELECT MAX(date) AS d FROM synced WHERE kind = 'daily'").get()?.d ?? null;
  const value = { list: listKey, listName: list.name, date, marketDate, rows: out };
  cache.set(listKey, { date, at: Date.now(), value });
  return value;
}

export const RANK_SORTS = ['pct', 'pct5', 'pct10', 'pct20', 'ytd', 'limitUp', 'mainNet'];

/** 排序：空值一律排最后 */
export function sortRows(rows, sort, desc) {
  return [...rows].sort((a, b) => {
    const x = a[sort], y = b[sort];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return desc ? y - x : x - y;
  });
}
