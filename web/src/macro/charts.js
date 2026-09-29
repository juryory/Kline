/**
 * 宏观图表：把数据集行（见 shared/macro.js）变成 { title, asOf, note?, kpis, option }。
 * 导播台（terminal：有 tooltip、可缩放）和直播画面（按 scale 放大字号）共用。
 */
const C = {
  up: '#f0444a', down: '#16a36a', axis: '#9b8a8a', text: '#e8e8ec',
  lines: ['#f0c89a', '#8fa6e8', '#d98ee0', '#6fd3c7', '#e0e070', '#ff9f68'],
};

// ---------------- 格式化 ----------------
const num = (v) => (v == null || v === '' || Number.isNaN(+v) ? null : +v);
const f = (v, d = 2) => (num(v) == null ? '--' : num(v).toFixed(d));
const signed = (v, d = 2, suffix = '') => (num(v) == null ? '--' : `${num(v) > 0 ? '+' : ''}${num(v).toFixed(d)}${suffix}`);
const trendOf = (v) => (num(v) == null || num(v) === 0 ? '' : num(v) > 0 ? 'up' : 'down');
const bp = (a, b) => (num(a) == null || num(b) == null ? null : (num(a) - num(b)) * 100);

const dayLabel = (p) => `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`;
const monthLabel = (p) => `${p.slice(0, 4)}-${p.slice(4, 6)}`;

// ---------------- ECharts 公共样式 ----------------
function makeBase({ scale = 1, terminal = false }) {
  const fs = Math.round((terminal ? 12 : 11) * scale);
  const lw = 1.6 * scale;
  const axisLabel = { color: C.axis, fontSize: fs, hideOverlap: true };
  let win = null; // 默认显示窗口：{ n 最近多少个点, len 总点数 }
  return {
    fs, lw,
    // 图表加载全部历史，默认只显示最近 n 个点（导播台缩放可看更早，直播画面同步）
    window: (rows, n) => { win = { n, len: rows.length }; return rows; },
    getWindow: () => win,
    root: (extra) => ({
      backgroundColor: 'transparent',
      animationDuration: 300,
      textStyle: { color: C.axis, fontSize: fs, fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif' },
      grid: { left: 6 * scale, right: 6 * scale, top: 26 * scale, bottom: terminal ? 30 : 4 * scale, containLabel: true },
      legend: {
        top: 0, right: 0, itemWidth: 14 * scale, itemHeight: 8 * scale, icon: 'roundRect',
        textStyle: { color: '#cfcfd8', fontSize: fs },
      },
      // 直播画面没有鼠标：提示框只由导播台悬停位置触发（triggerOn: none + showTip），缩放只由导播台驱动
      tooltip: {
        trigger: 'axis',
        ...(terminal ? {} : { triggerOn: 'none' }),
        backgroundColor: 'rgba(28,28,34,0.92)', borderColor: '#33333d',
        textStyle: { color: C.text, fontSize: terminal ? 12 : fs },
        valueFormatter: (v) => (v == null ? '--' : (+v).toFixed(2)),
      },
      dataZoom: terminal
        ? [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 4, borderColor: '#33333d', textStyle: { color: C.axis } }]
        : [{ type: 'inside', zoomOnMouseWheel: false, moveOnMouseMove: false, moveOnMouseWheel: false, preventDefaultMouseMove: false }],
      ...extra,
    }),
    xCat: (data, extra) => ({
      type: 'category', data, boundaryGap: false,
      axisLine: { lineStyle: { color: '#3a2a2c' } }, axisTick: { show: false }, axisLabel, ...extra,
    }),
    yVal: (extra) => ({
      type: 'value', scale: true,
      axisLabel: { ...axisLabel, hideOverlap: false }, nameTextStyle: { color: C.axis, fontSize: fs },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)', type: 'dashed' } }, ...extra,
    }),
    line: (name, data, color, extra) => ({
      type: 'line', name, data, showSymbol: false, connectNulls: true, sampling: 'lttb', // 全部历史点很多，缩小时降采样
      lineStyle: { width: lw, color }, itemStyle: { color }, emphasis: { disabled: true }, ...extra,
    }),
    bar: (name, data, extra) => ({ type: 'bar', name, data, barMaxWidth: 18 * scale, ...extra }),
    // 参考线（0 轴、50 荣枯线）
    refLine: (y, label) => ({
      silent: true, symbol: 'none', label: { show: !!label, formatter: label, color: C.axis, fontSize: fs, position: 'insideEndTop' },
      lineStyle: { color: 'rgba(255,255,255,0.35)', type: 'dashed', width: 1 }, data: [{ yAxis: y }],
    }),
    upDown: (v, base = 0) => (num(v) == null ? C.axis : num(v) >= base ? C.up : C.down),
  };
}

