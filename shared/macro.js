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
