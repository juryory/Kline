import fs from 'node:fs';
import path from 'node:path';
import { openIfindDb, IFIND_DB_PATH } from '../server/ifind-db.js';
import { syncIfind } from '../server/ifind-sync.js';
import { syncIfindMacro } from '../server/ifind-macro.js';
import { refreshConceptBoards } from '../server/ifind-boards.js';
import { runBackfill, backfillStatus, backfillConfig, calendarStart, tradingCalendar } from '../server/ifind-backfill.js';
import { createIfindClient } from '../server/ifind-client.js';
import { ifindConfigured } from '../server/source-config.js';

const flag = (name) => process.argv.includes(name);
const dryRun = flag('--dry-run');
const backfill = flag('--backfill');
if (!dryRun && !ifindConfigured()) throw new Error('服务器尚未配置 IFIND_REFRESH_TOKEN 或 IFIND_ACCESS_TOKEN');
const lock = path.join(path.dirname(IFIND_DB_PATH), 'ifind-sync.lock');
fs.mkdirSync(path.dirname(lock), { recursive: true });
let fd;
try { fd = fs.openSync(lock, 'wx'); } catch { throw new Error(`已有 iFinD 同步任务；若上次异常退出，请确认进程已停止后移除 ${lock}`); }
fs.writeSync(fd, String(process.pid));
let db;
const release = () => { db?.close(); db = null; if (fd != null) { fs.closeSync(fd); fd = null; fs.unlinkSync(lock); } };
// 补历史可随时 Ctrl+C：第一次等当前请求写完再停，第二次立即退出
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (interrupted) { release(); process.exit(130); }
  interrupted = true;
  console.log('[ifind] 收到中断，当前请求写完后停止（再按一次立即退出）');
});
try {
  db = openIfindDb();
  const client = createIfindClient();
  if (backfill) {
    // --backfill：分钟历史按批次补（定时任务每轮 10 分钟）；--drain 补满到官方停止线，不限时；--resume 核对暂停后继续
    if (dryRun) {
      // 只查交易日历和官方用量（都不耗额度），打印各批进度
      await tradingCalendar(db, client, calendarStart(Date.now(), backfillConfig()), Date.now());
      const status = backfillStatus(db);
      if (status) {
        const d = status.coreDaily;
        if (d) console.log(`[backfill] 核心指数 ${d.years} 年日线（${d.start} 起）：${d.codes} 个标的，${d.done}/${d.total} 标的日`);
        for (const b of status.batches) console.log(`[backfill] ${b.label}：${b.codes} 个标的，${b.done}/${b.total} 标的日`);
        console.log(`[backfill] ${status.start}—${status.end} ${status.days} 个交易日，剩余约 ${status.remainingCells.toLocaleString()} 数据量`
          + (status.paused ? `；已暂停：${status.paused.reason}` : ''));
      }
      console.log(`[backfill] 官方本周已用 ${(await client.dataVolume()).usage.toLocaleString()}`);
    } else {
      const drain = flag('--drain');
      const result = await runBackfill({ db, client, drain, resume: flag('--resume'),
        maxSeconds: drain ? Infinity : undefined, shouldStop: () => interrupted });
      if (result.failed) process.exitCode = 1;
    }
  } else {
    const mode = flag('--intraday') ? 'intraday' : process.env.IFIND_SYNC_MODE || 'daily';
    // 行情和宏观共用一个客户端，只取一次 access_token
    const macroOnly = flag('--macro-only');
    // 概念板块列表 + 成分股：每周一次（--boards 强制刷新），放在行情前面，新概念当晚就能拉到日线
    if (mode === 'daily' && !dryRun && !macroOnly || flag('--boards')) {
      try {
        await refreshConceptBoards({ db, client, force: flag('--boards') });
      } catch (err) {
        console.error(`[ifind] 概念板块刷新失败：${err.message}`);
        process.exitCode = 1;
      }
    }
    // --macro-only：只拉宏观（EDB 额度独立，不消耗行情额度）
    if (!macroOnly && !flag('--boards')) {
      const result = await syncIfind({ db, client, dryRun, mode });
      // 停牌/无权限标的的待补状态每轮都有，只有中止性错误才算失败
      if (result.failed) process.exitCode = 1;
    }
    if (mode !== 'intraday' && !dryRun && process.env.IFIND_MACRO !== '0' && !flag('--boards')) {
      if ((await syncIfindMacro({ db, client, force: macroOnly })).failed) process.exitCode = 1;
    }
  }
} finally {
  release();
}
