/**
 * 盘后同步：tushare → 本地 SQLite（data/market.db）
 *
 *   npm run sync
 *
 * - 股票列表：stock_basic（上市中）
 * - 个股日线 + 复权因子：按交易日拉全市场（daily / adj_factor），每天各 1 次调用
 * - 指数日线：按代码拉（index_daily），范围 = 内置常用指数 + .env 的 SYNC_INDICES
 * - 同花顺板块（需 6000 积分）：列表 ths_index，日线 ths_daily。
 *   先探测能否按交易日批量拉；不能则按板块代码逐个增量拉。类型由 SYNC_THS_TYPES 控制，默认概念 + 行业
 * - 申万一级行业：列表 index_classify(L1)，日线 sw_daily 按交易日拉
 * - 板块排名（最近 20 个交易日）：涨停 limit_list_d、个股资金流 moneyflow、同花顺概念资金流 moneyflow_cnt_ths；
 *   成分股 index_member_all / ths_member 每周刷新一次
 * - 宏观数据：Shibor / LPR / 美债收益率 / GDP / CPI / PPI / 货币供应量 / 社融 / PMI / 两融，见 shared/macro.js
 * - 大盘分时的领先指标 / 红绿柱：最近交易日全市场个股 1 分钟线（stk_mins，需历史分钟权限），见 server/breadth.js
 *
 * 范围：个股 SYNC_YEARS 年（默认 3）；板块和指数 BOARD_YEARS（默认 all = 全部历史）
 *
 * 可重复运行：已完成的交易日会跳过，中断后再跑会接着补。
 * 当天数据还没发布时（返回空）不会标记完成，下次运行自动补上。
 */
import { query, queryAll, queryPage, ymd, ymdToTs } from '../server/tushare-client.js';
import { openDb, tx, DB_PATH } from '../server/db.js';
import { BUILTIN_INDICES } from '../server/symbols.js';
import { MACRO_DATASETS } from '../shared/macro.js';
import { syncBreadth } from '../server/breadth.js';

// 个股（日线 + 复权因子）同步年数
const YEARS = +(process.env.SYNC_YEARS || 3);
// 板块和指数（同花顺板块、申万一级、指数）同步范围：all = 全部历史，或填年数
const BOARD_YEARS = String(process.env.BOARD_YEARS || 'all').trim().toLowerCase();
// 最近 N 个交易日返回空 = 还没发布，下次再补；更早的空日期 = 当天确实没有数据，直接标记完成
const PENDING_DAYS = 5;
const EXTRA_INDICES = (process.env.SYNC_INDICES || '').split(',').map((s) => s.trim()).filter(Boolean);
// 同花顺板块类型：N 概念 / I 行业 / R 地域 / S 特色 / ST 风格 / TH 主题 / BB 宽基
const THS_TYPES = (process.env.SYNC_THS_TYPES || 'N,I').split(',').map((s) => s.trim()).filter(Boolean);
const MIN_INTERVAL_MS = +(process.env.SYNC_INTERVAL_MS || 130); // 约 450 次/分钟，低于 500 次/分钟上限
// 板块排名用的涨停、资金流只需要最近的数据
const RECENT_DAYS = 20;
// 按交易日拉的数据，最近几个交易日每次都重拉：tushare 当天的数据可能分批发布（如同花顺板块日线先出一部分），
// 只要返回了数据就标记完成的话，后发布的就再也补不上
const RECHECK_DAYS = 2;
// 成分股刷新周期（天）；设 SYNC_MEMBERS=1 可强制本次刷新
const MEMBERS_TTL_DAYS = 7;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

/** 限速 + 失败重试（限流、网络抖动）；权限不足等业务错误直接抛出。interval 用于频次更低的接口 */
async function call(label, fn, interval = MIN_INTERVAL_MS) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + Math.max(interval, MIN_INTERVAL_MS) - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 4 || (err.tushareCode !== undefined && !err.retryable)) throw err;
      console.warn(`  ${label} 失败：${err.message}，${attempt * 10}s 后重试`);
      await sleep(attempt * 10_000);
    }
  }
}

const db = openDb();
const today = new Date();
const start = new Date(today);
start.setFullYear(start.getFullYear() - YEARS);
// 板块和指数的起点：全部历史从沪市开市（1990-12-19）算起
const boardStart = BOARD_YEARS === 'all'
  ? new Date(1990, 11, 19)
  : new Date(today.getFullYear() - (+BOARD_YEARS || 10), today.getMonth(), today.getDate());
