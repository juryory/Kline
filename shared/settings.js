/**
 * 导播台「设置」：指标参数 + 直播画面尺寸 / 底色 + 副图高度 + 画线粗细。服务端（校验、落盘）和前端（设置面板、画图）共用。
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
/** 画线粗细（px，按直播画面基准尺寸；画面放大时按比例加粗） */
export const DRAW_LINE_LIMITS = { min: 0.5, max: 6 };
export const DRAW_LINE_PRESETS = [1, 1.5, 2, 3, 4];
/** 直播画面的设计基准尺寸；尺寸变大时字号、线宽按比例放大 */
export const BASE_SIZE = { width: 966, height: 320 };
/**
 * 安全区外：直播画面左右两侧各留 side px（直播时容易被裁掉），只铺底色、不放内容。
 * 每侧最多占画面宽度的 SAFE_SIDE_MAX；底色透明度 0～100（%）
 */
export const SAFE_SIDE_MAX = 0.3;
// color / opacity 是整个直播画面的底色：K 线面板和两侧安全区外用同一个颜色
// borderWidth / borderColor：安全区外靠内容一侧的竖边框（px，0 = 不画），画在安全区外里面，不占内容宽度
// topWidth / topColor：整个画面（K 线和安全区外）最上方的横边框（px，0 = 不画），盖在画面上，不占内容高度
export const DEFAULT_SAFE_AREA = { side: 0, color: '#140709', opacity: 100, borderWidth: 0, borderColor: '#c8161d', topWidth: 0, topColor: '#c8161d' };
export const SAFE_BORDER_MAX = 20;
/** 页头品牌文字「围炉财经 · 数据中台」：字号按 966×320 基准（画面放大时按比例放大），颜色 */
export const BRAND_SIZE_LIMITS = { min: 8, max: 40 };
export const DEFAULT_BRAND = { size: 12, color: '#9b8a8a' };
/** 页头字号：标的名称 / 最新价 / 涨跌幅，按 966×320 基准（画面放大时按比例放大） */
export const HEAD_FONT_LIMITS = { min: 8, max: 60 };
export const DEFAULT_HEAD_FONT = { name: 20, price: 22, pct: 14 };
/** 页头 logo 高度：按 966×320 基准（画面放大时按比例放大），0 = 不显示；上传的图片最大 LOGO_MAX_BYTES */
export const LOGO_HEIGHT_LIMITS = { min: 0, max: 80 };
export const DEFAULT_LOGO = { height: 24 };
export const LOGO_MAX_BYTES = 512 * 1024;
/** 副图高度（px）：导播台按实际像素；直播画面按 966×320 基准，画面放大时按比例加高 */
export const SUB_PANE_LIMITS = { control: { min: 60, max: 400 }, render: { min: 30, max: 160 } };
export const DEFAULT_SUB_PANE = { control: 140, render: 60 };

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
  drawLine: 1.5,
  safeArea: { ...DEFAULT_SAFE_AREA },
  subPane: { ...DEFAULT_SUB_PANE },
  brand: { ...DEFAULT_BRAND },
  headFont: { ...DEFAULT_HEAD_FONT },
  logo: { ...DEFAULT_LOGO },
};

