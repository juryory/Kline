/**
 * 板块排名：从本地库计算每个板块的涨幅 / 5 日 / 10 日 / 20 日 / 年初至今 / 涨停数 / 主力净额。
 * 取「该列表里最新的交易日」为排名日期，当天没有行情的板块不参与排名。
 */
export const RANK_LISTS = {
  SW1: { name: '申万一级', category: 'SW1' },
  THN: { name: '同花顺概念', category: 'THN' },
};

// 结果缓存：数据只在盘后同步时变化。后台同步结束会调 clearRankingCache()；
// 命令行跑 npm run sync 时靠「最新日期变了」或 CACHE_MS 过期来刷新
const cache = new Map();
const CACHE_MS = 10 * 60_000;
const SERIES_DAYS = 40; // 计算 5 / 10 / 20 日涨幅取的交易日数

export function clearRankingCache() {
  cache.clear();
}

export function computeRanking(db, listKey, dailyTable = 'daily') {
  if (!['daily', 'merged_daily'].includes(dailyTable)) throw new Error('行情表无效');
  const cacheKey = `${dailyTable}:${listKey}`;
  const list = RANK_LISTS[listKey];
  if (!list) throw new Error(`未知排名列表 ${listKey}`);

  const boards = db.prepare('SELECT code, name FROM symbols WHERE category = ?').all(list.category);
  if (!boards.length) throw new Error(`本地库没有${list.name}数据，请先运行 npm run sync`);

  // 注意：不要写成 daily JOIN symbols —— SQLite 会全表扫描 daily（几百万行），这里逐个板块取 MAX（走主键）
  const date = db.prepare(`
    SELECT MAX((SELECT MAX(date) FROM ${dailyTable} WHERE code = s.code)) AS d FROM symbols s WHERE s.category = ?`).get(list.category).d;
  if (!date) throw new Error(`本地库没有${list.name}行情，请先运行 npm run sync`);

  const hit = cache.get(cacheKey);
  if (hit && hit.date === date && Date.now() - hit.at < CACHE_MS) return hit.value;

  const year = Math.floor(date / 10000);
  // 只取最近 SERIES_DAYS 个交易日（20 日涨幅够用，留出停牌余量），交易日历取个股已同步的日期；
  // 库里没有交易日历时退回到上一年 11 月。年初至今单独查上一年最后一个收盘价
  const from = db.prepare(`
    SELECT date AS d FROM synced WHERE kind = 'daily' AND date <= ? ORDER BY date DESC LIMIT 1 OFFSET ?`).get(date, SERIES_DAYS - 1)?.d
    ?? (year - 1) * 10000 + 1101;
  // 同上，用 code IN (...) 让 SQLite 按主键 (code, date) 范围查，而不是扫整张 daily
  const rows = db.prepare(`
    SELECT code, date, close FROM ${dailyTable}
    WHERE code IN (SELECT code FROM symbols WHERE category = ?) AND date >= ? AND date <= ? ORDER BY code, date`).all(list.category, from, date);
  const series = new Map();
  for (const r of rows) {
    if (!series.has(r.code)) series.set(r.code, []);
    series.get(r.code).push(r);
  }

  // 上一年最后一个收盘价（年初至今的基准），每个板块一次主键查找
  const prevYearClose = new Map(db.prepare(`
    SELECT s.code, (SELECT close FROM ${dailyTable} WHERE code = s.code AND date < ? ORDER BY date DESC LIMIT 1) AS close
    FROM symbols s WHERE s.category = ?`).all(year * 10000 + 101, list.category).map((r) => [r.code, r.close]));

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
    const lastOfPrevYear = prevYearClose.get(b.code) ?? null;
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
  cache.set(cacheKey, { date, at: Date.now(), value });
  return value;
}

/**
 * iFinD 模式的同花顺概念排名：板块列表 / 成分股 / 涨停来自 iFinD（见 server/ifind-boards.js），
 * 板块日线 iFinD 优先，缺的日期（iFinD 只同步了最近几天）用 tushare 补。没有板块资金流，主力净额不展示。
 * db = openIfindDb()：daily 是挂载的 tushare 旧库视图。
 */
