/**
 * 本地行情库（SQLite，Node 内置 node:sqlite）
 * scripts/sync.js 盘后写入，adapters/local.js 直播时读取。WAL 模式下两者可同时进行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || 'data/market.db');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS symbols (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,                -- index | stock
    category TEXT                      -- SW1 申万一级；同花顺板块 THN 概念 / THI 行业 / THR 地域 …
  );
  -- 日线（不复权）。股票与指数共用；vol 单位：手，amount 单位：千元
  CREATE TABLE IF NOT EXISTS daily (
    code TEXT, date INTEGER,           -- date = YYYYMMDD
    open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL,
    PRIMARY KEY (code, date)
  ) WITHOUT ROWID;
  -- 复权因子，用于前复权
  CREATE TABLE IF NOT EXISTS adj (
    code TEXT, date INTEGER, factor REAL,
    PRIMARY KEY (code, date)
  ) WITHOUT ROWID;
  -- 已完成同步的交易日（按接口区分），用于断点续传
  CREATE TABLE IF NOT EXISTS synced (
    kind TEXT, date INTEGER,
    PRIMARY KEY (kind, date)
  ) WITHOUT ROWID;

  -- ======== 板块排名用 ========
  -- 板块成分股（当前最新成分）：申万一级来自 index_member_all，同花顺概念来自 ths_member
  CREATE TABLE IF NOT EXISTS members (
    board TEXT, stock TEXT,
    PRIMARY KEY (board, stock)
  ) WITHOUT ROWID;
  -- 当日涨停的个股（limit_list_d，不含 ST）
  CREATE TABLE IF NOT EXISTS limit_up (
    date INTEGER, code TEXT,
    PRIMARY KEY (date, code)
  ) WITHOUT ROWID;
  -- 个股主力净额 = 大单 + 特大单 买入 − 卖出（moneyflow），单位：万元；申万一级按成分股汇总
  CREATE TABLE IF NOT EXISTS stock_flow (
    date INTEGER, code TEXT, main_net REAL,
    PRIMARY KEY (date, code)
  ) WITHOUT ROWID;
  -- 同花顺概念板块资金净额（moneyflow_cnt_ths），单位：亿元
  CREATE TABLE IF NOT EXISTS board_flow (
    date INTEGER, code TEXT, net REAL,
    PRIMARY KEY (date, code)
  ) WITHOUT ROWID;
  -- 宏观数据：每个数据集（见 shared/macro.js）一组行，data 为该期的原始字段 JSON
  CREATE TABLE IF NOT EXISTS macro (
    dataset TEXT, period TEXT, data TEXT,
    PRIMARY KEY (dataset, period)
  ) WITHOUT ROWID;
  -- ======== 分钟 K（tushare stk_mins / idx_mins，按需拉取，只保留最近 MINUTE_MONTHS 个月） ========
  -- freq = 1 / 5 / 15 / 30 / 60；ts = 该根 K 线结束时刻（毫秒）；价格不复权，vol 单位：股，amount 单位：元
  CREATE TABLE IF NOT EXISTS minute (
    code TEXT, freq INTEGER, ts INTEGER,
    open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL,
    PRIMARY KEY (code, freq, ts)
  ) WITHOUT ROWID;
  -- 每个标的 + 频率上次从 tushare 拉取的时间，避免每次打开都请求
  CREATE TABLE IF NOT EXISTS minute_fetch (
    code TEXT, freq INTEGER, fetched_at INTEGER, last_ts INTEGER,
    PRIMARY KEY (code, freq)
  ) WITHOUT ROWID;
  -- 杂项：如成分股上次刷新时间
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT
  );
`;

export function openDb({ mustExist = false } = {}) {
  if (mustExist && !fs.existsSync(DB_PATH)) {
    throw new Error(`本地行情库不存在（${DB_PATH}），请先运行 npm run sync`);
  }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // 旧库升级：补 category 列
  if (!db.prepare('PRAGMA table_info(symbols)').all().some((c) => c.name === 'category')) {
    db.exec('ALTER TABLE symbols ADD COLUMN category TEXT');
  }
  return db;
}

/** 在事务里执行，出错回滚 */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
