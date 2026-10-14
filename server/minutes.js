/**
 * 分钟 K：tushare 历史分钟（需单独开通权限），按需拉取并缓存到本地库
 *
 *   个股：stk_mins；指数：先试 idx_mins，不行再试 stk_mins（哪个能用记下来，之后直接用）
 *   板块（同花顺 / 申万）tushare 没有分钟数据，调用方应先用 hasMinuteData 过滤
 *
 * 缓存规则
 *   第一次打开某标的的某个频率：拉最近 MINUTE_MONTHS 个月（默认 6）
 *   之后距上次拉取超过 MINUTE_REFETCH_MS（默认 10 分钟）才增量补拉（从库里最后一根所在交易日开始）
 *   拉取失败但库里有数据时照常返回旧数据，不影响直播
 *   超出保留期的数据在拉取时顺带删除；分时用的 1 分钟只保留 7 天
 *
 * 环境变量：MINUTE_MONTHS=6（0 = 关闭分钟 K）、MINUTE_REFETCH_MS
 */
import { queryPage } from './tushare-client.js';

const MONTHS = +(process.env.MINUTE_MONTHS ?? 6);
const REFETCH_MS = +(process.env.MINUTE_REFETCH_MS || 10 * 60_000);
const ONE_MIN_KEEP_DAYS = 7;
const MAX_ROWS = 8000; // stk_mins 单次最多返回行数
const BARS_PER_DAY = (freq) => Math.ceil(240 / freq) + 1;

/** 有 token 且没关掉时才开放分钟 K / 分时 */
export const MINUTES_ENABLED = !!process.env.TUSHARE_TOKEN && MONTHS > 0;

const pad = (n) => String(n).padStart(2, '0');
const fmt = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
/** tushare 的 trade_time "2026-10-14 15:00:00"，按本地时区（容器 TZ=Asia/Shanghai）解析 */
const parseTime = (s) => {
  const [d, t = '00:00:00'] = String(s).split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se = 0] = t.split(':').map(Number);
  return new Date(y, mo - 1, da, h, mi, se).getTime();
};
const startOfDay = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

export function retentionStart(freq, now = Date.now()) {
  if (freq === 1) return startOfDay(now - ONE_MIN_KEEP_DAYS * 86400_000);
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() - MONTHS, d.getDate()).getTime();
}

// 指数用哪个接口：code -> 'idx_mins' | 'stk_mins'
const indexApi = new Map();

async function callMinutes(api, code, freq, from, to) {
  const { rows } = await queryPage(api, {
    ts_code: code, freq: `${freq}min`, start_date: fmt(from), end_date: fmt(to),
  }, 'ts_code,trade_time,open,high,low,close,vol,amount');
  return rows;
}

/**
 * 从 tushare 拉 [from, to] 的分钟线，按时间正序返回 { ts, open, high, low, close, vol, amount }。
 * 按日期分段请求，保证每段不超过单次行数上限。
 */
export async function fetchMinutes(symbol, freq, from, to = Date.now()) {
  const chunkMs = Math.floor((MAX_ROWS * 0.9) / BARS_PER_DAY(freq)) * 86400_000; // 按自然日算，偏保守
  const out = new Map();
  for (let start = from; start <= to; start += chunkMs) {
    const end = Math.min(to, start + chunkMs - 1000);
    let rows;
    if (symbol.type === 'index') {
      const tryOrder = indexApi.has(symbol.code) ? [indexApi.get(symbol.code)] : ['idx_mins', 'stk_mins'];
      let lastErr;
      for (const api of tryOrder) {
        try {
          rows = await callMinutes(api, symbol.code, freq, start, end);
          indexApi.set(symbol.code, api);
          break;
        } catch (err) {
          lastErr = err;
          if (err.retryable) throw err;
        }
      }
      if (!rows) throw lastErr;
    } else {
      rows = await callMinutes('stk_mins', symbol.code, freq, start, end);
    }
    for (const r of rows) {
      const ts = parseTime(r.trade_time);
      if (![r.open, r.high, r.low, r.close].every((v) => Number.isFinite(+v))) continue;
      out.set(ts, { ts, open: +r.open, high: +r.high, low: +r.low, close: +r.close, vol: +r.vol || 0, amount: +r.amount || 0 });
    }
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

// ---------------- 本地库缓存（DATA_SOURCE=local） ----------------
const pending = new Map(); // `${code}|${freq}` -> Promise，同一时间只拉一次

/** 需要时从 tushare 补拉，写入本地库 */
async function refresh(db, symbol, freq) {
  const key = `${symbol.code}|${freq}`;
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const now = Date.now();
    const keepFrom = retentionStart(freq, now);
    const f = db.prepare('SELECT fetched_at, last_ts FROM minute_fetch WHERE code = ? AND freq = ?').get(symbol.code, freq);
    if (f && now - f.fetched_at < REFETCH_MS) return;
    // 增量：从库里最后一根所在交易日的 0 点开始（补齐当天后面的 K 线）
    const from = f?.last_ts && f.last_ts >= keepFrom ? startOfDay(f.last_ts) : keepFrom;
    const rows = await fetchMinutes(symbol, freq, from, now);
    const insert = db.prepare(`INSERT OR REPLACE INTO minute (code, freq, ts, open, high, low, close, vol, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec('BEGIN');
    try {
      for (const r of rows) insert.run(symbol.code, freq, r.ts, r.open, r.high, r.low, r.close, r.vol, r.amount);
      db.prepare('DELETE FROM minute WHERE code = ? AND freq = ? AND ts < ?').run(symbol.code, freq, keepFrom);
      const last = rows.at(-1)?.ts ?? f?.last_ts ?? null;
      db.prepare('INSERT OR REPLACE INTO minute_fetch (code, freq, fetched_at, last_ts) VALUES (?, ?, ?, ?)')
        .run(symbol.code, freq, now, last);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (!f) console.log(`[minutes] ${symbol.code} ${freq}min 首次拉取 ${rows.length} 根`);
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/**
 * 读本地库里的分钟线（先按需补拉）。返回不复权的原始行，按时间正序。
 * 拉取失败：库里有数据就返回旧数据并打印警告，没有就抛错
 */
export async function readMinutes(db, symbol, freq) {
  try {
    await refresh(db, symbol, freq);
  } catch (err) {
    const has = db.prepare('SELECT 1 FROM minute WHERE code = ? AND freq = ? LIMIT 1').get(symbol.code, freq);
    if (!has) throw new Error(`${symbol.code} ${freq} 分钟数据拉取失败：${err.message}`);
    console.warn(`[minutes] ${symbol.code} ${freq}min 补拉失败，先用本地数据：${err.message}`);
  }
  return db.prepare('SELECT ts, open, high, low, close, vol, amount FROM minute WHERE code = ? AND freq = ? AND ts >= ? ORDER BY ts')
    .all(symbol.code, freq, retentionStart(freq));
}

/** 原始行 → K 线 Bar。成交量统一成「手」（与日线一致），成交额（元） */
export const toBar = (r, k = 1) => {
  const r2 = (v) => Math.round(v * k * 100) / 100;
  return {
    timestamp: r.ts,
    open: r2(r.open), high: r2(r.high), low: r2(r.low), close: r2(r.close),
    volume: r.vol / 100,
    turnover: r.amount,
  };
};
