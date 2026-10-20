// 独立表保存 iFinD 原始价格；永不覆盖 Tushare 的 daily / adj / minute。
export function initIfind(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ifind_symbols (
      code TEXT PRIMARY KEY, name TEXT, type TEXT, category TEXT
    );
    CREATE TABLE IF NOT EXISTS ifind_daily (
      code TEXT, date INTEGER, open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL,
      PRIMARY KEY(code,date)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ifind_minute (
      code TEXT, ts INTEGER, open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL,
      PRIMARY KEY(code,ts)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ifind_progress (
      kind TEXT, code TEXT, date INTEGER, complete INTEGER, attempted_at INTEGER,
      PRIMARY KEY(kind,code,date)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ifind_usage (
      month TEXT, kind TEXT, cells INTEGER NOT NULL, PRIMARY KEY(month,kind)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ifind_limit_up (
      date INTEGER, code TEXT, PRIMARY KEY(date,code)
    ) WITHOUT ROWID;
    -- 概念板块：iFinD 板块树节点（block_id）→ 指数代码（code，查不到时为 NULL）
    CREATE TABLE IF NOT EXISTS ifind_boards (
      list TEXT, block_id TEXT, name TEXT, code TEXT, PRIMARY KEY(list,block_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ifind_members (
      board TEXT, stock TEXT, PRIMARY KEY(board,stock)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ifind_macro (
      dataset TEXT, period TEXT, data TEXT, PRIMARY KEY(dataset,period)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ifind_weekly_usage (
      week TEXT, lane TEXT, kind TEXT, cells INTEGER NOT NULL,
      PRIMARY KEY(week,lane,kind)
    ) WITHOUT ROWID;
    -- 没有分钟数据的指数（如 700xxx 行业）：补历史和盘后同步都跳过，checked_at 起 30 天后再试一次
    CREATE TABLE IF NOT EXISTS ifind_no_minute (
      code TEXT PRIMARY KEY, checked_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    -- 补历史核对不一致的分钟日（分钟收盘 / 成交额汇总 对不上日线）
    CREATE TABLE IF NOT EXISTS ifind_backfill_issues (
      code TEXT, date INTEGER, detail TEXT, at INTEGER, PRIMARY KEY(code,date)
    ) WITHOUT ROWID;
    CREATE TEMP VIEW IF NOT EXISTS merged_daily AS
      SELECT * FROM ifind_daily UNION ALL
      SELECT d.* FROM daily d WHERE NOT EXISTS
        (SELECT 1 FROM ifind_daily i WHERE i.code=d.code AND i.date=d.date);
  `);
}

export function mergedDaily(db, code) {
  return db.prepare(`SELECT *, CASE WHEN EXISTS
    (SELECT 1 FROM ifind_daily i WHERE i.code=m.code AND i.date=m.date)
    THEN 'ifind' ELSE 'tushare' END AS source FROM merged_daily m WHERE code=? ORDER BY date`).all(code);
}
export function mergedMinutes(db, code, from = 0, to = Number.MAX_SAFE_INTEGER) {
  return db.prepare(`SELECT *, 'ifind' AS source FROM ifind_minute WHERE code=? AND ts BETWEEN ? AND ? UNION ALL
    SELECT code,ts,open,high,low,close,vol,amount,'tushare' AS source FROM minute m
    WHERE code=? AND freq=1 AND ts BETWEEN ? AND ? AND NOT EXISTS
      (SELECT 1 FROM ifind_minute i WHERE i.code=m.code AND i.ts=m.ts) ORDER BY ts`).all(code, from, to, code, from, to);
}
const NO_MINUTE_RECHECK = 30 * 86400_000;
/** 当前标记为没有分钟数据的代码 */
export function noMinuteCodes(db, now = Date.now()) {
  return new Set(db.prepare('SELECT code FROM ifind_no_minute WHERE checked_at > ?').all(now - NO_MINUTE_RECHECK).map((r) => r.code));
}
/** 交易日整段返回空、且库里从来没有这个代码的分钟时，记为没有分钟数据 */
export function flagNoMinute(db, code, now = Date.now()) {
  if (db.prepare('SELECT 1 FROM ifind_minute WHERE code=? LIMIT 1').get(code)) return false;
  db.prepare('INSERT OR REPLACE INTO ifind_no_minute VALUES (?,?)').run(code, now);
  return true;
}
export function writeIfind(db, kind, code, rows) {
  const sql = kind === 'daily'
    ? 'INSERT OR REPLACE INTO ifind_daily VALUES (?,?,?,?,?,?,?,?)'
    : 'INSERT OR REPLACE INTO ifind_minute VALUES (?,?,?,?,?,?,?,?)';
  const put = db.prepare(sql);
  for (const r of rows) put.run(code, kind === 'daily' ? r.date : r.ts,
    r.open, r.high, r.low, r.close, r.vol, r.amount);
}