export function computeIfindRanking(db, live = null) {
  const h = ifindHistory(db);
  // 盘中：今天的最新价接在历史收盘价后面；库里已有当天日线（盘后同步完）时以库里为准
  const useLive = !!live && live.date > h.date;
  const date = useLive ? live.date : h.date;
  if (!useLive) {
    const hit = cache.get('ifind:THN');
    if (hit && hit.date === date && Date.now() - hit.at < CACHE_MS) return hit.value;
  }

  const limitUp = new Map(db.prepare(`SELECT m.board, COUNT(*) AS n FROM ifind_members m
    JOIN ifind_limit_up l ON l.code = m.stock WHERE l.date = ? GROUP BY m.board`).all(date).map((r) => [r.board, r.n]));
  const hasLimit = !!db.prepare('SELECT 1 FROM ifind_limit_up WHERE date = ? LIMIT 1').get(date);
  const hasMembers = !!db.prepare('SELECT 1 FROM ifind_members LIMIT 1').get();

  const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);
  const out = [];
  for (const b of h.boards) {
    let s = h.series.get(b.code);
    const q = useLive ? live.quotes.get(b.code) : null;
    if (useLive) {
      if (!(q?.latest > 0)) continue; // 停牌、无实时行情
      s = [...s.filter((r) => r.date < date), { date, close: q.latest }];
    } else if (h.latest.get(b.code) !== date) continue; // 当天无行情（停发、新设）
    const n = s.length - 1;
    const back = (k) => (n - k >= 0 ? s[n - k].close : null);
    const close = s[n].close;
    out.push({
      code: b.code, name: b.name, close,
      pct: q?.changeRatio ?? pct(close, back(1)),
      pct5: pct(close, back(5)), pct10: pct(close, back(10)), pct20: pct(close, back(20)),
      ytd: pct(close, h.yearBase(b.code, Math.floor(date / 10000))),
      // 实时：iFinD 直接给板块涨停家数；盘后：成分股 × 当天涨停
      limitUp: useLive ? (q.upLimitCount ?? null) : hasLimit && hasMembers ? (limitUp.get(b.code) ?? 0) : null,
      mainNet: null,
    });
  }
  const marketDate = useLive ? date
    : db.prepare("SELECT MAX(date) AS d FROM ifind_progress WHERE kind = 'daily' AND complete = 1").get()?.d ?? null;
  const value = { list: 'THN', listName: RANK_LISTS.THN.name, date, marketDate, rows: out, hidden: ['mainNet'],
    ...(useLive && { liveAt: live.time }) };
  if (!useLive) cache.set('ifind:THN', { date, at: Date.now(), value });
  return value;
}

/** 每个板块最近约 60 个交易日的收盘价（iFinD 优先，缺的日期用 tushare 补）；盘后同步后才变化，按最新日期缓存 */
function ifindHistory(db) {
  const boards = db.prepare("SELECT code, name FROM ifind_boards WHERE list = 'THN' AND code IS NOT NULL").all();
  if (!boards.length) throw new Error('还没有 iFinD 概念板块列表，请在服务器运行 iFinD 同步');

  // 两张表各按主键取 MAX；不要用 merged_daily 视图，跨库 NOT EXISTS 逐行比对要十几秒
  const latestOf = db.prepare(`SELECT MAX(d) AS d FROM (SELECT MAX(date) AS d FROM ifind_daily WHERE code = ?
    UNION ALL SELECT MAX(date) FROM daily WHERE code = ?)`);
  const latest = new Map(boards.map((b) => [b.code, latestOf.get(b.code, b.code).d]));
  const date = Math.max(0, ...latest.values());
  if (!date) throw new Error('本地库没有概念板块行情，请先运行同步');

  const hit = cache.get('ifind:hist');
  if (hit && hit.date === date && hit.boards === boards.length && Date.now() - hit.at < CACHE_MS) return hit.value;

  const ymdAt = (d, days) => {
    const t = new Date(Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100) - days * 86400_000);
    return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
  };
  const from = ymdAt(date, 90); // 约 60 个交易日，够 20 日涨幅并留出停牌余量
  const seriesOf = db.prepare(`SELECT date, close FROM ifind_daily WHERE code = ? AND date BETWEEN ? AND ?
    UNION ALL SELECT date, close FROM daily d WHERE code = ? AND date BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM ifind_daily i WHERE i.code = d.code AND i.date = d.date)
    ORDER BY date`);
  const lastBefore = db.prepare(`SELECT close FROM (
    SELECT date, close FROM (SELECT date, close FROM ifind_daily WHERE code = ? AND date < ? ORDER BY date DESC LIMIT 1)
    UNION ALL SELECT date, close FROM (SELECT date, close FROM daily WHERE code = ? AND date < ? ORDER BY date DESC LIMIT 1))
    ORDER BY date DESC LIMIT 1`);

  const series = new Map(boards.map((b) => [b.code, seriesOf.all(b.code, from, date, b.code, from, date)]));
  // 年初至今的基准：上一年最后一个收盘价，按 (板块, 年) 记忆
  const bases = new Map();
  const yearBase = (code, year) => {
    const key = `${code}:${year}`;
    if (!bases.has(key)) bases.set(key, lastBefore.get(code, year * 10000 + 101, code, year * 10000 + 101)?.close ?? null);
    return bases.get(key);
  };
  const value = { boards, latest, date, series, yearBase };
  cache.set('ifind:hist', { date, boards: boards.length, at: Date.now(), value });
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
