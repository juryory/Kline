import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, SCHEMA } from './db.js';
import { initIfind } from './ifind-store.js';

export const IFIND_DB_PATH = path.resolve(process.env.IFIND_DB_PATH || path.join(path.dirname(DB_PATH), 'ifind.db'));

/** 新库可写；旧库以 mode=ro 挂载，旧行情只在读取时补缺。 */
export function openIfindDb({ file = IFIND_DB_PATH, fallback = DB_PATH } = {}) {
  if (path.resolve(file).toLowerCase() === path.resolve(fallback).toLowerCase()) {
    throw new Error('IFIND_DB_PATH 必须与 Tushare DB_PATH 不同');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    db.exec(SCHEMA);
    initIfind(db);
    if (fs.existsSync(fallback)) {
      db.prepare('ATTACH DATABASE ? AS legacy').run(pathToFileURL(fallback).href + '?mode=ro');
      const tables = db.prepare("SELECT name FROM legacy.sqlite_master WHERE type='table'").all().map(r => r.name);
      // 仅投影已知表，不允许调用者写入旧库；meta、同步断点及额度属于新库。
      for (const table of ['daily', 'minute', 'adj', 'synced', 'members', 'limit_up', 'stock_flow',
        'board_flow', 'macro', 'breadth', 'index_members']) {
        if (tables.includes(table)) db.exec(`CREATE TEMP VIEW ${table} AS SELECT * FROM legacy.${table}`);
      }
      if (tables.includes('symbols')) {
        db.exec(`CREATE TEMP VIEW symbols AS SELECT * FROM ifind_symbols UNION ALL
          SELECT * FROM legacy.symbols s WHERE NOT EXISTS (SELECT 1 FROM ifind_symbols i WHERE i.code=s.code)`);
      }
      // 兼容此前的同库独立表版本：仅复制一次，不修改原文件。
      if (!db.prepare("SELECT 1 FROM meta WHERE key='ifind_legacy_imported'").get()) {
        db.exec('BEGIN');
        try {
          for (const table of ['ifind_symbols', 'ifind_daily', 'ifind_minute', 'ifind_progress', 'ifind_usage']) {
            if (tables.includes(table)) db.exec(`INSERT OR IGNORE INTO main.${table} SELECT * FROM legacy.${table}`);
          }
          db.exec("INSERT INTO meta VALUES ('ifind_legacy_imported','1'); COMMIT");
        } catch (err) { db.exec('ROLLBACK'); throw err; }
      }
    } else {
      db.exec('CREATE TEMP VIEW symbols AS SELECT * FROM ifind_symbols');
    }
    return db;
  } catch (err) { db.close(); throw err; }
}
