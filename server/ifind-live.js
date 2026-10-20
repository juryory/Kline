// iFinD 盘中实时数据，全部按需：只有被访问的标的 / 排行才请求，不访问的不更新。
// - 排行：实时行情，一次请求取全部概念板块的最新价 / 涨跌幅 / 涨停家数（约 0.1 秒），IFIND_LIVE_RANK_MS（默认 1 分钟）内最多一次
// - 分时 / 分钟 K：高频接口增量取当天已走完的分钟，写进 ifind_minute；盘后同步看到完整的一天会跳过，不重复消耗
// - 日K：实时行情拼出今天这根，只在内存里，正式日线由盘后同步写入
// 午休、收盘后沿用当天数据，直到盘后同步把当天日线写进库。每次请求 3 秒超时，失败时用库里已有的数据。
// 用量记入本地周额度账本（lane fresh，kind realtime / live_minute）。
import { chinaDate, dateNumber, normalizeIfind } from './ifind-client.js';
import { quotaConfig, reserveWeekly, reconcileWeekly } from './ifind-budget.js';
import { writeIfind } from './ifind-store.js';

const TTL = +(process.env.IFIND_LIVE_RANK_MS || 60_000);
const TIMEOUT = 3000;
const FIELDS = 'tradeDate,tradeTime,latest,changeRatio,upLimitCount';
const BAR_FIELDS = 'tradeDate,open,high,low,latest,volume,amount';
const SYMBOL_TTL = 20_000; // 同一标的的分钟 / 日K 实时数据最短请求间隔

let last = null; // { day, date, time, quotes, at } 或 { day, closed: true }（今天休市）
let inflight = null;
let failedAt = 0; // 失败后 30 秒内不再请求，沿用已有结果

/** 北京时间的分钟数与星期 */
function clock(now) {
  const d = new Date(now + 8 * 3600_000);
  return { minute: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}
/** 连续竞价时段（含收盘后几分钟，取到收盘价） */
const inSession = (m) => (m >= 570 && m <= 692) || (m >= 780 && m <= 905);

/** 交易阶段（北京时间，不含节假日判断）：closed 周末 / pre 开盘前 / session 交易中 / lunch 午休 / post 收盘后 */
export function marketPhase(now = Date.now()) {
  const { minute, weekday } = clock(now);
  if (weekday === 0 || weekday === 6) return 'closed';
  if (minute < 570) return 'pre';
  if (minute <= 690) return 'session';
  if (minute < 780) return 'lunch';
  if (minute <= 900) return 'session';
  return 'post';
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`iFinD ${label}超时`)), TIMEOUT); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 返回 { date, time, quotes: Map(code → { latest, changeRatio, upLimitCount }) }；
 * 不该请求或请求失败且没有当天结果时返回 null（调用方用盘后数据）
 */
export async function liveQuotes({ db, client, codes, now = Date.now(), quota = quotaConfig() }) {
  const { minute, weekday } = clock(now);
  const day = chinaDate(now);
  if (weekday === 0 || weekday === 6 || minute < 570) return null; // 周末、开盘前
  if (last?.day === day) {
    if (last.closed) return null; // 今天休市（节假日）
    if (!inSession(minute) || now - last.at < TTL) return last; // 午休 / 收盘后沿用；交易中按间隔刷新
  }
  if (now - failedAt < 30_000) return last?.day === day && !last.closed ? last : null;
  inflight ??= fetchQuotes({ db, client, codes, now, day, quota }).finally(() => { inflight = null; });
  try {
    return await inflight;
  } catch (err) {
    failedAt = now;
    console.error(`[ifind] 实时排行：${err.message}`);
    return last?.day === day && !last.closed ? last : null;
  }
}

async function fetchQuotes({ db, client, codes, now, day, quota }) {
  const estimate = codes.length * FIELDS.split(',').length;
  const week = quota.profile === 'trial' ? reserveWeekly(db, now, 'fresh', 'realtime', estimate, quota) : null;
  const { rows, cells } = await withTimeout(client.realtime(codes, FIELDS), '实时行情');
  if (week) reconcileWeekly(db, week, 'fresh', 'realtime', estimate, cells);
  const tradeDate = rows.find((r) => r.tradeDate)?.tradeDate;
  // 节假日接口返回上一个交易日的行情，不当作今天
  if (tradeDate !== day) {
    last = { day, closed: true };
    return null;
  }
  const quotes = new Map(rows.map((r) => [r.code, { latest: num(r.latest), changeRatio: num(r.changeRatio), upLimitCount: num(r.upLimitCount) }]));
  const time = rows.map((r) => r.tradeTime).filter(Boolean).sort().at(-1) ?? null;
  last = { day, date: dateNumber(day), time, quotes, at: now };
  return last;
}

// ---------------- 单个标的：分时 / 分钟 K / 日K ----------------

let calendar = null; // { day, dates: ['YYYY-MM-DD', …] } 最近两周的交易日，每天查一次（不消耗额度）

/** 该看的交易日：今天是交易日且已开盘 → 今天；否则最近一个已收盘的交易日。查不到日历时返回 null */
export async function liveDay({ client, now = Date.now() }) {
  const day = chinaDate(now);
  if (calendar?.day !== day) {
    const dates = await withTimeout(client.tradeDates(chinaDate(now - 14 * 86400_000), day), '交易日历');
    calendar = { day, dates };
  }
  const phase = marketPhase(now);
  if (calendar.dates.includes(day) && phase !== 'pre' && phase !== 'closed') return day;
  return calendar.dates.filter((d) => d < day).at(-1) ?? null;
}

