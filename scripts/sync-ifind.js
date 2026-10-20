import fs from 'node:fs';
import path from 'node:path';
import { openIfindDb, IFIND_DB_PATH } from '../server/ifind-db.js';
import { syncIfind } from '../server/ifind-sync.js';
import { syncIfindMacro } from '../server/ifind-macro.js';
import { refreshConceptBoards } from '../server/ifind-boards.js';
import { createIfindClient } from '../server/ifind-client.js';
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
  // 行情和宏观共用一个客户端，只取一次 access_token
  const client = createIfindClient();
  const macroOnly = process.argv.includes('--macro-only');
  // 概念板块列表 + 成分股：每周一次（--boards 强制刷新），放在行情前面，新概念当晚就能拉到日线
  if (mode === 'daily' && !dryRun && !macroOnly || process.argv.includes('--boards')) {
    try {
      await refreshConceptBoards({ db, client, force: process.argv.includes('--boards') });
    } catch (err) {
      console.error(`[ifind] 概念板块刷新失败：${err.message}`);
      process.exitCode = 1;
    }
  }
  // --macro-only：只拉宏观（EDB 额度独立，不消耗行情额度）
  if (!macroOnly && !process.argv.includes('--boards')) {
    const result = await syncIfind({ db, client, dryRun, mode });
    // 停牌/无权限标的的待补状态每轮都有，只有中止性错误才算失败
    if (result.failed) process.exitCode = 1;
  }
  if (mode !== 'intraday' && !dryRun && process.env.IFIND_MACRO !== '0' && !process.argv.includes('--boards')) {
    if ((await syncIfindMacro({ db, client, force: macroOnly })).failed) process.exitCode = 1;
  }
} finally {
  db?.close(); fs.closeSync(fd); fs.unlinkSync(lock);
}
