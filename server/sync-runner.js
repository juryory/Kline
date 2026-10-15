/**
 * 盘后同步：子进程跑 scripts/sync.js（tushare → 本地库），定时触发 + 每次运行留记录
 *
 * 定时（按容器时区 TZ 计时，只在 SYNC_DAYS 指定的星期执行）
 *   SYNC_WINDOW=15:30-23:30  时间窗口
 *   SYNC_EVERY=30            窗口内每隔多少分钟同步一次（从窗口开始算：15:30、16:00、16:30 …）；0 = 关闭
 *   SYNC_AT=09:00            另外再加的固定时刻（可多个，逗号分隔），可选
 *   SYNC_DAYS=1-5            周一到周五（0/7 = 周日；也可写 1,3,5）
 *   没有配置 TUSHARE_TOKEN 时不启用定时同步。
 *
 * 记录（都在本地库同目录，默认 data/）
 *   sync-history.jsonl  每次运行一行：触发方式、起止时间、结果、同步前后各数据集的最新日期、本次新到的数据
 *   sync-logs/*.log     每次运行的完整输出，保留最近 SYNC_LOG_KEEP 份（默认 500）
 *   控制台（docker logs）每次结束打印一行摘要，方便看「同花顺概念哪天几点更新」
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DB_PATH, openDb } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.dirname(DB_PATH);
const HISTORY_FILE = path.join(DATA_DIR, 'sync-history.jsonl');
const LOG_DIR = path.join(DATA_DIR, 'sync-logs');
const LOG_KEEP = +(process.env.SYNC_LOG_KEEP || 500);
const LIVE_LOG_LINES = 200;

// ---------------- 各数据集的最新日期 ----------------
// 某类板块的最新日期。逐个板块取 MAX（走主键），不要写成 daily JOIN symbols，那样会全表扫描 daily
const latestOfCategory = (cat) =>
  `SELECT MAX((SELECT MAX(date) FROM daily WHERE code = s.code)) AS d FROM symbols s WHERE s.category = '${cat}'`;

// 排名和直播画面依赖的数据，按「同花顺概念什么时候更新」这个问题挑的
export const DATASETS = [
  { key: 'stock', label: '个股日线', sql: "SELECT MAX(date) AS d FROM synced WHERE kind = 'daily'" },
  { key: 'etf', label: 'ETF日线', sql: "SELECT MAX(date) AS d FROM synced WHERE kind = 'etf_daily'" },
  { key: 'thn', label: '同花顺概念', sql: latestOfCategory('THN') },
  { key: 'thi', label: '同花顺行业', sql: latestOfCategory('THI') },
  { key: 'thsflow', label: '概念资金流', sql: 'SELECT MAX(date) AS d FROM board_flow' },
  { key: 'sw1', label: '申万一级', sql: latestOfCategory('SW1') },
  { key: 'limit', label: '涨停', sql: 'SELECT MAX(date) AS d FROM limit_up' },
  { key: 'flow', label: '个股资金流', sql: 'SELECT MAX(date) AS d FROM stock_flow' },
];

let db = null;
function dataDates() {
  try {
    if (!fs.existsSync(DB_PATH)) return {};
    db ??= openDb();
    return Object.fromEntries(DATASETS.map((s) => [s.key, db.prepare(s.sql).get()?.d ?? null]));
  } catch (err) {
    console.error('[sync] 读取数据日期失败', err.message);
    return {};
  }
}

/**
 * 板块类数据的覆盖情况：{ key: [已到最新日期的板块数, 应有的板块数] }。
 * 应有 = 最新日期或前一个更新日期有数据的板块（停发、新设的不算），用来看出「只发布了一部分」
 */
const COVERAGE = { thn: 'THN', thi: 'THI', sw1: 'SW1' };
function dataCoverage() {
  try {
    if (!db) return {};
    const latestOf = db.prepare('SELECT MAX(date) AS d FROM daily WHERE code = ?');
    const out = {};
    for (const [key, cat] of Object.entries(COVERAGE)) {
      const dates = db.prepare('SELECT code FROM symbols WHERE category = ?').all(cat).map((r) => latestOf.get(r.code).d).filter(Boolean);
      if (!dates.length) continue;
      const max = Math.max(...dates);
      const prev = Math.max(0, ...dates.filter((d) => d < max));
      out[key] = [dates.filter((d) => d === max).length, dates.filter((d) => d >= prev).length];
    }
    return out;
  } catch (err) {
    console.error('[sync] 读取板块覆盖情况失败', err.message);
    return {};
  }
}
const partial = (cov) => !!cov && cov[0] < cov[1];

