// Tushare Pro HTTP 客户端：https://tushare.pro/document/1?doc_id=130
// 适配器（实时拉）和 scripts/sync.js（盘后同步）共用

const API = process.env.TUSHARE_API || 'http://api.tushare.pro';

/** 单次调用，返回 { rows, hasMore } */
export async function queryPage(apiName, params = {}, fields = '') {
  const token = process.env.TUSHARE_TOKEN;
  if (!token) throw new Error('未配置 TUSHARE_TOKEN');

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_name: apiName, token, params, fields }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`tushare HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) {
    const err = new Error(`tushare ${apiName}: ${json.msg}`);
    err.tushareCode = json.code;
    // 限流可以等一会儿重试；权限不足、参数错误等重试也没用
    err.retryable = /每分钟|每小时|频|too many|limit/i.test(json.msg ?? '');
    throw err;
  }

  const { fields: keys, items, has_more: hasMore } = json.data;
  return { rows: items.map((row) => Object.fromEntries(keys.map((k, i) => [k, row[i]]))), hasMore };
}

export async function query(apiName, params, fields) {
  return (await queryPage(apiName, params, fields)).rows;
}

/** 分页拉全：优先看接口返回的 has_more，没有这个字段时以"不满一页"为结束 */
export async function queryAll(apiName, params, fields, pageSize = 6000) {
  const out = [];
  for (let offset = 0; ; ) {
    const { rows, hasMore } = await queryPage(apiName, { ...params, limit: pageSize, offset }, fields);
    out.push(...rows);
    offset += rows.length;
    if (!rows.length || hasMore === false || (hasMore === undefined && rows.length < pageSize)) return out;
  }
}

export const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** 'YYYYMMDD' 或 20260928 → 当天 0 点的时间戳 */
export function ymdToTs(v) {
  const s = String(v);
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getTime();
}
