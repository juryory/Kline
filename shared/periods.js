/**
 * K 线周期：服务端（server/index.js）和前端（web/src/view.js）共用
 *
 * kind
 *   intraday  分时：最近一个交易日的 1 分钟数据
 *   minute    分钟 K：tushare 历史分钟（stk_mins / idx_mins，需单独开通），本地库缓存最近 MINUTE_MONTHS 个月
 *   daily     日线及由日线聚合的周 / 月 / 年 K
 * 顺序 = 从小到大：导播台回车往左（更细），Backspace 往右（更粗）
 */
export const PERIODS = [
  { key: 'T', label: '分时', kind: 'intraday' },
  { key: 'm5', label: '5分', kind: 'minute', freq: 5 },
  { key: 'm15', label: '15分', kind: 'minute', freq: 15 },
  { key: 'm30', label: '30分', kind: 'minute', freq: 30 },
  { key: 'm60', label: '60分', kind: 'minute', freq: 60 },
  { key: 'D', label: '日K', kind: 'daily' },
  { key: 'W', label: '周K', kind: 'daily' },
  { key: 'M', label: '月K', kind: 'daily' },
  { key: 'Y', label: '年K', kind: 'daily' },
];

export const PERIOD_KEYS = PERIODS.map((p) => p.key);
export const findPeriod = (key) => PERIODS.find((p) => p.key === key);
export const isMinutePeriod = (key) => findPeriod(key)?.kind === 'minute';

/** 周期按钮收起时只显示这些（当前选中的周期不在里面时也会显示） */
export const PRIMARY_PERIODS = ['T', 'D', 'W', 'M'];

/** 有分钟数据的标的：个股和指数。同花顺 / 申万等板块 tushare 不提供分钟线 */
export const hasMinuteData = (symbol) => !!symbol && (symbol.type === 'stock' || (symbol.type === 'index' && !symbol.category));
export const isIfindDomestic = s => !!s && ['stock','index','etf'].includes(s.type)
  && /\.(SH|SZ|BJ|TI|SI)$/i.test(s.code)
  && (!s.category || ['ETF','THN','THI','THR','SW1'].includes(s.category));

/**
 * 当前数据源 + 标的可用的周期
 * caps = { intraday, minutes }：数据源是否支持分时 / 分钟 K（服务端 status 里的开关）
 * symbol 不传时不按标的过滤
 */
export function periodsFor(caps = {}, symbol = null) {
  const minuteOk = symbol ? (caps.indexOnly ? isIfindDomestic(symbol) && symbol.type !== 'stock' : hasMinuteData(symbol)) : true;
  return PERIODS.filter((p) => {
    if (p.kind === 'intraday') return caps.intraday !== false && minuteOk;
    if (p.kind === 'minute') return !!caps.minutes && minuteOk;
    return true;
  });
}
