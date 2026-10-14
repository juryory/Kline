/**
 * 大盘分时的「领先指标」（黄线）和「红绿柱」：盘后用全市场个股的 1 分钟线算出来，存在 breadth 表
 *
 *   领先指标：不按市值加权，各股相对昨收的涨跌幅简单平均（同花顺 / 通达信大盘分时的黄线）
 *   红绿柱：每分钟 上涨家数 − 下跌家数。同花顺原版用的是全市场委买委卖量（盘口），tushare 分钟线里没有，
 *           这里用涨跌家数代替，方向和节奏大体一致
 *
 * 市场划分（对应的指数见 BREADTH_INDEX）：SH 沪市 A 股、SZ 深市 A 股、CY 创业板（30xxxx）、KC 科创板（688xxx）
 * 只算最近一个交易日；每天算一次（synced 表 kind = 'breadth'），分钟数据还没发布时留到下次同步。
 * 需要 tushare 历史分钟权限（MINUTE_MONTHS > 0）；BREADTH=0 关闭。保留最近 BREADTH_KEEP_DAYS 天（默认 30）
 */
import { queryPage } from './tushare-client.js';

export const BREADTH_INDEX = { '000001.SH': 'SH', '399001.SZ': 'SZ', '399006.SZ': 'CY', '000688.SH': 'KC' };
const MARKETS = {
  SH: (code) => code.endsWith('.SH'),
  SZ: (code) => code.endsWith('.SZ'),
  CY: (code) => code.endsWith('.SZ') && code.startsWith('30'),
  KC: (code) => code.endsWith('.SH') && code.startsWith('688'),
};
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
  if (db.prepare("SELECT 1 FROM synced WHERE kind = 'breadth' AND date = ?").get(day)) return true;
  if (!db.prepare("SELECT 1 FROM synced WHERE kind = 'daily' AND date = ?").get(day)) {
    console.log(`[breadth] ${day} 个股日线还没同步，领先指标 / 红绿柱下次再算`);
    return true;
  }

  // 昨收（不复权）+ 复权因子：涨跌幅 = 今价 × 今因子 ÷ (昨收 × 昨因子) − 1，除权当天也算得对
  const prevClose = new Map(db.prepare('SELECT code, close FROM daily WHERE date = ?').all(prevDay).map((r) => [r.code, r.close]));
  const adjOf = (d) => new Map(db.prepare('SELECT code, factor FROM adj WHERE date = ?').all(d).map((r) => [r.code, r.factor]));
  const [adjToday, adjPrev] = [adjOf(day), adjOf(prevDay)];
  const stocks = db.prepare("SELECT code FROM symbols WHERE type = 'stock' AND (code LIKE '%.SH' OR code LIKE '%.SZ')").all()
    .map((r) => r.code).filter((c) => prevClose.has(c));
  if (!stocks.length) return true;

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
  for (const [market, test] of Object.entries(MARKETS)) {
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
    db.prepare("INSERT OR REPLACE INTO synced (kind, date) VALUES ('breadth', ?)").run(day);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`[breadth] ${day} 完成：${closes.size} 只有成交，${times.length} 个分钟点，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  return true;
}

// ---------------- 读取（adapters/local.js 分时用） ----------------

/**
 * 给指数分时的 bar 补上 lead（领先指标点位 = 昨收 × (1 + 平均涨跌幅)）、up / down（涨跌家数）。
 * 按时间对齐：每根 bar 取不晚于它的最近一个分钟点（指数和个股分钟线的时间戳口径万一不同也能对上）
 */
export function attachBreadth(db, symbol, bars, prevClose) {
  const market = BREADTH_INDEX[symbol.code];
  if (!market || !bars.length) return bars;
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
