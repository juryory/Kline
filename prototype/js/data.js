/**
 * 数据层：假数据生成 + tushare 适配 + 日线聚合成周/月线
 * KLineChart 需要的格式：{ timestamp, open, high, low, close, volume }
 */
(function (global) {
  // 可复现的伪随机数，保证每次刷新看到的走势一致
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 生成 count 个交易日（跳过周末）的日 K 假数据，收盘价最终落在 endClose 附近 */
  function mockDaily({ count = 500, endClose = 4353.47, endDate = new Date(), seed = 20260928 } = {}) {
    const rand = mulberry32(seed);
    const days = [];
    const d = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    while (days.length < count) {
      const w = d.getDay();
      if (w !== 0 && w !== 6) days.unshift(d.getTime());
      d.setDate(d.getDate() - 1);
    }

    const list = [];
    let close = 3000;
    for (let i = 0; i < count; i++) {
      const prev = close;
      const drift = 0.0006 + 0.0012 * Math.sin(i / 45);
      const pct = drift + (rand() - 0.5) * 0.022;
      const open = prev * (1 + (rand() - 0.5) * 0.006);
      close = prev * (1 + pct);
      const high = Math.max(open, close) * (1 + rand() * 0.006);
      const low = Math.min(open, close) * (1 - rand() * 0.006);
      const volume = Math.round((3.2e10 + rand() * 2.4e10) * (1 + Math.abs(pct) * 20));
      list.push({ timestamp: days[i], open, high, low, close, volume });
    }

    // 整体缩放，让最后一根收盘价等于 endClose
    const k = endClose / list[list.length - 1].close;
    const r2 = (v) => Math.round(v * k * 100) / 100;
    return list.map((b) => ({ ...b, open: r2(b.open), high: r2(b.high), low: r2(b.low), close: r2(b.close) }));
  }

  /**
   * tushare 日线（pro.index_daily / pro.daily）→ KLineChart 格式
   * 输入行字段：trade_date 'YYYYMMDD', open, high, low, close, vol（手）
   * tushare 返回按日期倒序，这里统一转成正序
   */
  function fromTushare(rows) {
    return rows
      .map((r) => {
        const s = String(r.trade_date);
        return {
          timestamp: new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getTime(),
          open: +r.open, high: +r.high, low: +r.low, close: +r.close,
          volume: +r.vol,
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /** 日线聚合：period = 'W' | 'M'，时间戳取该周期最后一个交易日 */
  function aggregate(daily, period) {
    if (period === 'D') return daily;
    const keyOf = (ts) => {
      const d = new Date(ts);
      if (period === 'M') return d.getFullYear() * 100 + d.getMonth();
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
      return monday.getTime();
    };
    const out = [];
    let cur = null, curKey = null;
    for (const b of daily) {
      const k = keyOf(b.timestamp);
      if (k !== curKey) {
        cur && out.push(cur);
        cur = { ...b };
        curKey = k;
      } else {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += b.volume;
        cur.timestamp = b.timestamp;
      }
    }
    cur && out.push(cur);
    return out;
  }

  global.KData = { mockDaily, fromTushare, aggregate };
})(window);