// ---------------- 运行记录 ----------------
function appendHistory(record) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(record)}\n`);
  } catch (err) {
    console.error('[sync] 写入同步记录失败', err.message);
  }
}

/** 最近 limit 次运行，新的在前 */
export function readHistory(limit = 50) {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function pruneLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - LOG_KEEP))) fs.unlinkSync(path.join(LOG_DIR, f));
  } catch { /* 目录不存在等，忽略 */ }
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ymdOf = (t) => { const d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

// ---------------- 运行 ----------------
const TRIGGER_LABEL = { schedule: '定时', manual: '手动' };
const sync = { running: null, trigger: null, startedAt: null, finishedAt: null, exitCode: null, log: [] };
let onFinish = () => {};
let onChange = () => {};

/** index.js 注册回调：同步结束后重载标的池、刷新画面；状态变化时广播 */
export function initSync(hooks) {
  onFinish = hooks.onFinish ?? onFinish;
  onChange = hooks.onChange ?? onChange;
}

export const isSyncing = () => !!sync.running;
export const lastSyncAt = () => sync.finishedAt;

/** 当前进度（导播台设置面板 / GET /api/sync） */
export function syncInfo() {
  const { running, ...info } = sync;
  return { running: !!running, ...info, schedule: scheduleSummary(), history: readHistory(60), arrivals: todayArrivals() };
}

/** 今天各数据集第一次同步到「今天」的时刻：回答「同花顺概念今天几点更新」 */
function todayArrivals() {
  const today = ymdOf(Date.now());
  const out = {};
  for (const run of readHistory(200).reverse()) {
    if (ymdOf(run.startedAt) !== today) continue;
    for (const s of DATASETS) {
      // 板块只发布了一部分时不算到达，等全部到齐的那次
      if (!out[s.key] && run.after?.[s.key] === today && !partial(run.coverage?.[s.key])) out[s.key] = run.finishedAt;
    }
  }
  return out;
}

export function startSync(trigger = 'manual') {
  if (sync.running) return false;
  const startedAt = Date.now();
  const before = dataDates();
  const coverageBefore = dataCoverage();
  Object.assign(sync, { trigger, startedAt, finishedAt: null, exitCode: null, log: [] });

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `${stamp(startedAt)}${String(startedAt % 1000).padStart(3, '0')}-${trigger}.log`);
  const logStream = fs.createWriteStream(logFile);
  logStream.write(`# ${TRIGGER_LABEL[trigger] ?? trigger}同步 ${new Date(startedAt).toLocaleString('zh-CN', { hour12: false })}\n`);

  const child = spawn(process.execPath,
    ['--env-file-if-exists=.env', '--disable-warning=ExperimentalWarning', 'scripts/sync.js'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  sync.running = child;

  const onData = (chunk) => {
    const text = chunk.toString();
    logStream.write(text);
    for (const line of text.split(/\r?\n/)) if (line) sync.log.push(line);
    if (sync.log.length > LIVE_LOG_LINES) sync.log.splice(0, sync.log.length - LIVE_LOG_LINES);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => onData(`[sync] 启动失败：${err.message}\n`));
  child.on('close', async (code) => {
    const finishedAt = Date.now();
    const after = dataDates();
    const coverage = dataCoverage();
    // 新到：最新日期变了，或者之前只到了一部分板块、这次到齐了
    const arrived = DATASETS.filter((s) => after[s.key] && (after[s.key] !== before[s.key]
      || (partial(coverageBefore[s.key]) && !partial(coverage[s.key])))).map((s) => s.key);
    // 「还没发布」：比个股日线落后的数据集（个股日线一般 16 点前就有）
    const lagging = DATASETS.filter((s) => s.key !== 'stock' && after.stock && after[s.key] && after[s.key] < after.stock).map((s) => s.key);
    const record = {
      trigger, startedAt, finishedAt, exitCode: code, before, after, coverage, arrived, lagging,
      log: path.relative(DATA_DIR, logFile),
    };
    appendHistory(record);
    logStream.end(`# 结束 exit=${code}，用时 ${Math.round((finishedAt - startedAt) / 1000)}s\n`);
    pruneLogs();
    Object.assign(sync, { running: null, finishedAt, exitCode: code });

    const label = (keys) => keys.map((k) => `${DATASETS.find((s) => s.key === k).label} ${after[k]}`
      + (partial(coverage[k]) ? `（${coverage[k][0]}/${coverage[k][1]} 个板块）` : '')).join('、') || '无';
    console.log(`[sync] ${hm(startedAt)} ${TRIGGER_LABEL[trigger] ?? trigger}同步结束 exit=${code} 用时 ${Math.round((finishedAt - startedAt) / 1000)}s`
      + `｜新到：${label(arrived)}｜仍落后于个股：${label(lagging)}`);

    try { await onFinish(); } catch (err) { console.error('[sync] 同步后刷新失败', err.message); }
    onChange();
  });
  onChange();
  return true;
}

// ---------------- 定时 ----------------
const toMinutes = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const fmtMinutes = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;

function parseDays(spec) {
  const days = new Set();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b = a] = part.split('-').map(Number);
    for (let d = a; d <= b; d++) days.add(d % 7);
  }
  return days;
}

