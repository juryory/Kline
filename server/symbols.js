/**
 * 标的池 + 检索。
 * 支持：代码（000001）、名称（上证指数）、拼音首字母（SZZS）、全拼（shangzhengzhishu）
 *
 * 标的来源：下面的内置列表 + 适配器的 listSymbols()（可选，例如 tushare 的全部 A 股）
 * type 决定 tushare 调哪个接口（index → index_daily，stock → daily）
 */
import { pinyin } from 'pinyin-pro';

// 常用指数和几只个股；mock.endClose 只给假数据定价位用
const BUILTIN = [
  { code: '000001.SH', name: '上证指数', type: 'index', mock: { endClose: 4353.47 } },
  { code: '399001.SZ', name: '深证成指', type: 'index', mock: { endClose: 13850.2 } },
  { code: '399006.SZ', name: '创业板指', type: 'index', mock: { endClose: 2890.6 } },
  { code: '000300.SH', name: '沪深300', type: 'index', mock: { endClose: 4620.3 } },
  { code: '000016.SH', name: '上证50', type: 'index', mock: { endClose: 3010.8 } },
  { code: '000905.SH', name: '中证500', type: 'index', mock: { endClose: 7120.4 } },
  { code: '000852.SH', name: '中证1000', type: 'index', mock: { endClose: 7480.9 } },
  { code: '000688.SH', name: '科创50', type: 'index', mock: { endClose: 1320.5 } },
  { code: '000680.SH', name: '科创综指', type: 'index', mock: { endClose: 1480.6 } },
  { code: '899050.BJ', name: '北证50', type: 'index', mock: { endClose: 1510.2 } },
  { code: '600519.SH', name: '贵州茅台', type: 'stock', mock: { endClose: 1480.0 } },
  { code: '601318.SH', name: '中国平安', type: 'stock', mock: { endClose: 58.6 } },
  { code: '000001.SZ', name: '平安银行', type: 'stock', mock: { endClose: 12.3 } },
  { code: '300750.SZ', name: '宁德时代', type: 'stock', mock: { endClose: 268.4 } },
  { code: '600900.SH', name: '长江电力', type: 'stock', mock: { endClose: 29.8 } },
  { code: '000858.SZ', name: '五粮液', type: 'stock', mock: { endClose: 128.5 } },
  { code: '600036.SH', name: '招商银行', type: 'stock', mock: { endClose: 44.2 } },
  { code: '002594.SZ', name: '比亚迪', type: 'stock', mock: { endClose: 362.0 } },
  { code: '600132.SH', name: '重庆啤酒', type: 'stock', mock: { endClose: 58.9 } },
];

const opt = { toneType: 'none', type: 'array', nonZh: 'consecutive', v: true };

function withSearchKeys(s) {
  const lower = (arr) => arr.join('').toLowerCase().replace(/\s+/g, '');
  return {
    ...s,
    _digits: s.code.split('.')[0].toLowerCase(), // 期货 / 外汇代码有字母（AUZL、DINI）
    _name: s.name.toLowerCase(),
    _full: lower(pinyin(s.name, opt)),
    _initials: lower(pinyin(s.name, { ...opt, pattern: 'first' })),
  };
}

export const BUILTIN_INDICES = BUILTIN.filter((s) => s.type === 'index');

let universe = BUILTIN.map(withSearchKeys);
let byCode = new Map(universe.map((s) => [s.code, s]));

/** 用适配器提供的列表扩充标的池；内置项优先（保留 type/mock 设置） */
export async function loadUniverse(adapter) {
  if (!adapter.listSymbols) return;
  try {
    const extra = await adapter.listSymbols();
    const merged = [...BUILTIN];
    const seen = new Set(BUILTIN.map((s) => s.code));
    for (const s of extra) if (!seen.has(s.code)) { seen.add(s.code); merged.push(s); }
    const before = universe.length;
    universe = merged.map(withSearchKeys);
    byCode = new Map(universe.map((s) => [s.code, s]));
    if (universe.length !== before) console.log(`[symbols] 标的池 ${universe.length} 个`);
  } catch (err) {
    console.error('[symbols] 拉取标的列表失败，使用内置列表：', err.message);
  }
}

export const findSymbol = (code) => byCode.get(code);
export const defaultSymbol = () => BUILTIN[0].code;
export const publicSymbol = ({ code, name, type, category }) => ({ code, name, type, category });

/** 分数越小越靠前；不匹配返回 Infinity */
function score(s, q) {
  if (s._digits === q || s.code.toLowerCase() === q || s._name === q || s._initials === q || s._full === q) return 0;
  if (s._digits.startsWith(q) || s._initials.startsWith(q) || s._name.startsWith(q)) return 1;
  if (s._full.startsWith(q)) return 2;
  if (s._name.includes(q) || s._initials.includes(q) || s._full.includes(q)) return 3;
  return Infinity;
}

export function search(query, limit = 20) {
  const q = String(query ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return [];
  return universe
    .map((s, i) => ({ s, i, sc: score(s, q) }))
    .filter((x) => x.sc !== Infinity)
    .sort((a, b) => a.sc - b.sc || (a.s.type === 'index' ? 0 : 1) - (b.s.type === 'index' ? 0 : 1) || a.i - b.i)
    .slice(0, limit)
    .map((x) => publicSymbol(x.s));
}