const t0 = Date.now();
let failed = false;

console.log(`[sync] 数据库 ${DB_PATH}`);
console.log(`[sync] 个股 ${ymd(start)} ~ ${ymd(today)}；板块和指数 ${BOARD_YEARS === 'all' ? '全部历史' : `${ymd(boardStart)} 起`}`);

// ================= 1. 标的列表 =================
const upsertSymbol = db.prepare('INSERT OR REPLACE INTO symbols (code, name, type, category) VALUES (?, ?, ?, ?)');

const stocks = await call('stock_basic', () => queryAll('stock_basic', { list_status: 'L' }, 'ts_code,name'));
tx(db, () => stocks.forEach((s) => upsertSymbol.run(s.ts_code, s.name, 'stock', null)));
console.log(`[sync] 股票列表 ${stocks.length} 只`);

const indices = [...BUILTIN_INDICES.map(({ code, name }) => ({ code, name }))];
for (const code of EXTRA_INDICES) {
  if (indices.some((x) => x.code === code)) continue;
  const [info] = await call(`index_basic ${code}`, () => query('index_basic', { ts_code: code }, 'ts_code,name'));
  if (info) indices.push({ code, name: info.name });
  else { console.warn(`  找不到指数 ${code}，已跳过`); failed = true; }
}
tx(db, () => indices.forEach((s) => upsertSymbol.run(s.code, s.name, 'index', null)));
console.log(`[sync] 指数 ${indices.length} 个`);

// 申万一级行业（板块排名用）。只要一级；清掉旧版本同步过的二/三级
let sw1 = [];
try {
  const rows = await call('index_classify L1', () =>
    queryAll('index_classify', { level: 'L1', src: 'SW2021' }, 'index_code,industry_name,is_pub'));
  sw1 = rows.filter((r) => r.is_pub == null || String(r.is_pub) === '1').map((r) => ({ code: r.index_code, name: r.industry_name }));
  tx(db, () => {
    db.prepare("DELETE FROM symbols WHERE category IN ('SW2', 'SW3')").run();
    sw1.forEach((s) => upsertSymbol.run(s.code, s.name, 'index', 'SW1'));
  });
  console.log(`[sync] 申万一级行业 ${sw1.length} 个`);
} catch (err) {
  console.warn(`[sync] 申万一级行业列表失败，本次跳过：${err.message}`);
  failed = true;
}
const sw1Codes = new Set(sw1.map((s) => s.code));

// 同花顺板块（A 股）
const ths = [];
try {
  const counts = [];
  for (const type of THS_TYPES) {
    const rows = await call(`ths_index ${type}`, () => queryAll('ths_index', { exchange: 'A', type }, 'ts_code,name,type'));
    rows.forEach((r) => ths.push({ code: r.ts_code, name: r.name, category: `TH${type}` }));
    counts.push(`${type} ${rows.length}`);
  }
  tx(db, () => ths.forEach((s) => upsertSymbol.run(s.code, s.name, 'index', s.category)));
  console.log(`[sync] 同花顺板块 ${ths.length} 个（${counts.join(' / ')}）`);
} catch (err) {
  console.warn(`[sync] 同花顺板块列表失败，本次跳过同花顺：${err.message}`);
  ths.length = 0;
  failed = true;
}
const thsCodes = new Set(ths.map((s) => s.code));

// ================= 2. 按交易日批量拉（个股、复权因子，以及支持时的同花顺板块） =================
const calFrom = boardStart < start ? boardStart : start;
const cal = await call('trade_cal', () =>
  queryAll('trade_cal', { exchange: 'SSE', start_date: ymd(calFrom), end_date: ymd(today), is_open: '1' }, 'cal_date'));
const allDays = cal.map((r) => +r.cal_date).sort((a, b) => a - b);
const tradeDays = allDays.filter((d) => d >= +ymd(start));        // 个股用
const boardDays = allDays.filter((d) => d >= +ymd(boardStart));   // 板块、指数用
const pendingFrom = tradeDays.at(-PENDING_DAYS) ?? 0;              // 这天及以后返回空才算「未发布」

