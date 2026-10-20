import fs from 'node:fs';
import { BUILTIN_INDICES } from './symbols.js';
import { tx } from './db.js';
import { initIfind, writeIfind } from './ifind-store.js';
import { createIfindClient, chinaDate, dateNumber, normalizeIfind } from './ifind-client.js';
import { quotaConfig, reserveWeekly, reconcileWeekly, validateQuota } from './ifind-budget.js';
import { isIfindDomestic } from '../shared/periods.js';

export const isDomesticSymbol = isIfindDomestic;
export const isMinuteIndex = (s) => isDomesticSymbol(s) && ['index', 'etf'].includes(s.type);
export function loadExtraSymbols(file = process.env.IFIND_UNIVERSE_FILE) {
  if (!file) return [];
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('IFIND_UNIVERSE_FILE 应为标的数组');
  const enabled = rows.filter(s => s.enabled === true);
  if (enabled.some(s => s.market !== 'CN' || !s.name || !isDomesticSymbol(s))) {
    throw new Error('当前仅能启用 CN 境内标的；海外和期货需先实现独立交易时段适配');
  }
  return enabled;
}
function completeMinuteDay(rows, day) {
  const times = new Set(rows.map(r => r.ts));
  for (const session of ['09:31:00', '13:01:00']) {
    const from = Date.parse(`${day}T${session}+08:00`);
    for (let i=0; i<120; i++) if (!times.has(from+i*60_000)) return false;
  }
  return true;
}
export function loadMappings(file = process.env.IFIND_CODE_MAP_FILE) {
  if (!file) return {};
  const mappings = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!mappings || Array.isArray(mappings) || typeof mappings !== 'object') throw new Error('iFinD 代码映射格式错误');
  for (const m of Object.values(mappings)) {
    if (!m || !/^[A-Za-z0-9.]+$/.test(m.code) || !['share', 'lot'].includes(m.volumeUnit ?? 'share')
      || !['yuan', 'thousand'].includes(m.amountUnit ?? 'yuan')) throw new Error('iFinD 映射的代码或单位无效');
  }
  return mappings;
}
export function remoteSymbol(symbol, mappings) {
  // 未经核实不推断供应商后缀；不同代码通过显式映射配置。
  return mappings[symbol.code] ?? { code: symbol.code };
}
export function syncUniverse(db) {
  const extra = [...BUILTIN_INDICES, { code: '883418.TI', name: '微盘股指数', type: 'index' }, ...loadExtraSymbols()];
  const put = db.prepare('INSERT OR REPLACE INTO ifind_symbols VALUES (?,?,?,?)');
  for (const s of extra) put.run(s.code, s.name, s.type, s.category || null);
  return db.prepare(`SELECT * FROM ifind_symbols UNION ALL SELECT * FROM symbols s
    WHERE NOT EXISTS (SELECT 1 FROM ifind_symbols i WHERE i.code=s.code) ORDER BY code`).all();
}
export function reserveBudget(db, month, kind, cells, limit) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const used = db.prepare('SELECT cells FROM ifind_usage WHERE month=? AND kind=?').get(month, kind)?.cells ?? 0;
    if (used + cells > limit) throw new Error(`iFinD ${kind} 本地月度预算不足（已预留/使用 ${used}，上限 ${limit}）；保留断点，下月继续`);
    db.prepare(`INSERT INTO ifind_usage VALUES (?,?,?) ON CONFLICT(month,kind) DO UPDATE SET cells=cells+excluded.cells`)
      .run(month, kind, cells);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
function datesBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00+08:00`), end = Date.parse(`${to}T00:00:00+08:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || chinaDate(start) !== from || chinaDate(end) !== to
    || start > end || end - start > 100 * 366 * 86400_000) throw new Error('iFinD 起止日期无效');
  const dates = [];
  for (let t = start; t <= end; t += 86400_000) {
    const weekday = new Date(t + 8 * 3600_000).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(chinaDate(t));
  }
  return dates;
}

