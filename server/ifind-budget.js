export function weekKey(now = Date.now()) {
  const date = new Date(now + 8 * 3600_000);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
export function quotaConfig() {
  return {
    profile: process.env.IFIND_QUOTA_PROFILE || 'trial',
    total: Number(process.env.IFIND_WEEKLY_BUDGET || 150_000_000),
    history: Number(process.env.IFIND_HISTORY_BUDGET || 100_000_000),
    reserve: Number(process.env.IFIND_RESERVE_BUDGET || 20_000_000),
  };
}
export function validateQuota(config) {
  if (!['trial', 'free'].includes(config.profile)) throw new Error('IFIND_QUOTA_PROFILE 仅支持 trial / free');
  if (![config.total, config.history, config.reserve].every(v => Number.isSafeInteger(v) && v >= 0)
    || config.total <= 0 || config.reserve >= config.total || config.history > config.total - config.reserve) {
    throw new Error('iFinD 周预算无效：历史预算不得超过总额减保留额度');
  }
}
export function quotaStatus(db, now = Date.now(), config = quotaConfig()) {
  const week = weekKey(now);
  const rows = db.prepare('SELECT lane,SUM(cells) AS cells FROM ifind_weekly_usage WHERE week=? GROUP BY lane').all(week);
  const used = rows.reduce((n,r) => n+r.cells, 0);
  return { ...config, week, used, remaining: Math.max(0, config.total - used),
    historyUsed: rows.find(r => r.lane === 'history')?.cells ?? 0,
    measurement: '本机预留及返回 dataVol；不含其他程序或终端的使用量' };
}
export function reserveWeekly(db, now, lane, kind, cells, config = quotaConfig()) {
  validateQuota(config);
  if (!['fresh', 'history'].includes(lane) || !Number.isSafeInteger(cells) || cells < 0) throw new Error('额度预留参数错误');
  db.exec('BEGIN IMMEDIATE');
  try {
    const status = quotaStatus(db, now, config);
    if (status.used + cells > config.total - config.reserve
      || lane === 'history' && status.historyUsed + cells > config.history) {
      throw new Error('iFinD 本周共享预算不足，已保留断点；下周一北京时间零点重新计账');
    }
    db.prepare(`INSERT INTO ifind_weekly_usage VALUES (?,?,?,?)
      ON CONFLICT(week,lane,kind) DO UPDATE SET cells=cells+excluded.cells`).run(status.week, lane, kind, cells);
    db.exec('COMMIT');
    return status.week;
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
export function reconcileWeekly(db, week, lane, kind, estimate, actual) {
  if (Number.isSafeInteger(actual) && actual >= 0) db.prepare(
    'UPDATE ifind_weekly_usage SET cells=cells+? WHERE week=? AND lane=? AND kind=?')
    .run(actual-estimate, week, lane, kind);
}
