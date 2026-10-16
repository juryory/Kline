/**
 * 大盘分时的「领先指标」（黄线）和「红绿柱」：盘后用全市场个股的 1 分钟线算出来，存在 breadth 表
 *
 *   领先指标：不按市值加权，各股相对昨收的涨跌幅简单平均（同花顺 / 通达信大盘分时的黄线）
 *   红绿柱：每分钟 上涨家数 − 下跌家数。同花顺原版用的是全市场委买委卖量（盘口），tushare 分钟线里没有，
 *           这里用涨跌家数代替，方向和节奏大体一致
 *
 * 用哪些股票算
 *   上证指数 / 深证成指 / 创业板指 / 科创综指：整个沪市 / 深市 / 创业板 / 科创板（MARKET_INDEX）
 *   成分股指数（BREADTH_INDICES，默认 上证50 / 沪深300 / 中证500 / 中证1000 / 科创50 / 北证50）：
 *     各自的成分股（tushare index_weight，存 index_members 表，每 MEMBERS_TTL_DAYS 天刷新）；
 *     拿不到成分股时 科创50 退回整个科创板、北证50 退回整个北交所，其余不算
 * 只算最近一个交易日；每天算一次（synced 表 kind = SYNCED_KIND），分钟数据还没发布时留到下次同步。
 * 需要 tushare 历史分钟权限（MINUTE_MONTHS > 0）；BREADTH=0 关闭。保留最近 BREADTH_KEEP_DAYS 天（默认 30）
 * breadth 表的 market 列：市场级的用 SH / SZ / CY / KC，成分股指数直接用指数代码
 */
import { queryAll, queryPage, ymd } from './tushare-client.js';

const MARKET_INDEX = { '000001.SH': 'SH', '399001.SZ': 'SZ', '399006.SZ': 'CY', '000680.SH': 'KC' };
const MARKETS = {
  SH: (code) => code.endsWith('.SH'),
  SZ: (code) => code.endsWith('.SZ'),
  CY: (code) => code.endsWith('.SZ') && code.startsWith('30'),
  KC: (code) => code.endsWith('.SH') && code.startsWith('688'), // 科创综指 = 全部科创板股票
};
const MEMBER_INDICES = (process.env.BREADTH_INDICES || '000016.SH,000300.SH,000905.SH,000852.SH,000688.SH,899050.BJ')
  .split(',').map((s) => s.trim()).filter(Boolean);
// 拿不到成分股时的退路：用整个板块近似
const FALLBACK = {
  '000688.SH': (code) => code.endsWith('.SH') && code.startsWith('688'),
  '899050.BJ': (code) => code.endsWith('.BJ'),
};
const MEMBERS_TTL_DAYS = 25;
// 计算口径变了（加了成分股指数）就换个 kind，已算过的当天会按新口径重算一次
const SYNCED_KIND = 'breadth3';

/** 这个指数有没有领先指标 / 红绿柱（mock 也用） */
export const hasBreadth = (code) => code in MARKET_INDEX || MEMBER_INDICES.includes(code);
const KEEP_DAYS = +(process.env.BREADTH_KEEP_DAYS || 30);
const BATCH = 30; // stk_mins 支持多个代码时，每次查 30 只（30 × 241 行 < 8000 行上限）

const ymdStr = (d) => `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6, 8)}`;
const parseTime = (s) => {
  const [d, t] = String(s).split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se = 0] = t.split(':').map(Number);
  return new Date(y, mo - 1, da, h, mi, se).getTime();
};

// ---------------- 盘后计算（scripts/sync.js 调用） ----------------

/**
 * @param db       本地库
 * @param call     sync.js 的限速 + 重试包装
 * @param day      最近一个交易日 YYYYMMDD
 * @param prevDay  前一个交易日
 * @returns true = 成功或无需计算，false = 有失败
 */
