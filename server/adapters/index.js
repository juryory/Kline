/**
 * 数据源适配器注册表。
 *
 * 每个适配器导出：
 *   label: string                       页脚显示的数据来源
 *   getDaily(symbol) => Promise<Bar[]>  日线，按时间正序
 *   getIntraday?(symbol) => Promise<{ prevClose, bars: Bar[] }>  可选，分时，1 分钟一根；个股的 Bar 带 avg（均价线），指数不带
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

const adapters = { mock, tushare, local };

const name = process.env.DATA_SOURCE || 'mock';
if (!adapters[name]) {
  throw new Error(`未知 DATA_SOURCE: ${name}（可选：${Object.keys(adapters).join(', ')}）`);
}

export const adapterName = name;
export default adapters[name];
