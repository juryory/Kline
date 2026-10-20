// iFinD 经济数据库 → ifind_macro 表，字段名与 tushare 的 macro 一致（见 shared/macro.js 的 MACRO_EDB）。
// 首次拉 IFIND_MACRO_YEARS 年；之后从已有最新一期往前回看一段，覆盖统计局修订值。
// 回看会重复取一段，所以每天只拉一次（盘后同步每 15 分钟一轮，force = true 时强制）。
import { tx } from './db.js';
import { chinaDate } from './ifind-client.js';
import { MACRO_DATASETS, MACRO_EDB, edbPeriod } from '../shared/macro.js';

const LOOKBACK_DAYS = { daily: 30, month: 400, quarter: 800 };

/** period 对应的第一天：20261020 / 202609 / 2026Q3 → 'YYYY-MM-DD' */
function periodStart(period) {
  const q = /^(\d{4})Q([1-4])$/.exec(period);
  if (q) return `${q[1]}-${String((q[2] - 1) * 3 + 1).padStart(2, '0')}-01`;
  return `${period.slice(0, 4)}-${period.slice(4, 6)}-${period.slice(6, 8) || '01'}`;
}

export async function syncIfindMacro({ db, client, now = Date.now(), log = console.log,
  years = Number(process.env.IFIND_MACRO_YEARS || 5), force = false } = {}) {
  if (!Number.isInteger(years) || years < 1 || years > 50) throw new Error('IFIND_MACRO_YEARS 必须为 1—50 年');
  const end = chinaDate(now);
  if (!force && db.prepare("SELECT value FROM meta WHERE key = 'ifind_macro_day'").get()?.value === end) {
    return { skipped: true, rows: {}, cells: 0, failed: false, errors: [] };
  }
  const first = new Date(now + 8 * 3600_000); first.setUTCFullYear(first.getUTCFullYear() - years);
  const latest = db.prepare('SELECT MAX(period) AS p FROM ifind_macro WHERE dataset=?');
  const put = db.prepare('INSERT OR REPLACE INTO ifind_macro VALUES (?,?,?)');
  const result = { rows: {}, cells: 0, failed: false, errors: [] };
  for (const [key, { edbScale = 1, ...fields }] of Object.entries(MACRO_EDB)) {
    const kind = MACRO_DATASETS[key].kind;
    const has = latest.get(key)?.p;
    const start = has
      ? chinaDate(Math.min(Date.parse(`${periodStart(has)}T00:00:00+08:00`), now) - LOOKBACK_DAYS[kind] * 86400_000)
      : first.toISOString().slice(0, 10);
    try {
      const { series, cells } = await client.edb(Object.values(fields), start, end);
      if (Number.isFinite(cells)) result.cells += cells;
      const rows = new Map();
      for (const [field, id] of Object.entries(fields)) {
        for (const { time, value } of series[id] ?? []) {
          // 亿元 → 元：取整到分，避免 1.1787 * 1e8 这类浮点尾数
          const v = value == null || value === '' ? NaN
            : edbScale === 1 ? Number(value) : Math.round(Number(value) * edbScale * 100) / 100;
          if (!Number.isFinite(v)) continue;
          const period = edbPeriod(time, kind);
          if (!rows.has(period)) rows.set(period, {});
          rows.get(period)[field] = v;
        }
      }
      // 没返回数据时保留旧的
      tx(db, () => { for (const [period, data] of rows) put.run(key, period, JSON.stringify(data)); });
      result.rows[key] = rows.size;
    } catch (err) {
      result.failed = true;
      result.errors.push(`${key}：${err.message}`);
    }
  }
  if (!result.failed) db.prepare("INSERT OR REPLACE INTO meta VALUES ('ifind_macro_day', ?)").run(end);
  log(`[ifind] 宏观：${Object.entries(result.rows).map(([k, n]) => `${k} ${n}`).join(' · ')}，数据量 ${result.cells}`
    + (result.errors.length ? `；失败 ${result.errors.join('；')}` : ''));
  return result;
}
