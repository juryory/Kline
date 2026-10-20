// 分钟历史补全：按批次（核心指数 → 同花顺概念 → 行业 / 申万一级 → 活跃 ETF）补最近 IFIND_BACKFILL_MONTHS 个月。
// 核心指数先补 IFIND_HISTORY_YEARS 年 iFinD 日线，替换 Tushare 历史（深证成指等的成交额口径前后一致）。
// 批内从最近的日期往前，每次请求 BATCH_CODES 个标的 × 至多 CHUNK_DAYS 个交易日。
// 额度两道闸：本机周账本的补历史上限（IFIND_BACKFILL_WEEKLY），以及官方统计的本周用量停止线（含其他终端）。
// 每个写入的完整交易日都和 iFinD 日线核对（15:00 收盘价、全天成交额和成交量），不一致的记入 ifind_backfill_issues，
// 一轮内不一致过多时暂停补历史，等人工确认后用 --resume 继续。
import { tx } from './db.js';
import { BUILTIN_INDICES } from './symbols.js';
import { chinaDate, dateNumber, normalizeIfind } from './ifind-client.js';
import { quotaConfig, reserveWeekly, reconcileWeekly } from './ifind-budget.js';
import { initIfind, writeIfind, noMinuteCodes, flagNoMinute } from './ifind-store.js';
import { syncIfind, syncUniverse, completeMinuteDay, loadMappings, remoteSymbol } from './ifind-sync.js';
import { isIfindDomestic } from '../shared/periods.js';

export const BACKFILL_BATCHES = [
  { key: 'core', label: '核心指数' },
  { key: 'concept', label: '同花顺概念' },
  { key: 'industry', label: '同花顺行业 / 申万一级' },
  { key: 'etf', label: '活跃 ETF' },
];
const CHUNK_DAYS = 10;
const BATCH_CODES = 5;
const BARS = 241; // 09:30—11:30、13:01—15:00
const CELLS_PER_DAY = BARS * 6;
const OFFICIAL_RECHECK_MS = 5 * 60_000;
const DAILY_CHUNK_DAYS = 250; // 核心指数日线每次请求约一年
const DAILY_CELLS = 6;

