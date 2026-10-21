/**
 * 数据源适配器注册表。
 *
 * 每个适配器导出：
 *   label: string                       页脚显示的数据来源
 *   getDaily(symbol) => Promise<Bar[]>  日线，按时间正序
 *   getIntraday?(symbol, date?) => Promise<{ prevClose, bars: Bar[] }>  可选，分时，1 分钟一根；个股的 Bar 带 avg（均价线），指数不带；
 *     date = 'YYYY-MM-DD' 取历史某天（没有那天的数据时抛错）
 *                                    不导出则导播台不显示「分时」
 *   getMinutes?(symbol, freq) => Promise<Bar[]>  可选，分钟 K，freq = 5 / 15 / 30 / 60，时间戳 = 该根结束时刻
 *                                    不导出则导播台不显示 5分 / 15分 / 30分 / 60分
 *   listSymbols?() => Promise<{code,name,type}[]>  可选，扩充检索用的标的池
 *   Bar = { timestamp(ms), open, high, low, close, volume }
 *
 * 换数据商：新建一个适配器文件，在下面注册，再改 .env 里的 DATA_SOURCE。
 */
import * as mock from './mock.js';
import * as tushare from './tushare.js';
import * as local from './local.js';
import * as ifind from './ifind.js';
import { readSource, saveSource, ifindConfigured } from '../source-config.js';

const adapters = { mock, tushare, local, ifind };

const name = readSource();
if (!adapters[name]) {
  throw new Error(`未知 DATA_SOURCE: ${name}（可选：${Object.keys(adapters).join(', ')}）`);
}

export let adapterName = name;
export const currentAdapter = () => adapters[adapterName];
export function switchAdapter(source) {
  saveSource(source);
  adapterName = source;
}
export function sourceInfo() {
  return { source: adapterName, ifindConfigured: ifindConfigured(),
    options: [{ value: 'local', label: 'Tushare 本地库' }, { value: 'ifind', label: 'iFinD（历史缺口用 Tushare）' }],
    adjustment: adapterName === 'ifind' ? '不复权' : '股票 / ETF 前复权',
  };
}
export default new Proxy({}, { get: (_target, key) => currentAdapter()[key] });
