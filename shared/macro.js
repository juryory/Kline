/**
 * 宏观数据：数据集（同步用）+ 图表视图（导播台 / 直播画面用）。服务端、同步脚本、前端共用。
 */

/**
 * 数据集：一个 tushare 接口对应一个数据集，存在本地库 macro 表。
 * kind 决定时间范围参数与 period 格式：daily = YYYYMMDD，month = YYYYMM，quarter = YYYYQn
 * 同步范围由 MACRO_YEARS 控制（默认 all = 全部历史）；图表默认显示最近一段（见 web/src/macro/charts.js 的 WINDOWS）
 * pageSize = 接口单次最大行数；aggregate = 同一天多行（如三个交易所）按日加总
 */
export const MACRO_DATASETS = {
  shibor: { api: 'shibor', kind: 'daily', periodField: 'date', fields: 'date,on,1w,2w,1m,3m,6m,9m,1y', pageSize: 2000 },
  lpr: { api: 'shibor_lpr', kind: 'daily', periodField: 'date', fields: 'date,1y,5y', pageSize: 4000 },
  ust: { api: 'us_tycr', kind: 'daily', periodField: 'date', fields: 'date,m1,m2,m3,m4,m6,y1,y2,y3,y5,y7,y10,y20,y30', pageSize: 2000 },
  gdp: { api: 'cn_gdp', kind: 'quarter', periodField: 'quarter', fields: 'quarter,gdp,gdp_yoy,pi,pi_yoy,si,si_yoy,ti,ti_yoy', pageSize: 5000 },
  cpi: { api: 'cn_cpi', kind: 'month', periodField: 'month', fields: 'month,nt_val,nt_yoy,nt_mom,town_yoy,cnt_yoy', pageSize: 5000 },
  ppi: { api: 'cn_ppi', kind: 'month', periodField: 'month', fields: 'month,ppi_yoy,ppi_mom,ppi_mp_yoy,ppi_cg_yoy', pageSize: 5000 },
  money: { api: 'cn_m', kind: 'month', periodField: 'month', fields: 'month,m0,m0_yoy,m1,m1_yoy,m2,m2_yoy', pageSize: 5000 },
  sf: { api: 'sf_month', kind: 'month', periodField: 'month', fields: 'month,inc_month,inc_cumval,stk_endval', pageSize: 2000 },
  pmi: { api: 'cn_pmi', kind: 'month', periodField: 'month', fields: 'month,pmi010000,pmi010400,pmi010500,pmi020100,pmi030000', pageSize: 5000 },
  margin: {
    api: 'margin', kind: 'daily', periodField: 'trade_date', fields: 'trade_date,exchange_id,rzye,rzmre,rqye,rzrqye',
    pageSize: 4000, aggregate: ['rzye', 'rzmre', 'rqye', 'rzrqye'],
  },
};

/**
 * iFinD 经济数据库（EDB）指标 ID → 上面 tushare 数据集的字段名，图表不用区分来源。
 * 已逐期核对：数值、单位与 tushare 一致；edbScale = 换算到 tushare 单位的倍数。
 * 没列出的字段（如 PMI 非制造业商务活动、综合 PMI 产出）仍由 tushare 补，见 server/adapters/ifind.js
 * 货币供应量暂未映射：M0037864xx 系列是季度数据，需月度指标 ID
 */
export const MACRO_EDB = {
  shibor: { on: 'M002816448', '1w': 'M002816449', '2w': 'M002816450', '1m': 'M002816451', '3m': 'M002816452', '6m': 'M002816453', '9m': 'M002816454', '1y': 'M002816455' },
  lpr: { '1y': 'L004609506', '5y': 'L004609507' },
  ust: { m1: 'L015211679', m3: 'L015211680', m6: 'L015211681', y1: 'L015211682', y2: 'L015211683', y3: 'L015211684', y5: 'L015211685', y7: 'L015211686', y10: 'L015211687', y20: 'L015211688', y30: 'L015211689' },
  gdp: { gdp: 'M001620326', gdp_yoy: 'M002822183', pi_yoy: 'M002822184', si_yoy: 'M002822185', ti_yoy: 'M002822186' },
  cpi: { nt_val: 'M001624503', nt_yoy: 'M002826730', nt_mom: 'M002826785' },
  ppi: { ppi_yoy: 'M002826865', ppi_mom: 'M002842661', ppi_mp_yoy: 'M002826873' },
  sf: { inc_month: 'M004891015', inc_cumval: 'M004891016', stk_endval: 'M004891020' },
  pmi: { pmi010000: 'M002043802', pmi010400: 'M002043803', pmi010500: 'M002043804' },
  // iFinD 是沪深两市（tushare 含北交所，约高 0.3%），单位亿元
  margin: { rzye: 'S004273887', rzmre: 'S004273886', rqye: 'S004273889', rzrqye: 'S004273890', edbScale: 1e8 },
};

/** EDB 的日期 → 数据集 period：daily YYYYMMDD，month YYYYMM，quarter YYYYQn */
export function edbPeriod(time, kind) {
  const d = String(time).slice(0, 10);
  if (kind === 'quarter') return `${d.slice(0, 4)}Q${Math.ceil(+d.slice(5, 7) / 3)}`;
  if (kind === 'month') return d.slice(0, 7).replace('-', '');
  return d.replaceAll('-', '');
}

/** 宏观页的分组与图表（view）。datasets = 这张图要用到的数据集 */
export const MACRO_GROUPS = [
  { key: 'rates', label: '利率' },
  { key: 'growth', label: '增长' },
  { key: 'price', label: '物价' },
  { key: 'money', label: '货币' },
  { key: 'margin', label: '两融' },
];

export const MACRO_VIEWS = [
  { key: 'shibor', group: 'rates', label: 'Shibor', datasets: ['shibor'] },
  { key: 'lpr', group: 'rates', label: 'LPR', datasets: ['lpr'] },
  { key: 'ust_curve', group: 'rates', label: '美债曲线', datasets: ['ust'] },
  { key: 'ust_trend', group: 'rates', label: '美债走势', datasets: ['ust'] },
  { key: 'gdp', group: 'growth', label: 'GDP', datasets: ['gdp'] },
  { key: 'pmi', group: 'growth', label: 'PMI', datasets: ['pmi'] },
  { key: 'cpi_ppi', group: 'price', label: 'CPI · PPI', datasets: ['cpi', 'ppi'] },
  { key: 'money', group: 'money', label: '货币供应量', datasets: ['money'] },
  { key: 'sf', group: 'money', label: '社融', datasets: ['sf'] },
  { key: 'margin', group: 'margin', label: '融资融券', datasets: ['margin'] },
];

export const findMacroView = (key) => MACRO_VIEWS.find((v) => v.key === key);
export const DEFAULT_MACRO = { view: 'shibor', zoom: null, legend: null };
