import { readSource, ifindConfigured } from '../server/source-config.js';
const source = process.env.SYNC_SOURCE_OVERRIDE || readSource();
const intraday = process.env.IFIND_SYNC_MODE === 'intraday';
// 盘后同步：两个源都拉——tushare 写主库（market.db），iFinD 写独立库（ifind.db）。
// 盘中轮询只拉 iFinD 分钟；排行/宏观在两种模式下都读主库，所以 tushare 失败始终算失败，
// iFinD 失败（如试用额度 -4210）只在当前数据源是 iFinD 时算失败。
let failed = false;

async function run(script) {
  process.exitCode = 0;
  try {
    await import(script);
    return process.exitCode !== 1;
  } catch (err) {
    console.error(`[${script === './sync.js' ? 'sync' : 'ifind'}] 本次未完成：${err.message}`);
    return false;
  }
}

if (!intraday) {
  if (process.env.TUSHARE_TOKEN) failed = !(await run('./sync.js'));
  else console.log('[sync] 未配置 TUSHARE_TOKEN，跳过 Tushare 主库同步');
}
if (ifindConfigured() && (source === 'ifind' || process.env.IFIND_DUAL_SYNC !== '0')) {
  if (!(await run('./sync-ifind.js')) && source === 'ifind') failed = true;
}
process.exitCode = failed ? 1 : 0;