const kpi = (label, value, extra = {}) => ({ label, value, ...extra });

// ---------------- 各图表 ----------------
const BUILDERS = {
  /** Shibor：多期限日频折线，近一年 */
  shibor({ shibor }, b) {
    const rows = b.window(shibor, 250);
    const last = rows.at(-1), prev = rows.at(-2);
    const terms = [['on', '隔夜'], ['1w', '1周'], ['1m', '1个月'], ['3m', '3个月'], ['1y', '1年']];
    return {
      title: 'Shibor 上海银行间同业拆放利率',
      asOf: dayLabel(last.period),
      kpis: terms.filter(([k]) => k !== '1m').map(([k, label]) => kpi(label, `${f(last[k], 3)}%`, {
        delta: `${signed(bp(last[k], prev?.[k]), 1)}bp`, trend: trendOf(bp(last[k], prev?.[k])),
      })),
      option: b.root({
        xAxis: b.xCat(rows.map((r) => dayLabel(r.period))),
        yAxis: b.yVal({ axisLabel: { color: C.axis, fontSize: b.fs, formatter: '{value}%' } }),
        series: terms.map(([k, label], i) => b.line(label, rows.map((r) => num(r[k])), C.lines[i])),
      }),
    };
  },

  /** LPR：只在调整时变化，用阶梯线 */
  lpr({ lpr }, b) {
    const rows = b.window(lpr, 90); // 默认显示约 2019 年 LPR 改革以来
    const last = rows.at(-1);
    const lastChange = (k) => {
      for (let i = rows.length - 1; i > 0; i--) {
        if (num(rows[i][k]) !== num(rows[i - 1][k])) return { date: rows[i].period, d: bp(rows[i][k], rows[i - 1][k]) };
      }
      return null;
    };
    const card = (k, label) => {
      const c = lastChange(k);
      return kpi(label, `${f(last[k])}%`, c ? {
        delta: `${dayLabel(c.date)} ${c.d < 0 ? '下调' : '上调'} ${Math.abs(c.d).toFixed(0)}bp`, trend: trendOf(c.d),
      } : {});
    };
    return {
      title: 'LPR 贷款市场报价利率',
      asOf: dayLabel(last.period),
      kpis: [card('1y', '1年期 LPR'), card('5y', '5年期以上 LPR')],
      option: b.root({
        xAxis: b.xCat(rows.map((r) => dayLabel(r.period))),
        yAxis: b.yVal({ axisLabel: { color: C.axis, fontSize: b.fs, formatter: '{value}%' } }),
        series: [
          b.line('1年期', rows.map((r) => num(r['1y'])), C.lines[0], { step: 'end' }),
          b.line('5年期以上', rows.map((r) => num(r['5y'])), C.lines[1], { step: 'end' }),
        ],
      }),
    };
  },

  /** 美债收益率曲线：横轴是期限，对比最新 / 1个月前 / 1年前，看形态与倒挂 */
  ust_curve({ ust }, b) {
    const terms = [['m1', '1月'], ['m3', '3月'], ['m6', '6月'], ['y1', '1年'], ['y2', '2年'], ['y3', '3年'],
      ['y5', '5年'], ['y7', '7年'], ['y10', '10年'], ['y20', '20年'], ['y30', '30年']];
    const last = ust.at(-1);
    const back = (n) => ust[Math.max(0, ust.length - 1 - n)];
    const curves = [['最新', last, C.lines[0]], ['1个月前', back(21), C.lines[1]], ['1年前', back(250), C.lines[2]]];
    const spread = bp(last.y10, last.y2);
    return {
      title: '美国国债收益率曲线',
      asOf: dayLabel(last.period),
      kpis: [
        kpi('2年期', `${f(last.y2)}%`, { delta: `${signed(bp(last.y2, ust.at(-2)?.y2), 1)}bp`, trend: trendOf(bp(last.y2, ust.at(-2)?.y2)) }),
        kpi('10年期', `${f(last.y10)}%`, { delta: `${signed(bp(last.y10, ust.at(-2)?.y10), 1)}bp`, trend: trendOf(bp(last.y10, ust.at(-2)?.y10)) }),
        kpi('10Y−2Y 利差', `${signed(spread, 0)}bp`, { delta: spread < 0 ? '倒挂' : '正常', trend: trendOf(spread) }),
      ],
      option: b.root({
        xAxis: b.xCat(terms.map(([, l]) => l), { boundaryGap: false }),
        yAxis: b.yVal({ axisLabel: { color: C.axis, fontSize: b.fs, formatter: '{value}%' } }),
        series: curves.map(([name, row, color], i) => b.line(`${name} ${dayLabel(row.period)}`, terms.map(([k]) => num(row[k])), color, {
          showSymbol: true, symbolSize: 5 * (b.lw / 1.6), lineStyle: { width: i === 0 ? b.lw * 1.6 : b.lw, color, type: i === 0 ? 'solid' : 'dashed' },
        })),
      }),
    };
  },

  /** 美债走势：2年、10年收益率 + 10Y−2Y 利差柱（负值 = 倒挂） */
  ust_trend({ ust }, b) {
    const rows = b.window(ust, 500);
    const last = rows.at(-1);
    const spreads = rows.map((r) => bp(r.y10, r.y2));
    return {
      title: '美国国债收益率走势',
      asOf: dayLabel(last.period),
      kpis: [
        kpi('2年期', `${f(last.y2)}%`),
        kpi('10年期', `${f(last.y10)}%`),
        kpi('10Y−2Y 利差', `${signed(spreads.at(-1), 0)}bp`, { trend: trendOf(spreads.at(-1)) }),
      ],
      option: b.root({
        xAxis: b.xCat(rows.map((r) => dayLabel(r.period)), { boundaryGap: true }),
        yAxis: [
          b.yVal({ axisLabel: { color: C.axis, fontSize: b.fs, formatter: '{value}%' } }),
          b.yVal({ position: 'right', splitLine: { show: false }, axisLabel: { color: C.axis, fontSize: b.fs, formatter: '{value}bp' } }),
        ],
        series: [
          b.bar('10Y−2Y 利差', spreads.map((v) => ({ value: v, itemStyle: { color: b.upDown(v), opacity: 0.45 } })), { yAxisIndex: 1, barCategoryGap: 0, itemStyle: { color: C.up } }),
          b.line('2年期', rows.map((r) => num(r.y2)), C.lines[0]),
          b.line('10年期', rows.map((r) => num(r.y10)), C.lines[1]),
        ],
      }),
    };
  },

  /** GDP：单季 GDP 柱（由累计值推算）+ 当季同比折线，近 5 年 */
  gdp({ gdp }, b) {
    const withSingle = gdp.map((r, i) => {
      const q = +r.period.slice(5);
      const prev = gdp[i - 1];
      const single = q === 1 || !prev || prev.period.slice(0, 4) !== r.period.slice(0, 4) ? num(r.gdp) : num(r.gdp) - num(prev.gdp);
      return { ...r, single };
    });
    const rows = b.window(withSingle, 20);
    const last = rows.at(-1);
    return {
      title: '国内生产总值 GDP',
      asOf: last.period,
      kpis: [
        kpi('当季同比', `${f(last.gdp_yoy, 1)}%`, { trend: trendOf(last.gdp_yoy) }),
        kpi('累计 GDP', `${f(num(last.gdp) / 10000)}万亿`),
        kpi('一产 / 二产 / 三产', `${f(last.pi_yoy, 1)} / ${f(last.si_yoy, 1)} / ${f(last.ti_yoy, 1)}%`),
      ],
      option: b.root({
        xAxis: b.xCat(rows.map((r) => r.period), { boundaryGap: true }),
        yAxis: [
          b.yVal({ name: '万亿元', scale: false, axisLabel: { color: C.axis, fontSize: b.fs } }),
          b.yVal({ position: 'right', splitLine: { show: false }, axisLabel: { color: C.axis, fontSize: b.fs, formatter: '{value}%' } }),
        ],
        series: [
          b.bar('单季 GDP', rows.map((r) => (r.single == null ? null : +(r.single / 10000).toFixed(2))), { itemStyle: { color: C.lines[1], opacity: 0.8 } }),
          b.line('当季同比', rows.map((r) => num(r.gdp_yoy)), C.lines[0], { yAxisIndex: 1, showSymbol: true, symbolSize: 5 }),
        ],
      }),
    };
  },

  /** PMI：制造业柱（≥50 红 / <50 绿）+ 非制造业、综合折线 + 50 荣枯线 */
  pmi({ pmi }, b) {
    const rows = b.window(pmi, 36);
    const last = rows.at(-1), prev = rows.at(-2);
    const card = (k, label) => kpi(label, f(last[k], 1), {
      delta: `${num(last[k]) >= 50 ? '扩张' : '收缩'} ${signed(num(last[k]) - num(prev?.[k]), 1)}`, trend: num(last[k]) >= 50 ? 'up' : 'down',
    });
    return {
      title: 'PMI 采购经理指数',
      asOf: monthLabel(last.period),
      kpis: [card('pmi010000', '制造业 PMI'), card('pmi020100', '非制造业商务活动'), card('pmi030000', '综合 PMI 产出'), card('pmi010500', '新订单指数')],
      option: b.root({
        xAxis: b.xCat(rows.map((r) => monthLabel(r.period)), { boundaryGap: true }),
        yAxis: b.yVal(),
        series: [
          b.bar('制造业 PMI', rows.map((r) => ({ value: num(r.pmi010000), itemStyle: { color: b.upDown(r.pmi010000, 50) } })), { markLine: b.refLine(50, '荣枯线 50'), itemStyle: { color: C.up } }),
          b.line('非制造业商务活动', rows.map((r) => num(r.pmi020100)), C.lines[0]),
          b.line('综合 PMI 产出', rows.map((r) => num(r.pmi030000)), C.lines[1]),
        ],
      }),
    };
  },

  /** CPI 与 PPI 同比折线 + 0 轴，近 5 年 */
  cpi_ppi({ cpi, ppi }, b) {
    const pmap = new Map(ppi.map((r) => [r.period, r]));
    const rows = b.window(cpi.filter((r) => pmap.has(r.period)), 60);
    const last = rows.at(-1), lp = pmap.get(last.period);
    return {
      title: 'CPI · PPI 物价指数',
      asOf: monthLabel(last.period),
      kpis: [
        kpi('CPI 同比', `${signed(last.nt_yoy, 1, '%')}`, { trend: trendOf(last.nt_yoy) }),
        kpi('CPI 环比', `${signed(last.nt_mom, 1, '%')}`, { trend: trendOf(last.nt_mom) }),
        kpi('PPI 同比', `${signed(lp.ppi_yoy, 1, '%')}`, { trend: trendOf(lp.ppi_yoy) }),
        kpi('PPI 环比', `${signed(lp.ppi_mom, 1, '%')}`, { trend: trendOf(lp.ppi_mom) }),
      ],
      option: b.root({
        xAxis: b.xCat(rows.map((r) => monthLabel(r.period))),
        yAxis: b.yVal({ axisLabel: { color: C.axis, fontSize: b.fs, formatter: '{value}%' } }),
        series: [
          b.line('CPI 同比', rows.map((r) => num(r.nt_yoy)), C.lines[0], { markLine: b.refLine(0) }),
          b.line('PPI 同比', rows.map((r) => num(pmap.get(r.period)?.ppi_yoy)), C.lines[1]),
        ],
      }),
    };
  },

  /** 货币供应量：M1、M2 同比 + M1−M2 剪刀差柱，近 5 年 */
  money({ money }, b) {
    const rows = b.window(money, 60);
    const last = rows.at(-1);
    const gap = (r) => (num(r.m1_yoy) == null || num(r.m2_yoy) == null ? null : +(num(r.m1_yoy) - num(r.m2_yoy)).toFixed(2));
    return {
      title: '货币供应量 M1 · M2',
      asOf: monthLabel(last.period),
      kpis: [
        kpi('M2 余额', `${f(num(last.m2) / 10000)}万亿`),
        kpi('M2 同比', `${f(last.m2_yoy, 1)}%`),
        kpi('M1 同比', `${f(last.m1_yoy, 1)}%`),
        kpi('M1−M2 剪刀差', `${signed(gap(last), 1)}`, { trend: trendOf(gap(last)) }),
      ],
      option: b.root({
        xAxis: b.xCat(rows.map((r) => monthLabel(r.period)), { boundaryGap: true }),
        yAxis: b.yVal({ axisLabel: { color: C.axis, fontSize: b.fs, formatter: '{value}%' } }),
        series: [
          b.bar('M1−M2 剪刀差', rows.map((r) => ({ value: gap(r), itemStyle: { color: b.upDown(gap(r)), opacity: 0.5 } })), { markLine: b.refLine(0), itemStyle: { color: C.up } }),
          b.line('M2 同比', rows.map((r) => num(r.m2_yoy)), C.lines[0]),
          b.line('M1 同比', rows.map((r) => num(r.m1_yoy)), C.lines[1]),
        ],
      }),
    };
  },

  /** 社融：当月增量柱 + 存量同比折线（由存量推算），近 3 年 */
  sf({ sf }, b) {
    const byMonth = new Map(sf.map((r) => [r.period, r]));
    const yoyOf = (r) => {
      const y = +r.period.slice(0, 4) - 1;
      const ago = byMonth.get(`${y}${r.period.slice(4)}`);
      return num(r.stk_endval) && num(ago?.stk_endval) ? +((num(r.stk_endval) / num(ago.stk_endval) - 1) * 100).toFixed(2) : null;
    };
    const rows = b.window(sf, 36);
    const last = rows.at(-1);
    return {
      title: '社会融资规模',
      asOf: monthLabel(last.period),
      kpis: [
        kpi('当月增量', `${f(num(last.inc_month) / 10000)}万亿`, { trend: trendOf(last.inc_month) }),
        kpi('今年累计增量', `${f(num(last.inc_cumval) / 10000)}万亿`),
        kpi('存量', `${f(last.stk_endval)}万亿`),
        kpi('存量同比', `${f(yoyOf(last), 1)}%`),
      ],
      option: b.root({
        xAxis: b.xCat(rows.map((r) => monthLabel(r.period)), { boundaryGap: true }),
        yAxis: [
          b.yVal({ name: '万亿元', scale: false, axisLabel: { color: C.axis, fontSize: b.fs } }),
          b.yVal({ position: 'right', splitLine: { show: false }, axisLabel: { color: C.axis, fontSize: b.fs, formatter: '{value}%' } }),
        ],
        series: [
          b.bar('当月增量', rows.map((r) => ({ value: num(r.inc_month) == null ? null : +(num(r.inc_month) / 10000).toFixed(2), itemStyle: { color: b.upDown(r.inc_month), opacity: 0.8 } })), { itemStyle: { color: C.up } }),
          b.line('存量同比', rows.map(yoyOf), C.lines[0], { yAxisIndex: 1 }),
        ],
      }),
    };
  },

  /** 融资融券：两融余额面积 + 融资买入额柱，近一年 */
  margin({ margin }, b) {
    const rows = b.window(margin, 250);
    const last = rows.at(-1), prev = rows.at(-2);
    const chg = prev ? (num(last.rzrqye) - num(prev.rzrqye)) / 1e8 : null;
    return {
      title: '融资融券（沪深北合计）',
      asOf: dayLabel(last.period),
      kpis: [
        kpi('两融余额', `${f(num(last.rzrqye) / 1e12)}万亿`, { delta: `较前日 ${signed(chg, 1)}亿`, trend: trendOf(chg) }),
        kpi('融资余额', `${f(num(last.rzye) / 1e12)}万亿`),
        kpi('融资买入额', `${f(num(last.rzmre) / 1e8, 0)}亿`),
        kpi('融券余额', `${f(num(last.rqye) / 1e8, 1)}亿`),
      ],
      option: b.root({
        xAxis: b.xCat(rows.map((r) => dayLabel(r.period)), { boundaryGap: true }),
        yAxis: [
          b.yVal({ name: '万亿元', axisLabel: { color: C.axis, fontSize: b.fs } }),
          b.yVal({ name: '亿元', position: 'right', splitLine: { show: false }, axisLabel: { color: C.axis, fontSize: b.fs } }),
        ],
        series: [
          b.bar('融资买入额', rows.map((r) => (num(r.rzmre) == null ? null : Math.round(num(r.rzmre) / 1e8))), { yAxisIndex: 1, itemStyle: { color: C.lines[1], opacity: 0.35 }, barCategoryGap: '20%' }),
          b.line('两融余额', rows.map((r) => (num(r.rzrqye) == null ? null : +(num(r.rzrqye) / 1e12).toFixed(3))), C.lines[0], {
            areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(240,200,154,0.35)' }, { offset: 1, color: 'rgba(240,200,154,0.02)' }] } },
          }),
        ],
      }),
    };
  },
};

/** 生成图表；数据缺失时返回 { error } */
export function buildMacro(viewKey, data, opts) {
  const builder = BUILDERS[viewKey];
  if (!builder) return { error: `未知图表 ${viewKey}` };
  if (!data || Object.values(data).some((rows) => !rows?.length)) return { error: '暂无数据，请先运行 npm run sync' };
  try {
    const b = makeBase(opts);
    const built = builder(data, b);
    // 默认显示窗口 → 初始缩放（百分比）。导播台没缩放过（state.macro.zoom = null）时两端都按这个显示
    const win = b.getWindow();
    const defaultZoom = win && win.len > win.n
      ? { start: +((1 - win.n / win.len) * 100).toFixed(2), end: 100 }
      : { start: 0, end: 100 };
    built.option.dataZoom = (built.option.dataZoom ?? []).map((dz) => ({ ...dz, ...defaultZoom }));
    return { ...built, defaultZoom };
  } catch (err) {
    return { error: `图表生成失败：${err.message}` };
  }
}
