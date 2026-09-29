/**
 * 导播台「设置」：指标参数 + 直播画面尺寸。服务端（校验、落盘）和前端（设置面板、画图）共用。
 */

/** 指标参数规格。list = 可增减的一组周期；fields = 固定个数的参数 */
export const INDICATOR_SPECS = {
  MA: { label: 'MA 均线', kind: 'list', min: 1, max: 250, maxCount: 6, itemLabel: (v) => `MA${v}` },
  EMA: { label: 'EMA 指数均线', kind: 'list', min: 1, max: 250, maxCount: 6, itemLabel: (v) => `EMA${v}` },
  BOLL: {
    label: 'BOLL 布林线', kind: 'fields',
    fields: [{ label: '周期', min: 2, max: 250 }, { label: '标准差倍数', min: 0.5, max: 5, step: 0.1 }],
  },
  SAR: {
    label: 'SAR 抛物线', kind: 'fields',
    fields: [{ label: '起始加速(%)', min: 1, max: 20 }, { label: '加速步长(%)', min: 1, max: 20 }, { label: '最大加速(%)', min: 5, max: 100 }],
  },
  MACD: {
    label: 'MACD', kind: 'fields',
    fields: [{ label: '短周期', min: 1, max: 250 }, { label: '长周期', min: 2, max: 250 }, { label: 'DEA 周期', min: 1, max: 250 }],
    check: ([s, l]) => s < l, checkMsg: '短周期必须小于长周期',
  },
  KDJ: {
    label: 'KDJ', kind: 'fields',
    fields: [{ label: 'N', min: 1, max: 250 }, { label: 'M1', min: 1, max: 250 }, { label: 'M2', min: 1, max: 250 }],
  },
  RSI: { label: 'RSI', kind: 'list', min: 1, max: 250, maxCount: 3, itemLabel: (v) => `RSI${v}` },
};

export const RENDER_LIMITS = { width: { min: 320, max: 3840 }, height: { min: 160, max: 2160 } };
/** 直播画面的设计基准尺寸；尺寸变大时字号、线宽按比例放大 */
export const BASE_SIZE = { width: 966, height: 320 };

export const DEFAULT_SETTINGS = {
  indicators: {
    MA: [5, 10],
    EMA: [6, 12, 20],
    BOLL: [20, 2],
    SAR: [2, 2, 20],
    MACD: [12, 26, 9],
    KDJ: [9, 3, 3],
    RSI: [6, 12, 24],
  },
  render: { ...BASE_SIZE },
};

const inRange = (v, { min, max, step }) =>
  Number.isFinite(v) && v >= min && v <= max && (step ? true : Number.isInteger(v));

/** 校验一个指标的参数，不合法返回错误描述，合法返回 null */
export function checkIndicator(key, params) {
  const spec = INDICATOR_SPECS[key];
  if (!Array.isArray(params)) return '参数格式错误';
  if (spec.kind === 'list') {
    if (params.length < 1 || params.length > spec.maxCount) return `需要 1~${spec.maxCount} 个周期`;
    if (!params.every((v) => inRange(v, spec))) return `周期需为 ${spec.min}~${spec.max} 的整数`;
    if (new Set(params).size !== params.length) return '周期不能重复';
    return null;
  }
  if (params.length !== spec.fields.length) return '参数个数错误';
  for (let i = 0; i < params.length; i++) {
    const f = spec.fields[i];
    if (!inRange(params[i], f)) return `${f.label}需为 ${f.min}~${f.max}${f.step ? '' : ' 的整数'}`;
  }
  if (spec.check && !spec.check(params)) return spec.checkMsg;
  return null;
}

/** 规整设置：不合法的项回退到 fallback（默认或上一次的值） */
export function cleanSettings(raw, fallback = DEFAULT_SETTINGS) {
  const indicators = {};
  for (const key of Object.keys(INDICATOR_SPECS)) {
    const v = raw?.indicators?.[key];
    let params = Array.isArray(v) ? v.map(Number) : null;
    if (params && INDICATOR_SPECS[key].kind === 'list') params = [...params].sort((a, b) => a - b);
    indicators[key] = params && !checkIndicator(key, params) ? params : fallback.indicators[key];
  }
  const size = (k) => {
    const v = Math.round(Number(raw?.render?.[k]));
    const { min, max } = RENDER_LIMITS[k];
    return Number.isFinite(v) && v >= min && v <= max ? v : fallback.render[k];
  };
  return { indicators, render: { width: size('width'), height: size('height') } };
}

/**
 * 直播合规：「隐藏个股」开启且当前是个股时，直播画面上名称打码、代码不显示。
 * 指数、同花顺板块/概念不受影响。
 */
export const isSymbolMasked = (state, symbol) => !!(state?.hideSymbol && symbol?.type === 'stock');

const MASK = '＊';
/** 名称打码：保留首尾字，中间替换。贵州茅台 → 贵＊＊台，五粮液 → 五＊液，两个字 → 首字＋＊ */
export function maskName(name) {
  const chars = [...name];
  if (chars.length <= 1) return MASK;
  if (chars.length === 2) return chars[0] + MASK;
  return chars[0] + MASK.repeat(chars.length - 2) + chars[chars.length - 1];
}

/** 字号、线宽等的放大倍数：按宽高里放大得少的那个算，避免溢出 */
export const renderScale = ({ width, height }) =>
  Math.max(0.6, Math.min(width / BASE_SIZE.width, height / BASE_SIZE.height));
