const BASE = 'https://quantapi.51ifind.com/api/v1/';
export const FIELDS = 'open,high,low,close,volume,amount';
export const chinaDate = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
export const dateNumber = (s) => Number(s.replaceAll('-', '').slice(0, 8));

export function parseIfind(result) {
  if (!Array.isArray(result.tables)) throw new Error('iFinD 返回格式异常：缺少 tables');
  const rows = [];
  for (const t of result.tables) {
    if (!t.thscode || !Array.isArray(t.time) || !t.table || typeof t.table !== 'object') {
      // 空表（仅 thscode，无 time/table）= 该标的当日无数据（停牌/未上市），跳过不中断
      if (t && t.thscode && t.time == null && t.table == null) continue;
      throw new Error('iFinD 返回格式异常：缺少 thscode / time / table');
    }
    for (let i = 0; i < t.time.length; i++) {
      const r = { code: t.thscode, time: t.time[i] };
      for (const [field, values] of Object.entries(t.table)) r[field] = Array.isArray(values) ? values[i] : values;
      rows.push(r);
    }
  }
  return rows;
}

// 统一为库中日线「手/千元」、分钟「股/元」。特殊证券可在映射文件指定原始单位。
export function normalizeIfind(row, kind, { volumeUnit = 'share', amountUnit = 'yuan', allowMissingAmount = false } = {}) {
  const number = (v) => v === null || v === undefined || v === '' ? NaN : Number(v);
  const prices = ['open', 'high', 'low', 'close'].map((k) => number(row[k]));
  const volume = number(row.volume), amount = number(row.amount);
  if (!prices.every((v) => Number.isFinite(v) && v > 0) || !Number.isFinite(volume) || volume < 0
    || (!(allowMissingAmount && (row.amount == null || row.amount === '')) && (!Number.isFinite(amount) || amount < 0))) return null;
  const [open, high, low, close] = prices;
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return null;
  const text = String(row.time).replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(text)) return null;
  const ts = Date.parse(`${text.slice(0, 10)}T${text.slice(11) || '00:00:00'}+08:00`);
  if (!Number.isFinite(ts) || chinaDate(ts) !== text.slice(0, 10)) return null;
  const shares = volume * (volumeUnit === 'lot' ? 100 : 1);
  const yuan = Number.isFinite(amount) ? amount * (amountUnit === 'thousand' ? 1000 : 1) : null;
  return { date: dateNumber(text.slice(0, 10)), ts, open, high, low, close,
    vol: kind === 'daily' ? shares / 100 : shares, amount: kind === 'daily' && yuan != null ? yuan / 1000 : yuan };
}

export function createIfindClient({ fetchImpl = fetch, refreshToken = process.env.IFIND_REFRESH_TOKEN,
  accessToken = process.env.IFIND_ACCESS_TOKEN, intervalMs = 250 } = {}) {
  let token = refreshToken ? null : accessToken, lastCall = 0;
  async function post(endpoint, headers, body) {
    const wait = Math.max(0, lastCall + intervalMs - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();
    let response;
    try {
      response = await fetchImpl(BASE + endpoint, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    } catch { throw new Error('iFinD 网络请求失败；本次停止，稍后可断点续传'); }
    if (!response.ok) throw new Error(`iFinD HTTP ${response.status}`);
    let json;
    try { json = await response.json(); } catch { throw new Error('iFinD 返回了非 JSON 数据'); }
    if (Number(json.errorcode) !== 0) {
      // 不输出原始响应，避免认证错误回显 token。
      throw new Error(`iFinD 接口 ${endpoint} 错误码 ${Number(json.errorcode)}；请在官方错误查询中核对权限、额度和代码`);
    }
    return json;
  }
  return {
    async query(kind, codes, day, window) {
      if (!token) {
        if (!refreshToken) throw new Error('请配置 IFIND_REFRESH_TOKEN（或 IFIND_ACCESS_TOKEN）');
        const auth = await post('get_access_token', { refresh_token: refreshToken });
        token = auth.data?.access_token;
        if (!token) throw new Error('iFinD 未返回 access_token');
      }
      const daily = kind === 'daily';
      const body = { codes: codes.join(','), indicators: FIELDS,
        ...(daily ? { startdate: day, enddate: day, functionpara: { Interval: 'D', CPS: '1', Fill: 'Omit' } }
          : { starttime: `${day} ${window?.from || '09:30:00'}`, endtime: `${day} ${window?.to || '15:00:00'}`,
            functionpara: { Interval: '1', CPS: 'no', Fill: 'Original', Timeformat: 'BeiJingTime' } }) };
      const result = await post(daily ? 'cmd_history_quotation' : 'high_frequency', { access_token: token }, body);
      return { rows: parseIfind(result), cells: result.dataVol == null || result.dataVol === '' ? NaN : Number(result.dataVol) };
    },
  };
}
