import { readSource, ifindConfigured } from '../server/source-config.js';
const source = process.env.SYNC_SOURCE_OVERRIDE || readSource();
// 定时同步：两个源都拉——tushare 写主库（market.db），iFinD 写独立库（ifind.db）。
// iFinD 部分失败（如试用额度 -4210）不影响主库同步结果。
await import('./sync.js');
if (ifindConfigured() && process.env.IFIND_DUAL_SYNC !== '0') {
  try {
    await import('./sync-ifind.js');
  } catch (err) {
    console.error(`[ifind] 本次未完成：${err.message}`);
  }
}