export async function syncBreadth({ db, call, day, prevDay }) {
  if (process.env.BREADTH === '0' || !(+(process.env.MINUTE_MONTHS ?? 6) > 0)) return true;
  if (db.prepare('SELECT 1 FROM synced WHERE kind = ? AND date = ?').get(SYNCED_KIND, day)) return true;
  if (!db.prepare("SELECT 1 FROM synced WHERE kind = 'daily' AND date = ?").get(day)) {
    console.log(`[breadth] ${day} 个股日线还没同步，领先指标 / 红绿柱下次再算`);
    return true;
  }

  // 昨收（不复权）+ 复权因子：涨跌幅 = 今价 × 今因子 ÷ (昨收 × 昨因子) − 1，除权当天也算得对
  const prevClose = new Map(db.prepare('SELECT code, close FROM daily WHERE date = ?').all(prevDay).map((r) => [r.code, r.close]));
  const adjOf = (d) => new Map(db.prepare('SELECT code, factor FROM adj WHERE date = ?').all(d).map((r) => [r.code, r.factor]));
  const [adjToday, adjPrev] = [adjOf(day), adjOf(prevDay)];
  const stocks = db.prepare("SELECT code FROM symbols WHERE type = 'stock' AND (code LIKE '%.SH' OR code LIKE '%.SZ' OR code LIKE '%.BJ')").all()
    .map((r) => r.code).filter((c) => prevClose.has(c));
  if (!stocks.length) return true;

  // 成分股指数要用的分组：成分股名单，拿不到时用退路
  const memberOf = await indexMembers(db, call);
  const groups = Object.entries(MARKETS);
  for (const code of MEMBER_INDICES) {
    const set = memberOf.get(code);
    if (set?.size) groups.push([code, (c) => set.has(c)]);
    else if (FALLBACK[code]) groups.push([code, FALLBACK[code]]);
    else console.warn(`[breadth] ${code} 没有成分股数据，不算领先指标 / 红绿柱`);
  }

  const range = { start_date: `${ymdStr(day)} 09:00:00`, end_date: `${ymdStr(day)} 15:30:00` };
  const fetch = (codes) => call(`stk_mins ${codes[0]}${codes.length > 1 ? ` 等 ${codes.length} 只` : ''}`, () =>
    queryPage('stk_mins', { ts_code: codes.join(','), freq: '1min', ...range }, 'ts_code,trade_time,close')).then((r) => r.rows);

  // 先用两只大票探测：当天分钟数据发布了没有、接口能不能一次查多只
  let batch;
  try {
    const probe = ['600000.SH', '000001.SZ'].filter((c) => stocks.includes(c));
    if (probe.length < 2) probe.splice(0, probe.length, stocks[0], stocks[1]);
    const rows = await fetch(probe);
    if (!rows.length) {
      console.log(`[breadth] ${day} 分钟数据还没发布，下次再算`);
      return true;
    }
    batch = new Set(rows.map((r) => r.ts_code)).size >= 2 ? BATCH : 1;
  } catch (err) {
    console.warn(`[breadth] 拉取分钟数据失败（需要 tushare 历史分钟权限）：${err.message}`);
    return false;
  }

  const t0 = Date.now();
  console.log(`[breadth] ${day}：${stocks.length} 只个股的 1 分钟线，${batch > 1 ? `每次 ${batch} 只` : '逐只'}拉取（约 ${Math.ceil(stocks.length / batch)} 次请求）`);
  const closes = new Map(); // code -> [[ts, close], …]
  let errors = 0;
  for (let i = 0; i < stocks.length; i += batch) {
    const codes = stocks.slice(i, i + batch);
    try {
      for (const r of await fetch(codes)) {
        if (!Number.isFinite(+r.close)) continue;
        if (!closes.has(r.ts_code)) closes.set(r.ts_code, []);
        closes.get(r.ts_code).push([parseTime(r.trade_time), +r.close]);
      }
    } catch (err) {
      if (++errors <= 3) console.warn(`  stk_mins ${codes[0]} 失败：${err.message}`);
    }
    if ((i / batch) % 200 === 0) console.log(`  ${Math.min(i + batch, stocks.length)}/${stocks.length}`);
  }
  if (errors > Math.ceil(stocks.length / batch) * 0.05) {
    console.warn(`[breadth] 失败 ${errors} 次，太多，本次不保存，下次重算`);
    return false;
  }

  // 每分钟、每个市场：各股涨跌幅（停牌整天没成交的不算；开盘前还没成交的按 0）
  const times = [...new Set([...closes.values()].flatMap((list) => list.map(([t]) => t)))].sort((a, b) => a - b);
  const out = [];
  for (const [market, test] of groups) {
    const members = [...closes.keys()].filter(test).map((code) => {
      const list = closes.get(code).sort((a, b) => a[0] - b[0]);
      const k = (adjToday.get(code) ?? 1) / ((adjPrev.get(code) ?? adjToday.get(code) ?? 1) * prevClose.get(code));
      return { list, k, j: 0, pct: 0 };
    });
    if (!members.length) continue;
    for (const ts of times) {
      let sum = 0, up = 0, down = 0;
      for (const m of members) {
        while (m.j < m.list.length && m.list[m.j][0] <= ts) m.pct = m.list[m.j++][1] * m.k - 1;
        sum += m.pct;
        if (m.pct > 1e-9) up++; else if (m.pct < -1e-9) down++;
      }
      out.push([market, ts, sum / members.length, up, down]);
    }
  }

  const insert = db.prepare('INSERT OR REPLACE INTO breadth (market, ts, lead, up, down) VALUES (?, ?, ?, ?, ?)');
  const dayStart = parseTime(`${ymdStr(day)} 00:00:00`);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM breadth WHERE ts >= ? AND ts < ?').run(dayStart, dayStart + 86400_000);
    for (const row of out) insert.run(...row);
    db.prepare('DELETE FROM breadth WHERE ts < ?').run(dayStart - KEEP_DAYS * 86400_000);
    db.prepare('INSERT OR REPLACE INTO synced (kind, date) VALUES (?, ?)').run(SYNCED_KIND, day);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`[breadth] ${day} 完成：${closes.size} 只有成交，${times.length} 个分钟点，`
    + `${groups.length} 组（${groups.map(([g]) => g).join(' ')}），用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  return true;
}

/**
 * 成分股指数的成分股：index_members 表，超过 MEMBERS_TTL_DAYS 天或缺某个指数时从 tushare index_weight 刷新
 * （取最近两个月里最新一期的成分）。拉取失败时沿用库里旧的。返回 Map(指数代码 -> Set(个股代码))
 */
async function indexMembers(db, call) {
  const fresh = db.prepare("SELECT value FROM meta WHERE key = 'index_members_at'").get()?.value;
  const have = new Set(db.prepare('SELECT DISTINCT index_code FROM index_members').all().map((r) => r.index_code));
  const stale = !fresh || Date.now() - Number(fresh) > MEMBERS_TTL_DAYS * 86400_000;
  const todo = MEMBER_INDICES.filter((c) => stale || !have.has(c));
  if (todo.length) {
    const end = new Date();
    const start = new Date(end.getTime() - 62 * 86400_000);
    let ok = 0;
    for (const code of todo) {
      try {
        const rows = await call(`index_weight ${code}`, () =>
          queryAll('index_weight', { index_code: code, start_date: ymd(start), end_date: ymd(end) }, 'index_code,con_code,trade_date', 6000));
        if (!rows.length) { console.warn(`[breadth] index_weight ${code} 没有数据`); continue; }
        const latest = rows.reduce((m, r) => (r.trade_date > m ? r.trade_date : m), '');
        const cons = [...new Set(rows.filter((r) => r.trade_date === latest).map((r) => r.con_code))];
        const ins = db.prepare('INSERT OR IGNORE INTO index_members (index_code, stock) VALUES (?, ?)');
        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM index_members WHERE index_code = ?').run(code);
          cons.forEach((c) => ins.run(code, c));
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        ok++;
        console.log(`[breadth] ${code} 成分股 ${cons.length} 只（${latest}）`);
      } catch (err) {
        console.warn(`[breadth] index_weight ${code} 失败：${err.message}`);
      }
    }
    if (ok) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('index_members_at', ?)").run(String(Date.now()));
  }
  const out = new Map();
  for (const r of db.prepare('SELECT index_code, stock FROM index_members').all()) {
    if (!out.has(r.index_code)) out.set(r.index_code, new Set());
    out.get(r.index_code).add(r.stock);
  }
  return out;
}

// ---------------- 读取（adapters/local.js 分时用） ----------------

/**
 * 给指数分时的 bar 补上 lead（领先指标点位 = 昨收 × (1 + 平均涨跌幅)）、up / down（涨跌家数）。
 * 按时间对齐：每根 bar 取不晚于它的最近一个分钟点（指数和个股分钟线的时间戳口径万一不同也能对上）
 */
export function attachBreadth(db, symbol, bars, prevClose) {
  if (!hasBreadth(symbol.code) || !bars.length) return bars;
  const market = MARKET_INDEX[symbol.code] ?? symbol.code;
  const rows = db.prepare('SELECT ts, lead, up, down FROM breadth WHERE market = ? AND ts >= ? AND ts <= ? ORDER BY ts')
    .all(market, bars[0].timestamp - 5 * 60_000, bars.at(-1).timestamp);
  if (!rows.length) return bars;
  let j = -1;
  return bars.map((b) => {
    while (j + 1 < rows.length && rows[j + 1].ts <= b.timestamp) j++;
    if (j < 0) return b;
    const r = rows[j];
    return { ...b, lead: Math.round(prevClose * (1 + r.lead) * 100) / 100, up: r.up, down: r.down };
  });
}
