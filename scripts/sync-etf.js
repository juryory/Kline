import { openDb } from '../server/db.js';
import { syncEtf } from '../server/etf-sync.js';
const db = openDb();
let lastCall = 0;
async function call(label, fn) {
  for (let attempt=0; ; attempt++) {
    const delay = Math.max(0, lastCall + 350 - Date.now());
    if (delay) await new Promise(r => setTimeout(r, delay));
    lastCall = Date.now();
    try { return await fn(); } catch (e) {
      if (attempt >= 3 || (e.tushareCode !== undefined && !e.retryable)) throw e;
      console.warn(`[etf] ${label} 暂时失败，${10*(attempt+1)} 秒后重试：${e.message}`);
      await new Promise(r => setTimeout(r, 10000*(attempt+1)));
    }
  }
}
try { await syncEtf({ db, call }); }
catch(e) { console.error(`[etf] 中断，保留已完成进度：${e.message}`); process.exitCode=1; }
finally { db.close(); }