const insertDaily = db.prepare(
  'INSERT OR REPLACE INTO daily (code, date, open, high, low, close, vol, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

// 行 → daily 表；vol 统一为手，amount 统一为千元
const toDaily = {
  standard: (r) => insertDaily.run(r.ts_code, +r.trade_date, r.open, r.high, r.low, r.close, r.vol, r.amount),
  sw: (r) => insertDaily.run(r.ts_code, +r.trade_date, r.open, r.high, r.low, r.close, r.vol * 100, r.amount * 10), // 万股、万元
  ths: (r) => insertDaily.run(r.ts_code, +r.trade_date, r.open, r.high, r.low, r.close, r.vol, null), // ths_daily 无成交额
};
const OHLCV = 'ts_code,trade_date,open,high,low,close,vol';
const prep = (sql) => db.prepare(sql);

/**
 * 按交易日批量拉的任务。recent = 只同步最近 N 个交易日（排名快照用）；
 * optional = 失败（如积分不够）只告警，不影响其他数据
 */
const JOBS = [
  { kind: 'daily', api: 'daily', fields: `${OHLCV},amount`, insert: toDaily.standard },
  {
    kind: 'adj', api: 'adj_factor', fields: 'ts_code,trade_date,adj_factor',
    insert: ((st) => (r) => st.run(r.ts_code, +r.trade_date, r.adj_factor))(prep('INSERT OR REPLACE INTO adj (code, date, factor) VALUES (?, ?, ?)')),
  },
  ...(sw1.length ? [{
    kind: 'sw', api: 'sw_daily', fields: `${OHLCV},amount`, insert: toDaily.sw, keep: (r) => sw1Codes.has(r.ts_code), optional: true,
    board: { codes: [...sw1Codes].sort().slice(0, 3) }, // 板块：按 BOARD_YEARS 拉历史；codes 用来探测最早有数据的日期
  }] : []),
  {
    kind: 'limit', api: 'limit_list_d', params: { limit_type: 'U' }, fields: 'ts_code,trade_date,limit',
    keep: (r) => r.limit == null || r.limit === 'U', recent: RECENT_DAYS, optional: true,
    insert: ((st) => (r) => st.run(+r.trade_date, r.ts_code))(prep('INSERT OR REPLACE INTO limit_up (date, code) VALUES (?, ?)')),
  },
  {
    // 主力净额 = 大单 + 特大单 净买入（万元）
    kind: 'flow', api: 'moneyflow', fields: 'ts_code,trade_date,buy_lg_amount,sell_lg_amount,buy_elg_amount,sell_elg_amount',
    recent: RECENT_DAYS, optional: true,
    insert: ((st) => (r) => st.run(+r.trade_date, r.ts_code,
      (+r.buy_lg_amount || 0) + (+r.buy_elg_amount || 0) - (+r.sell_lg_amount || 0) - (+r.sell_elg_amount || 0)))(
      prep('INSERT OR REPLACE INTO stock_flow (date, code, main_net) VALUES (?, ?, ?)')),
  },
  ...(THS_TYPES.includes('N') ? [{
    kind: 'thsflow', api: 'moneyflow_cnt_ths', fields: 'ts_code,trade_date,net_amount', recent: RECENT_DAYS, optional: true,
    insert: ((st) => (r) => st.run(+r.trade_date, r.ts_code, r.net_amount))(prep('INSERT OR REPLACE INTO board_flow (date, code, net) VALUES (?, ?, ?)')),
  }] : []),
];

// 探测 ths_daily 能否只按交易日一次拉全部板块：用前一个交易日（肯定已发布）试一次
let thsByDate = false;
if (ths.length && tradeDays.length >= 2) {
  const probe = tradeDays.at(-2);
  try {
    const { rows } = await call('ths_daily 探测', () => queryPage('ths_daily', { trade_date: String(probe), limit: 3000 }, 'ts_code'));
    const hit = rows.filter((r) => thsCodes.has(r.ts_code)).length;
    thsByDate = hit >= Math.min(100, ths.length / 2);
    console.log(`[sync] 同花顺行情：${thsByDate ? '按交易日批量拉' : '按板块代码逐个拉'}（探测 ${probe}，命中 ${hit} 个板块）`);
  } catch (err) {
    console.log(`[sync] 同花顺行情：按板块代码逐个拉（按交易日探测失败：${err.message}）`);
  }
}
if (thsByDate) {
  // 探测最早日期用行业指数（比概念设立得早）
  const probeCodes = ths.filter((s) => s.category === 'THI').map((s) => s.code).sort().slice(0, 3);
  JOBS.push({
    kind: 'ths', api: 'ths_daily', fields: OHLCV, insert: toDaily.ths, keep: (r) => thsCodes.has(r.ts_code),
    board: { codes: probeCodes.length ? probeCodes : [...thsCodes].sort().slice(0, 3) },
  });
}

const markSynced = db.prepare('INSERT OR REPLACE INTO synced (kind, date) VALUES (?, ?)');
const getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const setMeta = (key, value) => prep('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));

/**
 * 板块类接口最早有数据的日期：用几个老板块按代码拉一次完整历史取最早日期（结果缓存在 meta），
 * 避免从 1990 年起逐日请求几千个空日期
 */
async function earliestDate(job) {
  const key = `earliest:${job.kind}:${ymd(boardStart)}`;
  const cached = getMeta(key);
  if (cached) return +cached;
  let min = Infinity;
  for (const code of job.board.codes) {
    const rows = await call(`${job.api} ${code} 探测历史`, () =>
      queryAll(job.api, { ts_code: code, start_date: ymd(boardStart), end_date: ymd(today) }, 'trade_date', 3000));
    for (const r of rows) min = Math.min(min, +r.trade_date);
  }
  if (!Number.isFinite(min)) return +ymd(boardStart);
  setMeta(key, min);
  console.log(`  ${job.api} 最早有数据的日期：${min}`);
  return min;
}

for (const job of JOBS) {
  const done = new Set(db.prepare('SELECT date FROM synced WHERE kind = ?').all(job.kind).map((r) => r.date));
  let days = job.recent ? tradeDays.slice(-job.recent) : tradeDays;
  try {
    if (job.board) {
      const earliest = await earliestDate(job);
      days = boardDays.filter((d) => d >= earliest);
    }
    const recheck = new Set(days.slice(-RECHECK_DAYS));
    const todo = days.filter((d) => !done.has(d) || recheck.has(d));
    console.log(`[sync] ${job.api}：共 ${days.length} 个交易日，待同步 ${todo.length} 个（含最近 ${RECHECK_DAYS} 天重拉）`);
    const every = todo.length > 500 ? 250 : 20; // 首次补历史时少打点日志
    let emptyOld = 0;

    for (let i = 0; i < todo.length; i++) {
      const date = todo[i];
      const all = await call(`${job.api} ${date}`, () =>
        queryAll(job.api, { ...job.params, trade_date: String(date) }, job.fields, 3000));
      const rows = job.keep ? all.filter(job.keep) : all;
      if (!rows.length) {
        if (date >= pendingFrom) {
          console.log(`  ${job.api} ${date} 暂无数据（可能还没发布），下次再补`);
        } else {
          markSynced.run(job.kind, date); // 历史上当天确实没有数据，不再重复请求
          emptyOld++;
        }
        continue;
      }
      tx(db, () => {
        rows.forEach(job.insert);
        markSynced.run(job.kind, date);
      });
      if (i % every === 0 || i === todo.length - 1) {
        console.log(`  ${job.api} ${date}  ${rows.length} 条  (${i + 1}/${todo.length})`);
      }
    }
    if (emptyOld) console.log(`  ${job.api}：${emptyOld} 个历史交易日无数据，已标记跳过`);
  } catch (err) {
    if (!job.optional) throw err;
    console.warn(`  ${job.api} 失败，已跳过（其余数据不受影响）：${err.message}`);
    failed = true;
  }
}

// ================= 成分股（板块排名的涨停数、申万一级主力净额用），每周刷新 =================
const membersAt = +(db.prepare("SELECT value FROM meta WHERE key = 'members_at'").get()?.value ?? 0);
const membersStale = process.env.SYNC_MEMBERS === '1'
  || Date.now() - membersAt > MEMBERS_TTL_DAYS * 86_400_000
  || !db.prepare('SELECT 1 FROM members LIMIT 1').get();

if (membersStale) {
  const insertMember = prep('INSERT OR REPLACE INTO members (board, stock) VALUES (?, ?)');
  let ok = true;

  if (sw1.length) {
    try {
      const rows = await call('index_member_all', () =>
        queryAll('index_member_all', { is_new: 'Y' }, 'l1_code,ts_code', 2000));
      const kept = rows.filter((r) => sw1Codes.has(r.l1_code));
      tx(db, () => {
        db.prepare("DELETE FROM members WHERE board LIKE '%.SI'").run();
        kept.forEach((r) => insertMember.run(r.l1_code, r.ts_code));
      });
      console.log(`[sync] 申万一级成分股 ${kept.length} 条`);
    } catch (err) {
      console.warn(`  申万一级成分股失败：${err.message}`);
      ok = false;
    }
  }

  const concepts = ths.filter((s) => s.category === 'THN');
  if (concepts.length) {
    // ths_member 每分钟 200 次，逐个板块拉
    console.log(`[sync] 同花顺概念成分股：逐个拉 ${concepts.length} 个概念（约 ${Math.ceil(concepts.length * 0.32 / 60)} 分钟）`);
    const all = [];
    let errors = 0;
    for (let i = 0; i < concepts.length; i++) {
      try {
        const rows = await call(`ths_member ${concepts[i].code}`, () =>
          queryAll('ths_member', { ts_code: concepts[i].code }, 'ts_code,con_code', 3000), 320);
        rows.forEach((r) => all.push([concepts[i].code, r.con_code]));
      } catch (err) {
        errors++;
        if (errors <= 3) console.warn(`  ths_member ${concepts[i].code} 失败：${err.message}`);
        if (err.tushareCode !== undefined && !err.retryable && errors >= 3) break; // 多半是权限问题，不再继续
      }
      if (i % 100 === 0 || i === concepts.length - 1) console.log(`  ths_member ${i + 1}/${concepts.length}`);
    }
    if (errors < concepts.length / 10) {
      tx(db, () => {
        db.prepare("DELETE FROM members WHERE board LIKE '%.TI'").run();
        all.forEach(([b, s]) => insertMember.run(b, s));
      });
      console.log(`[sync] 同花顺概念成分股 ${all.length} 条`);
    } else {
      console.warn(`  同花顺概念成分股失败较多（${errors} 个），保留旧数据`);
      ok = false;
    }
  }

  if (ok) prep("INSERT OR REPLACE INTO meta (key, value) VALUES ('members_at', ?)").run(String(Date.now()));
  else failed = true;
}

// ================= 3. 按代码增量拉 =================
const rangeOfCode = db.prepare('SELECT MIN(date) AS first, MAX(date) AS last FROM daily WHERE code = ?');
const lastTradeDay = tradeDays.at(-1);
const dayBefore = (d) => ymd(new Date(ymdToTs(d) - 86_400_000));
const dayAfter = (d) => ymd(new Date(ymdToTs(d) + 86_400_000));

/**
 * 按代码拉：往后从本地最新日期补到今天；往前补历史到 BOARD_YEARS 的起点（每个代码只补一次，记在 meta）。
 * verbose=false 时只打印进度和失败
 */
async function syncByCode(list, api, insert, verbose) {
  const histFrom = ymd(boardStart);
  const fields = api === 'ths_daily' ? OHLCV : `${OHLCV},amount`;
  const fetchRange = (code, from, to) => call(`${api} ${code}`, () =>
    queryAll(api, { ts_code: code, start_date: from, end_date: to }, fields, 3000));
  let errors = 0, skipped = 0;
  for (let i = 0; i < list.length; i++) {
    const { code, name } = list[i];
    const { first, last } = rangeOfCode.get(code);
    const histKey = `hist:${code}`;
    const needHist = first && +(getMeta(histKey) ?? 99999999) > +histFrom; // 还没补过这么早的历史
    const needNew = !last || last < lastTradeDay;
    if (!needHist && !needNew) { skipped++; continue; }
    try {
      let added = 0;
      if (!first) {
        const rows = await fetchRange(code, histFrom, ymd(today)); // 本地没有：一次拉全
        tx(db, () => rows.forEach(insert));
        added += rows.length;
      } else {
        if (needNew) {
          const rows = await fetchRange(code, dayAfter(last), ymd(today));
          tx(db, () => rows.forEach(insert));
          added += rows.length;
        }
        if (needHist && +histFrom < first) {
          const rows = await fetchRange(code, histFrom, dayBefore(first));
          tx(db, () => rows.forEach(insert));
          added += rows.length;
        }
      }
      setMeta(histKey, histFrom);
      if (verbose) console.log(`  ${name} ${code} +${added}`);
    } catch (err) {
      console.warn(`  ${name} ${code} 失败：${err.message}`);
      errors++;
    }
    if (!verbose && (i % 100 === 0 || i === list.length - 1)) console.log(`  ${api} ${i + 1}/${list.length}`);
  }
  if (skipped && verbose) console.log(`  ${skipped} 个已是最新`);
  if (errors) failed = true;
  return errors;
}

await syncByCode(indices, 'index_daily', toDaily.standard, true);
if (ths.length && !thsByDate) {
  console.log(`[sync] ths_daily：逐个拉 ${ths.length} 个板块`);
  const errors = await syncByCode(ths, 'ths_daily', toDaily.ths, false);
  if (errors) console.warn(`  同花顺板块 ${errors} 个失败，下次同步会重试`);
}

// ================= 4. 宏观数据（每次全量刷新，数据量小） =================
// 范围：MACRO_YEARS = all（默认，全部历史）或年数；日频、月度、季度都按这个范围
const MACRO_YEARS = String(process.env.MACRO_YEARS || 'all').trim().toLowerCase();
const macroAll = MACRO_YEARS === 'all';
const y0 = today.getFullYear() - (+MACRO_YEARS || 10);
const rangeOf = (ds) => ({
  daily: { start_date: macroAll ? '19900101' : ymd(new Date(y0, today.getMonth(), today.getDate())), end_date: ymd(today) },
  month: macroAll ? {} : { start_m: `${y0}01` },     // 不传起点 = 接口返回全部历史
  quarter: macroAll ? {} : { start_q: `${y0}Q1` },
}[ds.kind]);

const insertMacro = prep('INSERT OR REPLACE INTO macro (dataset, period, data) VALUES (?, ?, ?)');
const macroResults = [];
for (const [key, ds] of Object.entries(MACRO_DATASETS)) {
  try {
    let rows = await call(ds.api, () => queryAll(ds.api, { ...ds.params, ...rangeOf(ds) }, ds.fields, ds.pageSize));
    if (ds.aggregate) {
      // 两融：三个交易所按日加总
      const byDay = new Map();
      for (const r of rows) {
        const p = String(r[ds.periodField]);
        const acc = byDay.get(p) ?? { [ds.periodField]: p };
        for (const f of ds.aggregate) acc[f] = (acc[f] ?? 0) + (+r[f] || 0);
        byDay.set(p, acc);
      }
      rows = [...byDay.values()];
    }
    if (!rows.length) { macroResults.push(`${key} 0`); continue; } // 没数据时保留旧的
    tx(db, () => {
      db.prepare('DELETE FROM macro WHERE dataset = ?').run(key);
      rows.forEach((r) => insertMacro.run(key, String(r[ds.periodField]), JSON.stringify(r)));
    });
    macroResults.push(`${key} ${rows.length}`);
  } catch (err) {
    console.warn(`  宏观 ${key}（${ds.api}）失败：${err.message}`);
    macroResults.push(`${key} ✗`);
    failed = true;
  }
}
console.log(`[sync] 宏观数据：${macroResults.join(' · ')}`);
// 清掉已下线的数据集（如 Libor）
const keys = Object.keys(MACRO_DATASETS);
const dropped = db.prepare(`DELETE FROM macro WHERE dataset NOT IN (${keys.map(() => '?').join(',')})`).run(...keys).changes;
if (dropped) console.log(`[sync] 已清理下线的宏观数据 ${dropped} 条`);

// 大盘分时的领先指标 / 红绿柱：放在最后，几千次分钟线请求，不影响前面日线、排名数据的及时性
try {
  if (tradeDays.length >= 2 && !(await syncBreadth({ db, call, day: tradeDays.at(-1), prevDay: tradeDays.at(-2) }))) failed = true;
} catch (err) {
  console.warn(`[breadth] 失败：${err.message}`);
  failed = true;
}

const n = db.prepare('SELECT COUNT(*) AS n FROM daily').get().n;
console.log(`[sync] 完成，日线共 ${n} 条，用时 ${Math.round((Date.now() - t0) / 1000)}s${failed ? '（有部分失败，见上方）' : ''}`);
db.close();
process.exitCode = failed ? 1 : 0;
