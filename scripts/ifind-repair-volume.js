// 找出成交量单位错了 100 倍的指数日线（成交额/成交量推算的均价不在 1—500 元），删除后由下次同步重拉
//   node scripts/ifind-repair-volume.js           只列出
//   node scripts/ifind-repair-volume.js --apply   删除这些行及其完成标记
// 板块没有成交额无法用均价判断，不在检查范围内。
import fs from 'node:fs';
import path from 'node:path';
import { openIfindDb, IFIND_DB_PATH } from '../server/ifind-db.js';
import { tx } from '../server/db.js';

const apply = process.argv.includes('--apply');
const lock = path.join(path.dirname(IFIND_DB_PATH), 'ifind-sync.lock');
if (apply && fs.existsSync(lock)) throw new Error(`iFinD 同步正在进行（${lock}），请等结束后再修复`);
const db = openIfindDb();
try {
  // ifind_daily 日线单位：vol 手、amount 千元 → 均价 = amount*1000 / (vol*100)
  const bad = db.prepare(`SELECT d.code, d.date, d.vol, d.amount, d.amount*10/d.vol AS price FROM ifind_daily d
    JOIN symbols s ON s.code=d.code WHERE s.type='index' AND d.vol>0 AND d.amount>0
    AND (d.amount*10/d.vol < 1 OR d.amount*10/d.vol > 500) ORDER BY d.code, d.date`).all();
  for (const r of bad) console.log(`${r.code} ${r.date} vol=${r.vol} amount=${r.amount} 均价=${r.price.toFixed(2)}`);
  console.log(`共 ${bad.length} 行${bad.length && !apply ? '；确认后加 --apply 删除' : ''}`);
  if (apply && bad.length) {
    const delDaily = db.prepare('DELETE FROM ifind_daily WHERE code=? AND date=?');
    const delMark = db.prepare("DELETE FROM ifind_progress WHERE kind='daily' AND code=? AND date=?");
    tx(db, () => { for (const r of bad) { delDaily.run(r.code, r.date); delMark.run(r.code, r.date); } });
    const from = String(bad.reduce((m, r) => Math.min(m, r.date), Infinity)).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    console.log(`已删除。日常同步只回看最近 7 天；更早的日期用 IFIND_DAILY_START_DATE=${from} 手动跑一次 sync:ifind`);
  }
} finally { db.close(); }