/** 完成项永久跳过；空/不完整项保持待补，不将整个批次标记成功。 */
export async function syncIfind({ db, client = createIfindClient(), now = Date.now(), log = console.log,
  startDate = process.env.IFIND_START_DATE, endDate = process.env.IFIND_END_DATE,
  dailyStartDate = process.env.IFIND_DAILY_START_DATE, minuteStartDate = process.env.IFIND_MINUTE_START_DATE,
  symbols, mappings = loadMappings(), dryRun = false,
  mode = 'daily', quota = quotaConfig(), maxRequests = Number(process.env.IFIND_MAX_REQUESTS || 2000),
  maxSeconds = Number(process.env.IFIND_MAX_SECONDS || 600),
  budgets = { daily: Number(process.env.IFIND_DAILY_BUDGET || 900000), minute: Number(process.env.IFIND_MINUTE_BUDGET || 1400000) },
} = {}) {
  const wallStart = Date.now();
  initIfind(db);
  validateQuota(quota);
  if (!['daily', 'history', 'intraday'].includes(mode)) throw new Error('iFinD 同步模式错误');
  if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) throw new Error('IFIND_MAX_REQUESTS 必须为正整数');
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new Error('IFIND_MAX_SECONDS 必须为正数');
  for (const budget of Object.values(budgets)) if (!Number.isFinite(budget) || budget <= 0) throw new Error('iFinD 月度预算必须为正数');
  symbols ??= syncUniverse(db);
  const filter = process.env.IFIND_SYMBOLS?.split(',').map((s) => s.trim()).filter(Boolean);
  if (filter?.length) symbols = symbols.filter((s) => filter.includes(s.code));
  if (filter?.length && !symbols.length) throw new Error('IFIND_SYMBOLS 没有匹配到任何本地代码');
  if (mode === 'intraday' && process.env.IFIND_INTRADAY_SYMBOLS) {
    const codes = process.env.IFIND_INTRADAY_SYMBOLS.split(',').map(s=>s.trim());
    symbols = symbols.filter(s=>codes.includes(s.code));
  }
  const unsupported = symbols.filter(s => !isDomesticSymbol(s)).map(s=>s.code);
  symbols = symbols.filter(isDomesticSymbol);
  const hour = new Date(now + 8 * 3600_000).getUTCHours();
  // 不保存盘中未完成的日线/分钟为已完成，18 点以前只同步前一日。
  const cutoff = chinaDate(now - (mode !== 'intraday' && hour < 18 ? 86400_000 : 0));
  const end = endDate || cutoff;
  if (end > cutoff) throw new Error('只允许同步已收盘日期；18 点前截止到前一天');
  if (mode === 'intraday' && end !== chinaDate(now)) throw new Error('盘中模式只允许当天日期');
  const starts = {}, datesByKind = {};
  const yearsAgo = (years) => {
    const d = new Date(now + 8*3600_000); d.setUTCFullYear(d.getUTCFullYear()-years); return d.toISOString().slice(0,10);
  };
  const stockStart = yearsAgo(3);
  const dailyYears = Number(process.env.IFIND_HISTORY_YEARS || 5);
  if (!Number.isInteger(dailyYears) || dailyYears < 1 || dailyYears > 100) throw new Error('IFIND_HISTORY_YEARS 必须为 1—100 年，按账号历史权限设置');
  const earliestDaily = yearsAgo(dailyYears);
  const halfYear = new Date(now + 8*3600_000); halfYear.setUTCMonth(halfYear.getUTCMonth()-6);
  for (const kind of ['daily', 'minute']) {
    starts[kind] = mode === 'intraday' ? end : (kind === 'daily' ? dailyStartDate : minuteStartDate) || startDate
      || (mode === 'history' ? (kind === 'daily' ? earliestDaily : halfYear.toISOString().slice(0,10)) : chinaDate(now - 6 * 86400_000));
    if (kind === 'daily' && starts[kind] < earliestDaily) throw new Error('日线起点超出 IFIND_HISTORY_YEARS 配置的历史权限；更早已有数据继续从旧库读取');
    if (kind === 'minute' && starts[kind] < yearsAgo(1)) throw new Error('分时起点超过一年，请先确认账号权限后分段处理');
    // 新数据优先，补历史时不会因额度用完而漏掉今天。
    datesByKind[kind] = datesBetween(starts[kind], end).reverse();
  }
  const result = { mode, daily: 0, minute: 0, requests: 0, estimatedCells: 0, pending: 0, reusedDaily: 0, unsupported, deferred: false, errors: [], starts, end };
  if (unsupported.length) result.errors.push(`${unsupported.length} 个标的不在已实现的境内范围，未请求；见 unsupported 清单`);
  const progress = db.prepare('SELECT complete,attempted_at FROM ifind_progress WHERE kind=? AND code=? AND date=?');
  const mark = db.prepare('INSERT OR REPLACE INTO ifind_progress VALUES (?,?,?,?,?)');
  log(`[ifind] ${mode} 日线 ${starts.daily} 起 ${symbols.length} 个；分时 ${starts.minute} 起 ${symbols.filter(isMinuteIndex).length} 个境内指数/板块/ETF；截止 ${end}，个股不拉分时`);
  const oldDaily = db.prepare('SELECT 1 FROM daily WHERE code=? AND date=?');
  const lastMinute = db.prepare('SELECT MAX(ts) AS ts FROM ifind_minute WHERE code=? AND ts>=? AND ts<=?');
  const savedTimes = db.prepare('SELECT ts FROM ifind_minute WHERE code=? AND ts BETWEEN ? AND ?');
  // 日线先补昨收，避免分钟已有数据却不能显示；盘中只获取已结束的分钟。
  for (const kind of mode === 'intraday' ? ['minute'] : ['daily', 'minute']) {
    const pool = kind === 'minute' ? symbols.filter(isMinuteIndex) : symbols;
    const batchSize = kind === 'minute' ? 20 : 100;
    let stopped = false;
    for (const day of datesByKind[kind]) {
      if (stopped) break;
      const date = dateNumber(day);
      const todo = pool.filter((s) => {
        if (kind === 'daily' && s.type === 'stock' && day < stockStart) return false;
        if (kind === 'daily' && mode === 'history' && oldDaily.get(s.code, date)) { result.reusedDaily++; return false; }
        const p = progress.get(kind, s.code, date);
        if (kind === 'minute' && mode !== 'intraday' && !p?.complete) {
          const from = Date.parse(`${day}T09:30:00+08:00`), to = Date.parse(`${day}T15:00:00+08:00`);
          if (completeMinuteDay(savedTimes.all(s.code, from, to), day)) {
            if (!dryRun) mark.run(kind, s.code, date, 1, now);
            return false;
          }
        }
        const retryAfter = mode === 'intraday' ? 50_000 : day < chinaDate(now - 7 * 86400_000) ? 86400_000 : 14 * 60_000;
        return !p?.complete && (!p || now - p.attempted_at >= retryAfter);
      });
      for (let i = 0; i < todo.length; i += batchSize) {
        if (result.requests >= maxRequests || !dryRun && Date.now()-wallStart >= maxSeconds*1000) {
          result.deferred = true; stopped = true; break;
        }
        const batch = todo.slice(i, i + batchSize);
        const remote = new Map(batch.map((s) => [remoteSymbol(s, mappings).code, s]));
        if (remote.size !== batch.length) throw new Error('iFinD 代码映射冲突，同批次多个本地代码映射到同一远程代码');
        let window;
        if (mode === 'intraday') {
          const dayStart = Date.parse(`${day}T09:30:00+08:00`), dayEnd = Date.parse(`${day}T15:00:00+08:00`);
          const from = Math.min(...batch.map(s => {
            const ts = lastMinute.get(s.code, dayStart, dayEnd)?.ts;
            return ts ? ts+60_000 : dayStart;
          }));
          const until = Math.min(Math.floor(now/60_000)*60_000 - 60_000, dayEnd);
          if (until < from) continue;
          const hm = ts => new Date(ts + 8*3600_000).toISOString().slice(11,19);
          window = { from: hm(from), to: hm(until) };
        }
        const estimatedMinutes = window
          ? Math.min(242, Math.ceil((Date.parse(`${day}T${window.to}+08:00`)-Date.parse(`${day}T${window.from}+08:00`))/60_000)+1) : 242;
        const estimate = batch.length * 6 * (kind === 'minute' ? estimatedMinutes : 1);
        result.estimatedCells += estimate;
        if (dryRun) { result.requests++; continue; }
        const budgetNow = now + Date.now() - wallStart;
        const month = chinaDate(budgetNow).slice(0, 7);
        const lane = mode === 'history' ? 'history' : 'fresh';
        let week;
        try {
          if (quota.profile === 'trial') week = reserveWeekly(db, budgetNow, lane, kind, estimate, quota);
          else reserveBudget(db, month, kind, estimate, budgets[kind]);
        }
        catch (err) { result.errors.push(err.message); log(err.message); stopped = true; break; }
        let response;
        try {
          result.requests++;
          response = await client.query(kind, [...remote.keys()], day, window);
          // 正常响应按 dataVol 校正。请求中断仍保留预留量，避免重复消耗失去记录。
          if (quota.profile === 'trial') reconcileWeekly(db, week, lane, kind, estimate, response.cells);
          else if (Number.isSafeInteger(response.cells) && response.cells >= 0) {
            db.prepare('UPDATE ifind_usage SET cells=cells+? WHERE month=? AND kind=?')
              .run(response.cells - estimate, month, kind);
          }
        } catch (err) {
          result.errors.push(err.message); log(`[ifind] ${kind} ${day}：${err.message}`);
          // 权限/格式/网络异常停止该类型，防止全市场反复请求；另一类型仍可继续。
          stopped = true; break;
        }
        const grouped = new Map();
        for (const row of response.rows) {
          const s = remote.get(row.code);
          if (!s) continue;
          const normalized = normalizeIfind(row, kind, { ...remoteSymbol(s, mappings), allowMissingAmount: kind === 'daily' && s.type === 'index' && !!s.category });
          if (!normalized || normalized.date !== date) continue;
          if (kind === 'minute') {
            const hm = String(row.time).slice(11, 16);
            if (!(hm >= '09:30' && hm <= '11:30' || hm >= '13:00' && hm <= '15:00')) continue;
          }
          if (!grouped.has(s.code)) grouped.set(s.code, new Map());
          grouped.get(s.code).set(normalized.ts, normalized);
        }
        tx(db, () => {
          for (const s of batch) {
            const rows = [...(grouped.get(s.code)?.values() ?? [])].sort((a,b) => a.ts-b.ts);
            // 指数正常全天至少 240 根；缺根/截断保留数据但继续补。
            const complete = mode === 'intraday' ? false : kind === 'daily' ? rows.length === 1 : completeMinuteDay(rows, day);
            writeIfind(db, kind, s.code, rows);
            mark.run(kind, s.code, date, complete ? 1 : 0, now);
            result[kind] += rows.length;
            if (!complete && mode !== 'intraday') result.pending++;
          }
        });
        log(`[ifind] ${kind} ${day} ${Math.min(i+batchSize,todo.length)}/${todo.length}，累计写入 ${result[kind]} 行`);
      }
    }
  }
  if (result.pending) result.errors.push(`${result.pending} 个标的/日期未完整返回，已保留待补状态（休市/停牌日期也可能为空）`);
  log(`[ifind] ${dryRun ? '计划' : '完成'}：${JSON.stringify(result)}`);
  return result;
}
