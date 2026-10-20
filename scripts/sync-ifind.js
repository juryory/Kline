import fs from 'node:fs';
import path from 'node:path';
import { openIfindDb, IFIND_DB_PATH } from '../server/ifind-db.js';
import { syncIfind } from '../server/ifind-sync.js';
import { ifindConfigured } from '../server/source-config.js';

const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !ifindConfigured()) throw new Error('服务器尚未配置 IFIND_REFRESH_TOKEN 或 IFIND_ACCESS_TOKEN');
const lock = path.join(path.dirname(IFIND_DB_PATH), 'ifind-sync.lock');
fs.mkdirSync(path.dirname(lock), { recursive: true });
let fd;
try { fd = fs.openSync(lock, 'wx'); } catch { throw new Error(`已有 iFinD 同步任务；若上次异常退出，请确认进程已停止后移除 ${lock}`); }
fs.writeSync(fd, String(process.pid));
let db;
try {
  db = openIfindDb();
  const mode = process.argv.includes('--backfill') ? 'history' : process.argv.includes('--intraday') ? 'intraday' : process.env.IFIND_SYNC_MODE || 'daily';
  const result = await syncIfind({ db, dryRun, mode });
  if (result.errors.length) process.exitCode = 1;
} finally {
  db?.close(); fs.closeSync(fd); fs.unlinkSync(lock);
}