/** 一天内要触发的时刻（分钟数，升序去重） */
function scheduleTimes() {
  const times = new Set();
  const every = +(process.env.SYNC_EVERY ?? 30);
  const window = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec((process.env.SYNC_WINDOW || '15:30-23:30').trim());
  if (every > 0 && window) {
    const [from, to] = [toMinutes(window[1]), toMinutes(window[2])];
    for (let t = from; t <= to; t += every) times.add(t);
  }
  for (const s of (process.env.SYNC_AT || '').split(',').map((x) => x.trim())) {
    if (/^\d{1,2}:\d{2}$/.test(s)) times.add(toMinutes(s));
  }
  return [...times].sort((a, b) => a - b);
}

const SCHEDULE_ENABLED = !!process.env.TUSHARE_TOKEN;
const TIMES = scheduleTimes();
const DAYS = parseDays(process.env.SYNC_DAYS || '1-5');

function scheduleSummary() {
  if (!SCHEDULE_ENABLED) return '未开启（没有配置 TUSHARE_TOKEN）';
  if (!TIMES.length) return '未开启（SYNC_EVERY=0 且没有 SYNC_AT）';
  const every = +(process.env.SYNC_EVERY ?? 30);
  const window = (process.env.SYNC_WINDOW || '15:30-23:30').trim();
  const extra = (process.env.SYNC_AT || '').trim();
  const dayText = [...DAYS].sort().map((d) => '日一二三四五六'[d]).join('');
  return `${every > 0 ? `${window} 每 ${every} 分钟` : ''}${extra ? `${every > 0 ? '，另加 ' : ''}${extra}` : ''}（周${dayText}）`;
}

/** 启动定时器（index.js 调用一次） */
export function startSchedule() {
  if (!SCHEDULE_ENABLED || !TIMES.length) {
    console.log(`[sync] 定时同步：${scheduleSummary()}`);
    return;
  }
  console.log(`[sync] 定时同步：${scheduleSummary()}，共 ${TIMES.length} 次：${TIMES.map(fmtMinutes).join(' ')}`);
  const done = new Set(); // 已触发过的「日期 时刻」
  setInterval(() => {
    const now = new Date();
    const minute = now.getHours() * 60 + now.getMinutes();
    const key = `${now.toDateString()} ${minute}`;
    if (!TIMES.includes(minute) || !DAYS.has(now.getDay()) || done.has(key)) return;
    done.add(key);
    if (!startSync('schedule')) console.log(`[sync] ${fmtMinutes(minute)} 定时同步：上一次还没结束，跳过`);
  }, 20_000);
}
