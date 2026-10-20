/**
 * 分钟历史定时补全（IFIND_BACKFILL=1 开启，只在数据源为 iFinD 时运行）：子进程跑 scripts/sync-ifind.js --backfill
 *   IFIND_BACKFILL_WINDOW=21:30-08:30  工作日的运行时段（跨零点）；周六、周日全天
 *   IFIND_BACKFILL_EVERY=20            每隔多少分钟一轮，每轮最多 IFIND_MAX_SECONDS（默认 600 秒）
 * 和盘后同步共用 ifind-sync.lock：盘后同步或手动补满在跑时，这一轮跳过。
 * 日志写在 data/sync-logs/*-backfill.log，不进同步记录表。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from './db.js';
import { adapterName } from './adapters/index.js';
import { ifindConfigured } from './source-config.js';
import { openIfindDb, IFIND_DB_PATH } from './ifind-db.js';
import { createIfindClient } from './ifind-client.js';
import { backfillStatus, inBackfillWindow } from './ifind-backfill.js';
import { isSyncing } from './sync-runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(path.dirname(DB_PATH), 'sync-logs');
const LOCK = path.join(path.dirname(IFIND_DB_PATH), 'ifind-sync.lock');
const EVERY = Math.max(5, +(process.env.IFIND_BACKFILL_EVERY || 20));
const WINDOW = (process.env.IFIND_BACKFILL_WINDOW || '21:30-08:30').trim();

const enabled = () => process.env.IFIND_BACKFILL === '1' && adapterName === 'ifind' && ifindConfigured();

const state = { running: null, startedAt: null, finishedAt: null, exitCode: null, last: '' };
let db = null;
// 官方用量（含其他终端）每 5 分钟最多查一次，设置页打开时才查
let official = null, officialAt = 0, client = null;
function refreshOfficial() {
  if (Date.now() - officialAt < 5 * 60_000 || !ifindConfigured()) return;
  officialAt = Date.now();
  (client ??= createIfindClient()).dataVolume().then((v) => { official = { ...v, at: Date.now() }; })
    .catch((err) => console.error('[backfill] 查询官方用量失败', err.message));
}

/** 设置页：开关、本轮状态、各批进度、官方用量 */
export function backfillInfo() {
  if (adapterName !== 'ifind') return null;
  refreshOfficial();
  let status = null;
  try { status = backfillStatus(db ??= openIfindDb()); } catch (err) { console.error('[backfill] 读取进度失败', err.message); }
  const { running, ...rest } = state;
  return { enabled: enabled(), window: `工作日 ${WINDOW}、周末全天，每 ${EVERY} 分钟一轮`,
    running: !!running, ...rest, official, status };
}

function startRound() {
  if (state.running || isSyncing() || fs.existsSync(LOCK)) return false;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const startedAt = Date.now();
  const log = fs.createWriteStream(path.join(LOG_DIR, `${new Date(startedAt).toISOString().replace(/[-:]/g, '').slice(0, 15)}-backfill.log`));
  const child = spawn(process.execPath,
    ['--env-file-if-exists=.env', '--disable-warning=ExperimentalWarning', 'scripts/sync-ifind.js', '--backfill'],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  Object.assign(state, { running: child, startedAt, finishedAt: null, exitCode: null });
  const onData = (chunk) => {
    const text = chunk.toString();
    log.write(text);
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith('[backfill]'));
    if (lines.length) state.last = lines.at(-1);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => onData(`[backfill] 启动失败：${err.message}\n`));
  child.on('close', (code) => {
    log.end();
    Object.assign(state, { running: null, finishedAt: Date.now(), exitCode: code });
    console.log(`[backfill] 一轮结束 exit=${code}，用时 ${Math.round((Date.now() - startedAt) / 1000)}s｜${state.last}`);
    try {
      const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('-backfill.log')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 300))) fs.unlinkSync(path.join(LOG_DIR, f));
    } catch { /* 忽略 */ }
  });
  return true;
}

/** 启动定时器（index.js 调用一次） */
export function startBackfillSchedule() {
  if (process.env.IFIND_BACKFILL !== '1') {
    console.log('[backfill] 分钟历史定时补全：未开启（IFIND_BACKFILL=1 且数据源为 iFinD 时运行）');
    return;
  }
  console.log(`[backfill] 分钟历史定时补全：工作日 ${WINDOW}、周末全天，每 ${EVERY} 分钟一轮`);
  let lastSlot = null;
  setInterval(() => {
    if (!enabled()) return;
    const now = new Date();
    if (!inBackfillWindow(now, WINDOW)) return;
    const slot = `${now.toDateString()} ${Math.floor((now.getHours() * 60 + now.getMinutes()) / EVERY)}`;
    if (slot === lastSlot) return;
    if (startRound()) lastSlot = slot;
  }, 30_000);
}