/** 安全区外宽度校验（每侧，px）：不合法返回错误描述 */
export function checkSafeSide(v, width) {
  const max = Math.floor(width * SAFE_SIDE_MAX);
  return Number.isInteger(v) && v >= 0 && v <= max ? null : `0~${max} 的整数`;
}
export const checkSafeOpacity = (v) => (Number.isInteger(v) && v >= 0 && v <= 100 ? null : '0~100 的整数');
export const checkSafeColor = (v) => (/^#[0-9a-f]{6}$/i.test(v ?? '') ? null : '颜色格式 #rrggbb');
export const checkSafeBorder = (v) => (Number.isInteger(v) && v >= 0 && v <= SAFE_BORDER_MAX ? null : `0~${SAFE_BORDER_MAX} 的整数`);
export const checkHeadFont = (v) => {
  const { min, max } = HEAD_FONT_LIMITS;
  return Number.isInteger(v) && v >= min && v <= max ? null : `${min}~${max} 的整数`;
};
export const checkLogoHeight = (v) => {
  const { min, max } = LOGO_HEIGHT_LIMITS;
  return Number.isInteger(v) && v >= min && v <= max ? null : `${min}~${max} 的整数`;
};
export const checkBrandSize = (v) => {
  const { min, max } = BRAND_SIZE_LIMITS;
  return Number.isInteger(v) && v >= min && v <= max ? null : `${min}~${max} 的整数`;
};

/** 副图高度校验（k = control / render）：不合法返回错误描述 */
export function checkSubPane(k, v) {
  const { min, max } = SUB_PANE_LIMITS[k];
  return Number.isInteger(v) && v >= min && v <= max ? null : `${min}~${max} 的整数`;
}

/** 画线粗细校验：不合法返回错误描述 */
export function checkDrawLine(v) {
  const { min, max } = DRAW_LINE_LIMITS;
  return Number.isFinite(v) && v >= min && v <= max ? null : `${min}~${max} 之间的数`;
}

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
  const drawLine = Number(raw?.drawLine);
  const render = { width: size('width'), height: size('height') };
  // 安全区外：旧版本没有这一项，用默认值；单项不合法时回退
  const prevSafe = fallback.safeArea ?? DEFAULT_SAFE_AREA;
  const side = Number(raw?.safeArea?.side);
  const opacity = Number(raw?.safeArea?.opacity);
  const color = raw?.safeArea?.color;
  const borderWidth = Number(raw?.safeArea?.borderWidth);
  const borderColor = raw?.safeArea?.borderColor;
  const topWidth = Number(raw?.safeArea?.topWidth);
  const topColor = raw?.safeArea?.topColor;
  const safeArea = {
    side: checkSafeSide(side, render.width) ? Math.min(prevSafe.side, Math.floor(render.width * SAFE_SIDE_MAX)) : side,
    color: checkSafeColor(color) ? prevSafe.color : color.toLowerCase(),
    opacity: checkSafeOpacity(opacity) ? prevSafe.opacity : opacity,
    // 旧版本没有边框：不画
    borderWidth: checkSafeBorder(borderWidth) ? prevSafe.borderWidth ?? DEFAULT_SAFE_AREA.borderWidth : borderWidth,
    borderColor: checkSafeColor(borderColor) ? prevSafe.borderColor ?? DEFAULT_SAFE_AREA.borderColor : borderColor.toLowerCase(),
    topWidth: checkSafeBorder(topWidth) ? prevSafe.topWidth ?? DEFAULT_SAFE_AREA.topWidth : topWidth,
    topColor: checkSafeColor(topColor) ? prevSafe.topColor ?? DEFAULT_SAFE_AREA.topColor : topColor.toLowerCase(),
  };
  const prevBrand = fallback.brand ?? DEFAULT_BRAND;
  const brandSize = Number(raw?.brand?.size);
  const brand = {
    size: checkBrandSize(brandSize) ? prevBrand.size : brandSize,
    color: checkSafeColor(raw?.brand?.color) ? prevBrand.color : raw.brand.color.toLowerCase(),
  };
  const prevSub = fallback.subPane ?? DEFAULT_SUB_PANE;
  const subPane = Object.fromEntries(Object.keys(SUB_PANE_LIMITS).map((k) => {
    const v = Number(raw?.subPane?.[k]);
    return [k, checkSubPane(k, v) ? prevSub[k] : v];
  }));
  const prevFont = fallback.headFont ?? DEFAULT_HEAD_FONT;
  const headFont = Object.fromEntries(Object.keys(DEFAULT_HEAD_FONT).map((k) => {
    const v = Number(raw?.headFont?.[k]);
    return [k, checkHeadFont(v) ? prevFont[k] ?? DEFAULT_HEAD_FONT[k] : v];
  }));
  const logoHeight = Number(raw?.logo?.height);
  const logo = { height: checkLogoHeight(logoHeight) ? (fallback.logo ?? DEFAULT_LOGO).height : logoHeight };
  return {
    indicators,
    render,
    safeArea,
    subPane,
    brand,
    headFont,
    logo,
    // 旧版本的设置里没有这一项：用默认值
    drawLine: checkDrawLine(drawLine) ? fallback.drawLine ?? DEFAULT_SETTINGS.drawLine : Math.round(drawLine * 10) / 10,
  };
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

/** 放内容的区域：画面宽度去掉两侧安全区外 */
export function contentSize(settings) {
  const side = settings?.safeArea?.side ?? 0;
  return { width: settings.render.width - side * 2, height: settings.render.height };
}

/** 直播画面底色（带透明度）：K 线面板和两侧安全区外共用 */
export function safeAreaFill({ color, opacity }) {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity / 100})`;
}

/** 字号、线宽等的放大倍数：按宽高里放大得少的那个算，避免溢出 */
export const renderScale = ({ width, height }) =>
  Math.max(0.6, Math.min(width / BASE_SIZE.width, height / BASE_SIZE.height));