const minuteState = new Map(); // code → { at, inflight }

/**
 * 补齐标的在当前交易日（盘中为今天）已走完的 1 分钟线，写进 ifind_minute。
 * 已存的部分不重取，只和上一根重叠一根（最后一根可能还在变）。返回是否请求过
 */
export async function refreshMinutes({ db, client, symbol, remote = { code: symbol.code }, now = Date.now(), quota = quotaConfig() }) {
  const state = minuteState.get(symbol.code);
  if (state?.inflight) return state.inflight;
  if (state && now - state.at < SYMBOL_TTL) return false;
  const run = (async () => {
    const day = await liveDay({ client, now });
    if (!day) return false;
    const dayStart = Date.parse(`${day}T09:30:00+08:00`), dayEnd = Date.parse(`${day}T15:00:00+08:00`);
    const lastTs = db.prepare('SELECT MAX(ts) AS ts FROM ifind_minute WHERE code = ? AND ts BETWEEN ? AND ?')
      .get(symbol.code, dayStart, dayEnd)?.ts;
    const from = lastTs ?? dayStart;
    const until = Math.min(Math.floor(now / 60_000) * 60_000 - 60_000, dayEnd);
    if (lastTs === dayEnd || until <= from) return false; // 当天已取全 / 没有新走完的分钟
    // 午休：上午已取到 11:30，下午还没开始
    if (from >= Date.parse(`${day}T11:30:00+08:00`) && until < Date.parse(`${day}T13:01:00+08:00`)) return false;
    const minutes = Math.round((until - from) / 60_000) + 1;
    const estimate = 6 * Math.min(242, minutes);
    const week = quota.profile === 'trial' ? reserveWeekly(db, now, 'fresh', 'live_minute', estimate, quota) : null;
    const hm = (ts) => new Date(ts + 8 * 3600_000).toISOString().slice(11, 19);
    const { rows, cells } = await withTimeout(client.query('minute', [remote.code], day, { from: hm(from), to: hm(until) }), '分时');
    if (week) reconcileWeekly(db, week, 'fresh', 'live_minute', estimate, cells);
    const bars = [];
    for (const row of rows) {
      if (row.code !== remote.code) continue;
      const bar = normalizeIfind(row, 'minute', { ...remote, volumeUnit: remote.volumeUnit ?? 'share' });
      const t = String(row.time).slice(11, 16);
      if (!bar || bar.date !== dateNumber(day) || !(t >= '09:30' && t <= '11:30' || t >= '13:00' && t <= '15:00')) continue;
      bars.push(bar);
    }
    writeIfind(db, 'minute', symbol.code, bars);
    return true;
  })();
  minuteState.set(symbol.code, { at: now, inflight: run });
  try {
    return await run;
  } catch (err) {
    console.error(`[ifind] ${symbol.code} 实时分时：${err.message}`);
    return false;
  } finally {
    minuteState.set(symbol.code, { at: now });
  }
}

const barState = new Map(); // code → { at, bar, inflight }

/** 今天这根日K（实时行情拼成，不入库）：{ date, timestamp, open, high, low, close, volume 手, turnover 元 }；拿不到返回 null */
export async function liveDailyBar({ db, client, symbol, remote = { code: symbol.code }, now = Date.now(), quota = quotaConfig() }) {
  const state = barState.get(symbol.code);
  if (state?.inflight) return state.inflight;
  if (state && now - state.at < SYMBOL_TTL) return state.bar;
  const run = (async () => {
    const day = await liveDay({ client, now });
    if (day !== chinaDate(now)) return null; // 今天不是交易日或还没开盘
    const estimate = BAR_FIELDS.split(',').length;
    const week = quota.profile === 'trial' ? reserveWeekly(db, now, 'fresh', 'realtime', estimate, quota) : null;
    const { rows, cells } = await withTimeout(client.realtime([remote.code], BAR_FIELDS), '实时行情');
    if (week) reconcileWeekly(db, week, 'fresh', 'realtime', estimate, cells);
    const r = rows.find((x) => x.code === remote.code);
    if (r?.tradeDate !== day) return null;
    // 实时行情的成交量单位是手、成交额是元（各品种已核对）
    const [open, high, low, close, volume, turnover] = [r.open, r.high, r.low, r.latest, r.volume, r.amount].map(num);
    if (![open, high, low, close].every((v) => v > 0)) return null; // 停牌、未开盘
    return { date: dateNumber(day), timestamp: Date.parse(`${day}T00:00:00+08:00`), open, high, low, close,
      volume: volume ?? 0, ...(turnover != null && { turnover }) };
  })();
  barState.set(symbol.code, { at: now, bar: state?.bar ?? null, inflight: run });
  let bar = null;
  try {
    bar = await run;
  } catch (err) {
    console.error(`[ifind] ${symbol.code} 实时日K：${err.message}`);
    bar = state?.bar ?? null;
  }
  barState.set(symbol.code, { at: now, bar });
  return bar;
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** 测试用：清掉缓存 */
export function resetLive() {
  last = null; inflight = null; failedAt = 0; calendar = null;
  minuteState.clear(); barState.clear();
}