export function backfillConfig({ drain = false, env = process.env } = {}) {
  const num = (key, def) => Number(env[key] || def);
  const quota = quotaConfig();
  const cfg = {
    months: num('IFIND_BACKFILL_MONTHS', 6),
    weekly: num('IFIND_BACKFILL_WEEKLY', 50_000_000),
    stop: drain ? num('IFIND_BACKFILL_DRAIN_STOP', 145_000_000) : num('IFIND_BACKFILL_STOP', 100_000_000),
    etfTop: num('IFIND_BACKFILL_ETF_TOP', 300),
    dailyYears: num('IFIND_HISTORY_YEARS', 5),
    // 这几个核心指数的 iFinD 日线补全历史（旧库有的每一天），不止 IFIND_HISTORY_YEARS 年；设为空不补
    fullHistory: (env.IFIND_FULL_HISTORY ?? '399001.SZ,399006.SZ').split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (!Number.isInteger(cfg.months) || cfg.months < 1 || cfg.months > 12) throw new Error('IFIND_BACKFILL_MONTHS 必须为 1—12');
  if (!Number.isInteger(cfg.dailyYears) || cfg.dailyYears < 1 || cfg.dailyYears > 100) throw new Error('IFIND_HISTORY_YEARS 必须为 1—100 年');
  if (!(cfg.stop > 0 && cfg.stop < quota.total)) throw new Error('补历史停止线必须小于 IFIND_WEEKLY_BUDGET');
  // 补满：放开本机补历史上限，只留 总额 − 停止线 作为保留额度；平时用 IFIND_BACKFILL_WEEKLY
  cfg.quota = drain ? { ...quota, reserve: quota.total - cfg.stop, history: cfg.stop }
    : { ...quota, history: Math.min(cfg.weekly, quota.total - quota.reserve) };
  return cfg;
}

const toMinutes = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
/** 是否在补历史时段（按本机时区）：周末全天；工作日按 window（如 21:30-08:30），可跨零点 */
export function inBackfillWindow(date, window) {
  if (date.getDay() === 0 || date.getDay() === 6) return true;
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(window);
  if (!m) return false;
  const [from, to] = [toMinutes(m[1]), toMinutes(m[2])], now = date.getHours() * 60 + date.getMinutes();
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

export function backfillStart(now, months) {
  const d = new Date(now + 8 * 3600_000); d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}
/** 核心指数日线起点：IFIND_HISTORY_YEARS 年前 */
export function dailyStart(now, years) {
  const d = new Date(now + 8 * 3600_000); d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}
/** 交易日历从这天取起（分钟、日线两个起点中更早的） */
export const calendarStart = (now, cfg) => [backfillStart(now, cfg.months), dailyStart(now, cfg.dailyYears)].sort()[0];

const meta = (db, key) => { const v = db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; return v ? JSON.parse(v) : null; };
const setMeta = (db, key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value));

/** 交易日（升序，'YYYY-MM-DD'），每天从接口取一次（不耗额度）存在 meta */
export async function tradingCalendar(db, client, start, now) {
  const today = chinaDate(now);
  const cached = meta(db, 'ifind_backfill_calendar');
  if (cached?.day === today && cached.start <= start) return cached.dates.filter((d) => d >= start);
  const dates = (await client.tradeDates(start, today)).map((d) => d.slice(0, 10)).sort();
  if (!dates.length) throw new Error('iFinD 交易日历为空');
  setMeta(db, 'ifind_backfill_calendar', { day: today, start, dates });
  return dates;
}

/** 活跃 ETF：首次用到时按前 20 个交易日平均成交额选出，之后固定 */
function activeEtfs(db, top, now) {
  const saved = meta(db, 'ifind_backfill_etf');
  if (saved) return saved.codes;
  const dates = db.prepare('SELECT DISTINCT date FROM merged_daily WHERE code=? ORDER BY date DESC LIMIT 20').all('000001.SH');
  if (dates.length < 20) throw new Error('上证指数日线不足 20 天，无法选出活跃 ETF');
  const from = dates.at(-1).date;
  const avg = db.prepare('SELECT AVG(amount) AS a FROM merged_daily WHERE code=? AND date>=?');
  const codes = db.prepare("SELECT code FROM symbols WHERE type='etf'").all()
    .map(({ code }) => ({ code, a: avg.get(code, from)?.a ?? 0 })).filter((r) => r.a > 0)
    .sort((a, b) => b.a - a.a).slice(0, top).map((r) => r.code).sort();
  setMeta(db, 'ifind_backfill_etf', { at: now, from, codes });
  return codes;
}

/** 各批次的标的（已去掉没有分钟数据的），stored = 只用已选定的 ETF 名单（展示进度时不现场挑选） */
export function batchSymbols(db, key, { now = Date.now(), etfTop = 300, stored = false } = {}) {
  const skip = noMinuteCodes(db, now);
  const all = new Map(db.prepare('SELECT * FROM symbols').all().map((s) => [s.code, s]));
  // iFinD 不支持的代码（如中证 932000.CSI）不请求
  const pick = (codes) => [...new Set(codes)].map((c) => all.get(c)).filter((s) => s && !skip.has(s.code) && isIfindDomestic(s));
  if (key === 'core') {
    const builtin = [...BUILTIN_INDICES.map((s) => s.code), '883418.TI'];
    return pick([...builtin, ...[...all.values()].filter((s) => s.type === 'index' && !s.category).map((s) => s.code).sort()]);
  }
  if (key === 'concept') {
    const boards = db.prepare("SELECT DISTINCT code FROM ifind_boards WHERE list='THN' AND code IS NOT NULL ORDER BY code").all();
    return pick(boards.length ? boards.map((r) => r.code)
      : [...all.values()].filter((s) => s.category === 'THN').map((s) => s.code).sort());
  }
  if (key === 'industry') {
    const of = (cat) => [...all.values()].filter((s) => s.category === cat).map((s) => s.code).sort();
    return pick([...of('SW1'), ...of('THI')]);
  }
  if (key === 'etf') return pick(stored ? meta(db, 'ifind_backfill_etf')?.codes ?? [] : activeEtfs(db, etfTop, now));
  throw new Error(`未知补历史批次 ${key}`);
}

/**
 * 用日线核对一天分钟：15:00 收盘价，成交额、成交量汇总（日线 千元 / 手，分钟 元 / 股）。
 * 只和 iFinD 日线比成交额、成交量：Tushare 深证成指、创业板指等的成交额只算成分股，口径不同
 */
export function checkMinuteDay(rows, bar) {
  if (!bar || !rows.length) return null;
  const close = rows.at(-1).close;
  if (Math.abs(close - bar.close) > Math.max(0.0015, bar.close * 0.0005)) return `收盘 分钟 ${close} / 日线 ${bar.close}`;
  for (const [field, label, unit] of [['amount', '成交额', 1000], ['vol', '成交量', 100]]) {
    if (!(bar[field] > 0)) continue;
    const r = rows.reduce((n, x) => n + (x[field] || 0), 0) / (bar[field] * unit);
    if (r < 0.95 || r > 1.05) return `${label} 分钟汇总/日线 = ${r.toFixed(3)}`;
  }
  return null;
}

const tradingRows = (rows) => rows.filter((r) => {
  const hm = new Date(r.ts + 8 * 3600_000).toISOString().slice(11, 16);
  return hm >= '09:30' && hm <= '11:30' || hm >= '13:00' && hm <= '15:00';
});

/**
 * 每批完成情况：已尝试的「标的 × 交易日」/ 应补数（无数据的休市、停牌也算已尝试）。
 * 只读库，不访问接口；还没有交易日历（从没跑过）时返回 null。
 */
export function backfillStatus(db, { now = Date.now(), env = process.env } = {}) {
  initIfind(db);
  const cfg = backfillConfig({ env });
  const start = backfillStart(now, cfg.months), today = chinaDate(now);
  const cal = meta(db, 'ifind_backfill_calendar');
  if (!cal) return null;
  const days = cal.dates.filter((d) => d >= start && d < today);
  if (!days.length) return null;
  // 核心指数日线：日历还没取到那么早时（升级后第一轮之前）不显示
  const yearsFrom = dailyStart(now, cfg.dailyYears);
  let coreDaily = null;
  if (cal.start <= yearsFrom) {
    const dailyDays = cal.dates.filter((d) => d >= yearsFrom && d < today);
    const [a, b] = [dateNumber(dailyDays[0]), dateNumber(dailyDays.at(-1))];
    const have = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT date FROM ifind_progress WHERE kind='daily' AND code=? AND date BETWEEN ? AND ?
      UNION SELECT date FROM ifind_daily WHERE code=? AND date BETWEEN ? AND ?)`);
    const codes = batchSymbols(db, 'core', { now }).map((s) => s.code);
    coreDaily = { years: cfg.dailyYears, start: dailyDays[0], codes: codes.length, total: codes.length * dailyDays.length,
      done: codes.reduce((n, c) => n + Math.min(dailyDays.length, have.get(c, a, b, c, a, b).n), 0) };
    // 全历史的指数：更早的部分按旧库已有的日期算
    const older = db.prepare(`SELECT COUNT(*) AS n, SUM(EXISTS (SELECT 1 FROM ifind_progress p WHERE p.kind='daily' AND p.code=d.code AND p.date=d.date)
      OR EXISTS (SELECT 1 FROM ifind_daily i WHERE i.code=d.code AND i.date=d.date)) AS done FROM daily d WHERE code=? AND date<?`);
    coreDaily.fullHistory = cfg.fullHistory.filter((c) => codes.includes(c));
    for (const c of coreDaily.fullHistory) {
      const r = older.get(c, a);
      coreDaily.total += r.n; coreDaily.done += r.done ?? 0;
    }
  }
  const from = dateNumber(days[0]), to = dateNumber(days.at(-1));
  const count = db.prepare("SELECT COUNT(*) AS n FROM ifind_progress WHERE kind='minute' AND code=? AND date BETWEEN ? AND ?");
  let remaining = 0;
  const batches = BACKFILL_BATCHES.map(({ key, label }) => {
    const codes = batchSymbols(db, key, { now, stored: true }).map((s) => s.code);
    // ETF 名单要到这一批才选出，之前按 IFIND_BACKFILL_ETF_TOP 估算剩余量
    if (key === 'etf' && !codes.length) remaining += cfg.etfTop * days.length;
    const total = codes.length * days.length;
    const done = codes.reduce((n, c) => n + Math.min(days.length, count.get(c, from, to).n), 0);
    remaining += total - done;
    return { key, label, codes: codes.length, total, done, pending: key === 'etf' && !codes.length };
  });
  return { start: days[0], end: days.at(-1), days: days.length, batches, coreDaily,
    remainingCells: remaining * CELLS_PER_DAY + (coreDaily ? (coreDaily.total - coreDaily.done) * DAILY_CELLS : 0), paused: meta(db, 'ifind_backfill_paused'),
    issues: db.prepare('SELECT COUNT(*) AS n FROM ifind_backfill_issues').get().n,
    noMinute: noMinuteCodes(db, now).size, ...cfg, quota: undefined };
}

/**
 * 跑一轮补历史。stop 原因：done 全部补完 / time 本轮时间到 / budget 本机周上限 / official 官方用量到停止线 /
 * interrupted 手动中断 / paused 核对不一致已暂停 / error 接口异常
 */
export async function runBackfill({ db, client, now = Date.now(), log = console.log, drain = false, resume = false,
  maxSeconds = Number(process.env.IFIND_MAX_SECONDS || 600), shouldStop = () => false, env = process.env,
  mappings = loadMappings() } = {}) {
  const wallStart = Date.now();
  const clock = () => now + Date.now() - wallStart;
  initIfind(db);
  const cfg = backfillConfig({ drain, env });
  const result = { stop: null, requests: 0, cells: 0, dailyRows: 0, minuteRows: 0, checked: 0, issues: 0, failed: false, errors: [] };
  const finish = (stop) => {
    result.stop = stop;
    log(`[backfill] 本轮结束（${STOP_TEXT[stop] ?? stop}）：请求 ${result.requests} 次，数据量 ${result.cells}，`
      + (result.dailyRows ? `写入 ${result.dailyRows} 根核心指数日线，` : '')
      + `写入 ${result.minuteRows} 根分钟线，核对 ${result.checked} 天、不一致 ${result.issues} 天`
      + (result.errors.length ? `；${result.errors.join('；')}` : ''));
    return result;
  };
  if (resume) {
    db.prepare("DELETE FROM meta WHERE key='ifind_backfill_paused'").run();
    db.prepare('DELETE FROM ifind_backfill_issues').run();
  }
  const paused = meta(db, 'ifind_backfill_paused');
  if (paused) {
    result.errors.push(`已暂停：${paused.reason}；确认后运行 npm run sync:ifind -- --backfill --resume`);
    return finish('paused');
  }

  // 官方用量：开头查一次，之后每 5 分钟校正一次，中间按本轮实际数据量累加
  let official, officialAt = 0, cellsSince = 0;
  const refreshOfficial = async () => {
    official = (await client.dataVolume()).usage; officialAt = Date.now(); cellsSince = 0;
  };
  try { await refreshOfficial(); }
  catch (err) { result.failed = true; result.errors.push(`查询官方用量失败：${err.message}`); return finish('error'); }
  log(`[backfill] ${drain ? '补满' : '定时'}：官方本周已用 ${official.toLocaleString()}，停止线 ${cfg.stop.toLocaleString()}`
    + (drain ? '' : `；本机补历史上限 ${cfg.quota.history.toLocaleString()}`));
  if (official >= cfg.stop) return finish('official');

  syncUniverse(db);
  // 一次性：申万一级之前按 .SI 请求，全是空的「已尝试」记录，清掉让补历史重新取（.SL）
  if (!meta(db, 'ifind_backfill_sw_reset')) {
    db.prepare("DELETE FROM ifind_progress WHERE complete=0 AND code GLOB '801[0-9][0-9][0-9].SI'").run();
    setMeta(db, 'ifind_backfill_sw_reset', clock());
  }
  // 盘后同步已试过至少 3 个交易日、一根分钟都没有的指数：直接记为没有分钟数据，不用再逐个探测
  db.prepare(`INSERT OR IGNORE INTO ifind_no_minute SELECT s.code, ? FROM symbols s WHERE s.type='index'
    AND (SELECT COUNT(*) FROM ifind_progress p WHERE p.kind='minute' AND p.code=s.code) >= 3
    AND NOT EXISTS (SELECT 1 FROM ifind_minute m WHERE m.code=s.code)`).run(clock());
  const start = backfillStart(now, cfg.months), today = chinaDate(now);
  const calendar = (await tradingCalendar(db, client, calendarStart(now, cfg), now)).filter((d) => d < today).reverse(); // 新 → 旧
  const days = calendar.filter((d) => d >= start);
  const dailyDays = calendar.filter((d) => d >= dailyStart(now, cfg.dailyYears));
  const tradingDays = new Set(days);
  const progress = db.prepare("SELECT date FROM ifind_progress WHERE kind='minute' AND code=? AND date BETWEEN ? AND ?");
  const mark = db.prepare('INSERT OR REPLACE INTO ifind_progress VALUES (?,?,?,?,?)');
  const ifindBar = db.prepare('SELECT close, vol, amount FROM ifind_daily WHERE code=? AND date=?');
  const legacyBar = db.prepare('SELECT close FROM daily WHERE code=? AND date=?');
  const dailyBar = (code, date) => ifindBar.get(code, date) ?? legacyBar.get(code, date);
  const putIssue = db.prepare('INSERT OR REPLACE INTO ifind_backfill_issues VALUES (?,?,?,?)');
  const outOfTime = () => Date.now() - wallStart >= maxSeconds * 1000;
  const pause = (reason) => {
    setMeta(db, 'ifind_backfill_paused', { reason, at: clock() });
    result.failed = true; result.errors.push(reason);
    return 'paused';
  };

  // 两道额度闸 → 请求 → 按 dataVol 校正本机账本。返回 { response }；额度不够或接口异常时返回 { stop }
  async function request(kind, estimate, what, call) {
    if (Date.now() - officialAt >= OFFICIAL_RECHECK_MS) {
      try { await refreshOfficial(); } catch (err) { result.errors.push(err.message); return { stop: 'error' }; }
    }
    if (official + cellsSince + estimate > cfg.stop) return { stop: 'official' };
    let week;
    try { week = reserveWeekly(db, clock(), 'history', kind, estimate, cfg.quota); }
    catch (err) { result.errors.push(err.message); return { stop: 'budget' }; }
    let response;
    try {
      result.requests++;
      response = await call();
      reconcileWeekly(db, week, 'history', kind, estimate, response.cells);
    } catch (err) {
      result.failed = true; result.errors.push(`${what}：${err.message}`);
      return { stop: 'error' };
    }
    const used = Number.isFinite(response.cells) ? response.cells : estimate;
    result.cells += used; cellsSince += used;
    return { response };
  }

  /**
   * 核心指数 IFIND_HISTORY_YEARS 年 iFinD 日线，替换 Tushare 历史：Tushare 深证成指、创业板指等的成交额只算成分股，
   * 和 iFinD 口径不同，切换处成交额会跳 2—3 倍。收盘价和 Tushare 核对，一次请求里不一致过多时不写入、暂停。
   * 返回停止原因；补完返回 null
   */
  async function coreDaily(symbols) {
    if (!dailyDays.length) return null;
    const from = dateNumber(dailyDays.at(-1));
    const have = db.prepare(`SELECT date FROM ifind_progress WHERE kind='daily' AND code=?
      UNION SELECT date FROM ifind_daily WHERE code=?`);
    const legacyClose = db.prepare('SELECT close FROM daily WHERE code=? AND date=?');
    // 全历史的指数：更早的交易日取旧库已有的日期（不用再取几十年的交易日历）
    const older = db.prepare('SELECT date FROM daily WHERE code=? AND date<? ORDER BY date DESC');
    const iso = (n) => String(n).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    const missing = new Map(symbols.map((s) => {
      const got = new Set(have.all(s.code, s.code).map((r) => r.date));
      const wanted = cfg.fullHistory.includes(s.code) ? [...dailyDays, ...older.all(s.code, from).map((r) => iso(r.date))] : dailyDays;
      return [s.code, new Set(wanted.filter((d) => !got.has(dateNumber(d))))];
    }));
    if (![...missing.values()].some((m) => m.size)) return null;
    const allDays = [...new Set([...missing.values()].flatMap((m) => [...m]))].sort().reverse(); // 新 → 旧
    for (let c = 0; c < allDays.length; c += DAILY_CHUNK_DAYS) {
      const chunk = allDays.slice(c, c + DAILY_CHUNK_DAYS);
      const groups = new Map();
      for (const s of symbols) {
        const miss = chunk.filter((d) => missing.get(s.code).has(d));
        if (!miss.length) continue;
        const span = `${miss.at(-1)}|${miss[0]}`;
        if (!groups.has(span)) groups.set(span, []);
        groups.get(span).push(s);
      }
      for (const [span, list] of groups) {
        if (shouldStop()) return 'interrupted';
        if (outOfTime()) return 'time';
        const [first, last] = span.split('|');
        const spanDays = chunk.filter((d) => d >= first && d <= last);
        const remote = new Map(list.map((s) => [remoteSymbol(s, mappings).code, s]));
        const { response, stop } = await request('daily', list.length * spanDays.length * DAILY_CELLS,
          `核心指数日线 ${first}—${last}`, () => client.dailyRange([...remote.keys()], first, last));
        if (stop) return stop;
        const got = new Map(), issues = [];
        let compared = 0;
        for (const row of response.rows) {
          const s = remote.get(row.code);
          if (!s) continue;
          const rmt = remoteSymbol(s, mappings);
          // 指数日线成交量单位是手，和盘后同步一致
          const bar = normalizeIfind(row, 'daily', { ...rmt, volumeUnit: rmt.volumeUnit ?? 'lot', allowMissingAmount: !!s.category });
          const day = bar && chinaDate(bar.ts);
          if (!bar || !missing.get(s.code).has(day) || !spanDays.includes(day)) continue;
          if (!got.has(s.code)) got.set(s.code, new Map());
          got.get(s.code).set(day, bar);
          const old = legacyClose.get(s.code, bar.date);
          if (!old) continue;
          compared++;
          if (Math.abs(bar.close - old.close) > Math.max(0.0015, old.close * 0.0005)) {
            issues.push([s.code, bar.date, `日线收盘 iFinD ${bar.close} / Tushare ${old.close}`]);
          }
        }
        if (issues.length >= 5 && issues.length > compared * 0.02) {
          for (const [code, date, detail] of issues) putIssue.run(code, date, detail, clock());
          return pause(`核心指数日线 ${first}—${last} 收盘和 Tushare 不一致 ${issues.length} / ${compared} 天，未写入（详见 ifind_backfill_issues）`);
        }
        tx(db, () => {
          for (const s of list) for (const day of spanDays) {
            if (!missing.get(s.code).has(day)) continue;
            const bar = got.get(s.code)?.get(day);
            // 没有返回的（指数发布前、停牌）记为已尝试，这些天照旧用 Tushare
            if (bar) writeIfind(db, 'daily', s.code, [bar]);
            mark.run('daily', s.code, dateNumber(day), bar ? 1 : 0, clock());
            if (bar) result.dailyRows++;
          }
          for (const [code, date, detail] of issues) putIssue.run(code, date, detail, clock());
        });
        result.issues += issues.length;
        for (const [code, date, detail] of issues) log(`[backfill] 核对不一致：${code} ${date} ${detail}`);
        log(`[backfill] 核心指数日线 ${first}—${last}：${list.length} 个标的，累计写入 ${result.dailyRows} 根`);
      }
    }
    const full = symbols.filter((s) => cfg.fullHistory.includes(s.code)).map((s) => s.name);
    log(`[backfill] 核心指数 ${cfg.dailyYears} 年日线已补完（${dailyDays.at(-1)} 起${full.length ? `；${full.join('、')} 全历史` : ''}）`);
    return null;
  }

  // IFIND_SYMBOLS：只补指定代码（上线前小样本验证）
  const only = env.IFIND_SYMBOLS?.split(',').map((s) => s.trim()).filter(Boolean);
  for (const { key, label } of BACKFILL_BATCHES) {
    let symbols = batchSymbols(db, key, { now, etfTop: cfg.etfTop });
    if (only?.length) symbols = symbols.filter((s) => only.includes(s.code));
    if (!symbols.length) continue;
    if (key === 'core') {
      const stop = await coreDaily(symbols);
      if (stop) return finish(stop);
    }
    // 同期 iFinD 日线（不复用 Tushare，口径和分钟一致才能核对）：每个标的日 7 个数据量
    const daily = await syncIfind({ db, client, now: clock(), log: () => {}, mode: 'history', kinds: ['daily'], symbols,
      dailyStartDate: start, tradingDays, reuseLegacy: false, quota: cfg.quota, mappings,
      maxSeconds: Math.min(86400, Math.max(1, maxSeconds - (Date.now() - wallStart) / 1000)) });
    result.requests += daily.requests; result.cells += daily.estimatedCells; cellsSince += daily.estimatedCells;
    if (daily.failed) {
      result.errors.push(...daily.errors.slice(0, 2));
      return finish(daily.errors.some((e) => e.includes('预算')) ? 'budget' : 'error');
    }
    if (daily.deferred) return finish('time');

    let batchChecked = 0, batchIssues = 0, todoDays = 0;
    for (let c = 0; c < days.length; c += CHUNK_DAYS) {
      const chunk = days.slice(c, c + CHUNK_DAYS);
      const from = dateNumber(chunk.at(-1)), to = dateNumber(chunk[0]);
      // 每个标的在这段里缺的交易日；按缺的起止日期分组，同组一起请求
      const groups = new Map();
      for (const s of symbols) {
        const have = new Set(progress.all(s.code, from, to).map((r) => r.date));
        const missing = chunk.filter((d) => !have.has(dateNumber(d)));
        if (!missing.length) continue;
        todoDays += missing.length;
        const span = `${missing.at(-1)}|${missing[0]}`;
        if (!groups.has(span)) groups.set(span, []);
        groups.get(span).push(s);
      }
      for (const [span, list] of groups) {
        const [first, last] = span.split('|');
        const spanDays = chunk.filter((d) => d >= first && d <= last);
        for (let i = 0; i < list.length; i += BATCH_CODES) {
          if (shouldStop()) return finish('interrupted');
          if (outOfTime()) return finish('time');
          const batch = list.slice(i, i + BATCH_CODES);
          const remote = new Map(batch.map((s) => [remoteSymbol(s, mappings).code, s]));
          const { response, stop } = await request('minute', batch.length * spanDays.length * CELLS_PER_DAY,
            `${label} ${first}—${last}`, () => client.minuteRange([...remote.keys()], first, last));
          if (stop) return finish(stop);
          // 代码 → 日期 → 时间戳 → 分钟
          const got = new Map();
          for (const row of response.rows) {
            const s = remote.get(row.code);
            const bar = s && normalizeIfind(row, 'minute', remoteSymbol(s, mappings));
            if (!bar) continue;
            const day = chinaDate(bar.ts);
            if (!spanDays.includes(day)) continue;
            if (!got.has(s.code)) got.set(s.code, new Map());
            const byDay = got.get(s.code);
            if (!byDay.has(day)) byDay.set(day, new Map());
            byDay.get(day).set(bar.ts, bar);
          }
          const issues = [];
          tx(db, () => {
            for (const s of batch) {
              const byDay = got.get(s.code);
              // 整段交易日都为空：库里从没有过这个代码的分钟 → 没有分钟数据，以后跳过；否则是未上市 / 停牌，记为已尝试
              if (!byDay && flagNoMinute(db, s.code, clock())) {
                log(`[backfill] ${s.code} ${s.name} 没有分钟数据，以后跳过`);
                continue;
              }
              for (const day of spanDays) {
                const rows = tradingRows([...(byDay?.get(day)?.values() ?? [])].sort((a, b) => a.ts - b.ts));
                const complete = completeMinuteDay(rows, day);
                writeIfind(db, 'minute', s.code, rows);
                mark.run('minute', s.code, dateNumber(day), complete ? 1 : 0, clock());
                result.minuteRows += rows.length;
                if (!complete) continue;
                const problem = checkMinuteDay(rows, dailyBar(s.code, dateNumber(day)));
                result.checked++; batchChecked++;
                if (problem) {
                  putIssue.run(s.code, dateNumber(day), problem, clock());
                  issues.push(`${s.code} ${day} ${problem}`);
                }
              }
            }
          });
          result.issues += issues.length; batchIssues += issues.length;
          for (const text of issues) log(`[backfill] 核对不一致：${text}`);
          // 整批不一致过多（不是个别停牌 / 数据源修订），多半是单位或代码问题：暂停，等人工确认
          if (batchIssues >= 5 && batchIssues > batchChecked * 0.02) {
            return finish(pause(`${label} 核对不一致 ${batchIssues} / ${batchChecked} 天（详见 ifind_backfill_issues）`));
          }
        }
      }
      if (groups.size) log(`[backfill] ${label} ${chunk.at(-1)}—${chunk[0]}：${[...groups.values()].flat().length} 个标的，累计请求 ${result.requests} 次`);
    }
    log(`[backfill] ${label}：${symbols.length} 个标的已补完（${start} 起）${todoDays ? `，本轮补了 ${todoDays} 个标的日` : ''}`);
  }
  return finish('done');
}

const STOP_TEXT = { done: '全部补完', time: '本轮时间到，下轮继续', budget: '本机补历史周上限已到',
  official: '官方本周用量到停止线', interrupted: '手动中断', paused: '核对不一致，已暂停', error: '接口异常' };
