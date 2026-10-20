const BASE = 'https://quantapi.51ifind.com/api/v1/';
export const FIELDS = 'open,high,low,close,volume,amount';
export const LIMIT_FIELD = 'ths_up_and_down_status_stock';
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
      const err = new Error(`iFinD 接口 ${endpoint} 错误码 ${Number(json.errorcode)}；请在官方错误查询中核对权限、额度和代码`);
      err.code = Number(json.errorcode);
      throw err;
    }
    return json;
  }
  async function ensureToken() {
    if (!token) {
      if (!refreshToken) throw new Error('请配置 IFIND_REFRESH_TOKEN（或 IFIND_ACCESS_TOKEN）');
      const auth = await post('get_access_token', { refresh_token: refreshToken });
      token = auth.data?.access_token;
      if (!token) throw new Error('iFinD 未返回 access_token');
    }
    return token;
  }
  return {
    async query(kind, codes, day, window) {
      await ensureToken();
      const daily = kind === 'daily';
      // 日线顺带取涨跌停状态（个股返回「涨停」等，其他品种为 null），用于板块排行的涨停数
      const body = { codes: codes.join(','), indicators: daily ? `${FIELDS},${LIMIT_FIELD}` : FIELDS,
        ...(daily ? { startdate: day, enddate: day, functionpara: { Interval: 'D', CPS: '1', Fill: 'Omit' } }
          : { starttime: `${day} ${window?.from || '09:30:00'}`, endtime: `${day} ${window?.to || '15:00:00'}`,
            functionpara: { Interval: '1', CPS: 'no', Fill: 'Original', Timeformat: 'BeiJingTime' } }) };
      const result = await post(daily ? 'cmd_history_quotation' : 'high_frequency', { access_token: token }, body);
      return { rows: parseIfind(result), cells: result.dataVol == null || result.dataVol === '' ? NaN : Number(result.dataVol) };
    },
    /** 经济数据库：返回 { series: { 指标ID: [{ time, value }] }, cells }；EDB 额度与行情额度分开计 */
    async edb(ids, startdate, enddate) {
      const result = await post('edb_service', { access_token: await ensureToken() },
        { indicators: ids.join(','), startdate, enddate });
      const series = {};
      for (const t of Array.isArray(result.tables) ? result.tables : []) {
        const id = t.id?.[0];
        if (!id || !Array.isArray(t.time)) continue;
        series[id] = t.time.map((time, i) => ({ time, value: t.value?.[i] }));
      }
      return { series, cells: Number(result.dataVol) };
    },
    /** 实时行情：返回 { rows: [{ code, 字段: 值 }], cells } */
    async realtime(codes, indicators) {
      const result = await post('real_time_quotation', { access_token: await ensureToken() },
        { codes: codes.join(','), indicators });
      const rows = (Array.isArray(result.tables) ? result.tables : []).filter((t) => t.thscode && t.table)
        .map((t) => ({ code: t.thscode, ...Object.fromEntries(Object.entries(t.table).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) }));
      return { rows, cells: Number(result.dataVol) };
    },
    /** 上交所交易日（'YYYY-MM-DD' 列表），不消耗额度 */
    async tradeDates(startdate, enddate) {
      const result = await post('get_trade_dates', { access_token: await ensureToken() }, { marketcode: '212001',
        functionpara: { mode: '1', dateType: '0', period: 'D', dateFormat: '0' }, startdate, enddate });
      const t = Array.isArray(result.tables) ? result.tables[0] : result.tables;
      return (t?.time ?? []).map(String);
    },
    /** 专题报表（超级命令里的 THS_DR）：返回行数组，键为报表字段名；-4001 无数据时返回空数组 */
    async report(reportname, functionpara, outputpara) {
      let result;
      try {
        result = await post('data_pool', { access_token: await ensureToken() }, { reportname, functionpara, outputpara });
      } catch (err) {
        if (err.code === -4001) return [];
        throw err;
      }
      const table = (Array.isArray(result.tables) ? result.tables[0] : result.tables)?.table ?? {};
      const keys = Object.keys(table);
      return (table[keys[0]] ?? []).map((_, i) => Object.fromEntries(keys.map((k) => [k, table[k][i]])));
    },
    /**
     * 证券简称 → { codes: 同花顺代码列表, multiple }。精确匹配同名多个品种时接口报 -6102 且不给候选，
     * 返回 multiple = true，调用方可改用模糊匹配（exact = false，会列出全部候选）
     */
    async thscode(secname, exact = true) {
      let result;
      try {
        result = await post('get_thscode', { access_token: await ensureToken() },
          { secname, functionpara: { mode: 'secname', sectype: '', market: '', tradestatus: '0', isexact: exact ? '1' : '0' } });
      } catch (err) {
        if (err.code === -6101 || err.code === -4001) return { codes: [], multiple: false };
        if (err.code === -6102) return { codes: [], multiple: true };
        throw err;
      }
      const codes = (result.tables?.[0]?.table?.thscode ?? []).flatMap((s) => String(s).split(',')).filter(Boolean);
      return { codes, multiple: false };
    },
  };
}
