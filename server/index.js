/**
 * 直播 K 线后端：状态中心 + 行情推送 + 生产环境静态托管
 *
 * WebSocket /ws?role=render|control|preview
 *   服务端 → 客户端
 *     { type: 'state',  state }                       导播状态（标的/周期/显示/视图/指标/设置）
 *     { type: 'data',   symbol, period, source, bars, quote, prevClose? }
 *                       当前要画的 K 线；quote = 当日最新价与昨收（页头用）；分时带昨收
 *     { type: 'rank',   list, listName, date, sort, desc, top, rows }  上屏的板块排名（scene = rank 时）
 *     { type: 'hover',  scope, view, index }            导播台鼠标悬停的数据点（宏观图），直播画面同步显示提示框
 *     { type: 'status', error, clients, updatedAt }    给控制台看的运行状态
 *   控制台 → 服务端
 *     { type: 'set', patch }   修改状态
 *     { type: 'refresh' }      强制重新拉取行情
 *     { type: 'hover', scope, view, index }  悬停位置（不落盘，原样转发）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import adapter, { adapterName } from './adapters/index.js';
import { findSymbol, defaultSymbol, loadUniverse, search, publicSymbol } from './symbols.js';
import { getDaily, getIntraday, aggregate } from './market.js';
import { DEFAULT_SETTINGS, cleanSettings } from '../shared/settings.js';
import { RANK_LISTS, RANK_SORTS, sortRows } from './rank.js';
import { MACRO_DATASETS, DEFAULT_MACRO, findMacroView } from '../shared/macro.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STATE_FILE = path.resolve(ROOT, process.env.STATE_FILE || '.runtime/state.json');
const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const REFRESH_MS = +(process.env.REFRESH_MS || 5 * 60_000);
const INTRADAY_REFRESH_MS = +(process.env.INTRADAY_REFRESH_MS || 30_000);
// T = 分时，只有数据源实现了 getIntraday 才开放（本地库只有日线）
const HAS_INTRADAY = typeof adapter.getIntraday === 'function';
const PERIODS = HAS_INTRADAY ? ['T', 'D', 'W', 'M'] : ['D', 'W', 'M'];
// 可选指标，与 web/src/indicators.js 一致；null = 不显示
const MAIN_INDICATORS = ['MA', 'EMA', 'BOLL', 'SAR'];
const SUB_INDICATORS = ['VOL', 'AMT', 'MACD', 'KDJ', 'RSI'];
// 板块排名：数据源实现了 getRanking 才开放（本地库）
const HAS_RANK = typeof adapter.getRanking === 'function';
const HAS_MACRO = typeof adapter.getMacro === 'function';
// 直播画面内容（= 导播台当前页）。以后加页面在这里加一项，值 = 当前数据源是否支持
const SCENES = { kline: true, rank: HAS_RANK, macro: HAS_MACRO };
const DEFAULT_RANK = { list: 'THN', sort: 'pct', desc: true, top: 10 };
// 视图：显示 bars 根 K 线，最右一根的时间戳为 end（null = 跟随最新）
const MIN_BARS = 40; // 与 web/src/view.js 一致
const MAX_BARS = 1000; // 板块和指数有多年历史，缩小到约 4 年日线 / 20 年周线
const DEFAULT_VIEW = { bars: 60, end: null };

// ---------------- 状态（落盘，重启后恢复导播上次的设置） ----------------
const DEFAULT_STATE = {
  symbol: defaultSymbol(), period: 'D', visible: true, view: DEFAULT_VIEW, main: 'MA', sub: 'VOL',
  settings: DEFAULT_SETTINGS,
  watchlist: [],       // 自选：[{ code, name, type, category }]，按加入顺序
  hideSymbol: true,    // 隐藏个股：直播画面上个股名称打码、代码不显示（指数和板块不受影响），默认开启
  scene: 'kline',      // 直播画面内容 = 导播台当前页：kline = K 线，rank = 板块排名
  rank: DEFAULT_RANK,  // 上屏的排名：列表 / 排序列 / 降序 / 前 N 名
  macro: DEFAULT_MACRO, // 宏观数据页当前图表：{ view }，见 shared/macro.js
  drawings: {},        // K 线画线：{ 标的代码: [{ id, name, points: [{ t 时间戳, v 价格 }], text? }] }，各周期共用
};

// 画线：可用的图形（KLineChart 内置 overlay），与 web/src/drawTools.js 一致
const DRAW_TOOLS = ['segment', 'rayLine', 'straightLine', 'horizontalStraightLine', 'priceLine',
  'parallelStraightLine', 'priceChannelLine', 'fibonacciLine', 'simpleAnnotation'];
const MAX_DRAWINGS = 50; // 每个标的

function cleanDrawing(d) {
  if (!d || typeof d.id !== 'string' || d.id.length > 40 || !DRAW_TOOLS.includes(d.name)) return null;
  const points = Array.isArray(d.points)
    ? d.points.filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.v)).slice(0, 5).map((p) => ({ t: p.t, v: p.v }))
    : [];
  if (!points.length) return null;
  return { id: d.id, name: d.name, points, ...(typeof d.text === 'string' && { text: d.text.slice(0, 40) }) };
}

function cleanDrawings(all) {
  const out = {};
  for (const [code, list] of Object.entries(all && typeof all === 'object' ? all : {})) {
    const clean = (Array.isArray(list) ? list : []).map(cleanDrawing).filter(Boolean).slice(0, MAX_DRAWINGS);
    if (clean.length) out[code] = clean;
  }
  return out;
}

/**
 * 宏观页状态：{ view, zoom: { start, end }（百分比）| null, legend: { 系列名: 是否显示 } | null }
 * 导播台缩放、点图例时更新，直播画面同步；切换图表时缩放和图例重置
 */
function cleanMacro(m, prev) {
  const view = findMacroView(m?.view) ? m.view : prev.view;
  const changedView = view !== prev.view;
  let zoom = changedView ? null : prev.zoom ?? null;
  if (m?.zoom === null) zoom = null;
  else if (m?.zoom && Number.isFinite(m.zoom.start) && Number.isFinite(m.zoom.end)) {
    const start = Math.max(0, Math.min(100, m.zoom.start));
    const end = Math.max(0, Math.min(100, m.zoom.end));
    // null 表示「图表默认窗口（最近一段）」，所以缩到全部历史（0~100）也要原样保存
    zoom = start < end ? { start: +start.toFixed(2), end: +end.toFixed(2) } : null;
  }
  let legend = changedView ? null : prev.legend ?? null;
  if (m?.legend === null) legend = null;
  else if (m?.legend && typeof m.legend === 'object') {
    const entries = Object.entries(m.legend).filter(([k, v]) => typeof v === 'boolean' && k.length <= 40).slice(0, 20);
    legend = entries.some(([, v]) => !v) ? Object.fromEntries(entries) : null; // 全部显示 = 默认
  }
  return { view, zoom, legend };
}

function cleanRank(r, fallback = DEFAULT_RANK) {
  return {
    list: RANK_LISTS[r?.list] ? r.list : fallback.list,
    sort: RANK_SORTS.includes(r?.sort) ? r.sort : fallback.sort,
    desc: typeof r?.desc === 'boolean' ? r.desc : fallback.desc,
    top: Number.isInteger(r?.top) && r.top >= 3 && r.top <= 30 ? r.top : fallback.top,
  };
}
const MAX_WATCH = 200;

/** 自选列表规整：去重、去掉标的池里已不存在的代码，并刷新名称 */
function cleanWatchlist(list) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const s = findSymbol(typeof x === 'string' ? x : x?.code);
    if (s && !seen.has(s.code)) { seen.add(s.code); out.push(publicSymbol(s)); }
  }
  return out.slice(0, MAX_WATCH);
}

function loadState() {
  try {
    const s = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    if (!PERIODS.includes(s.period)) s.period = DEFAULT_STATE.period;
    if (s.main !== null && !MAIN_INDICATORS.includes(s.main)) s.main = DEFAULT_STATE.main;
    if (s.sub !== null && !SUB_INDICATORS.includes(s.sub)) s.sub = DEFAULT_STATE.sub;
    s.view = cleanView(s.view) ?? DEFAULT_VIEW;
    // 旧版本的「个股自动隐藏」（settings.hideStocks）并入 hideSymbol，升级后不会突然露出个股名称
    if (s.settings?.hideStocks === true) s.hideSymbol = true;
    s.settings = cleanSettings(s.settings);
    s.hideSymbol = s.hideSymbol !== false;
    if (!Array.isArray(s.watchlist)) s.watchlist = []; // 标的池载入后再用 cleanWatchlist 校验
    s.rank = cleanRank(s.rank);
    s.scene = SCENES[s.scene] ? s.scene : 'kline';
    s.macro = findMacroView(s.macro?.view) ? cleanMacro(s.macro, DEFAULT_MACRO) : DEFAULT_MACRO;
    s.drawings = cleanDrawings(s.drawings);
    return s;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanView(v) {
  if (!v || !Number.isFinite(v.bars)) return null;
  return {
    bars: Math.min(MAX_BARS, Math.max(MIN_BARS, Math.round(v.bars))),
    end: Number.isFinite(v.end) ? v.end : null,
  };
}

let state = loadState();
let current = null;   // 最近一次推送的 data 消息，新连接直接补发
let lastError = null;
let loadSeq = 0;

// ---------------- 行情加载 ----------------
async function loadData({ force = false } = {}) {
  const seq = ++loadSeq;
  const symbol = findSymbol(state.symbol);
  const period = state.period;
  if (!symbol) {
    lastError = `未知标的 ${state.symbol}`;
    return broadcastStatus();
  }
  try {
    // quote = 页头的当日行情（最新价 + 昨收），不随周K/月K 变成周/月涨跌
    let bars, prevClose, quote;
    if (period === 'T') {
      ({ bars, prevClose } = await getIntraday(symbol, { force }));
      quote = { close: bars.at(-1).close, prevClose, date: bars.at(-1).timestamp };
    } else {
      const daily = await getDaily(symbol, { force });
      bars = aggregate(daily, period);
      const last = daily.at(-1);
      quote = { close: last.close, prevClose: daily.at(-2)?.close ?? last.open, date: last.timestamp };
    }
    if (seq !== loadSeq) return; // 期间导播又切了标的，丢弃旧结果

    const last = (list) => JSON.stringify(list.at(-1));
    const changed = !current || current.symbol.code !== symbol.code || current.period !== period
      || current.bars.length !== bars.length || last(current.bars) !== last(bars);

    current = {
      type: 'data',
      symbol: publicSymbol(symbol), // 带 type，直播画面据此判断是否为个股（自动隐藏）
      period,
      source: adapter.label,
      bars,
      quote,
      ...(prevClose != null && { prevClose }),
      updatedAt: Date.now(),
    };
    lastError = null;
    if (changed) broadcast(current);
  } catch (err) {
    if (seq !== loadSeq) return;
    lastError = `${symbol.code}: ${err.message}`;
    console.error('[data]', lastError);
  }
  broadcastStatus();
}

// ---------------- 板块排名（上屏） ----------------
let currentRank = null; // 最近一次推送的 rank 消息，新连接直接补发

async function loadRank() {
  if (!HAS_RANK || state.scene !== 'rank') return;
  const { list, sort, desc, top } = state.rank;
  try {
    const r = await adapter.getRanking(list);
    const rows = sortRows(r.rows, sort, desc).slice(0, top);
    const msg = { type: 'rank', list, listName: r.listName, date: r.date, sort, desc, top, rows };
    if (JSON.stringify(msg) !== JSON.stringify(currentRank)) {
      currentRank = msg;
      broadcast(msg);
    }
    if (lastError?.startsWith('排名')) lastError = null;
  } catch (err) {
    lastError = `排名：${err.message}`;
    console.error('[rank]', err.message);
  }
  broadcastStatus();
}

function applyPatch(patch = {}) {
  const next = { ...state };
  if (SCENES[patch.scene]) next.scene = patch.scene;
  if (patch.rank !== undefined) next.rank = cleanRank(patch.rank, state.rank);
  if (patch.macro !== undefined) next.macro = cleanMacro(patch.macro, state.macro);
  // 画线：新增 / 修改（同 id 覆盖）/ 删除 / 清空当前标的
  if (patch.drawPut || patch.drawRemove || patch.drawClear) {
    const code = patch.drawPut?.symbol ?? patch.drawRemove?.symbol ?? patch.drawClear;
    if (findSymbol(code)) {
      let list = [...(state.drawings[code] ?? [])];
      if (patch.drawPut) {
        const d = cleanDrawing(patch.drawPut.drawing);
        if (d) {
          const i = list.findIndex((x) => x.id === d.id);
          if (i >= 0) list[i] = d; else if (list.length < MAX_DRAWINGS) list.push(d);
        }
      }
      if (patch.drawRemove) list = list.filter((x) => x.id !== patch.drawRemove.id);
      if (patch.drawClear) list = [];
      const drawings = { ...state.drawings };
      if (list.length) drawings[code] = list; else delete drawings[code];
      next.drawings = drawings;
    }
  }
  if (patch.symbol !== undefined && findSymbol(patch.symbol)) next.symbol = patch.symbol;
  if (patch.period !== undefined && PERIODS.includes(patch.period)) next.period = patch.period;
  if (typeof patch.visible === 'boolean') next.visible = patch.visible;
  if (patch.view !== undefined) next.view = cleanView(patch.view) ?? state.view;
  if (patch.main === null || MAIN_INDICATORS.includes(patch.main)) next.main = patch.main;
  if (patch.sub === null || SUB_INDICATORS.includes(patch.sub)) next.sub = patch.sub;
  if (patch.settings === null) next.settings = DEFAULT_SETTINGS; // 恢复默认
  else if (patch.settings !== undefined) next.settings = cleanSettings(patch.settings, state.settings);
  if (typeof patch.hideSymbol === 'boolean') next.hideSymbol = patch.hideSymbol;
  // 自选：加入 / 移除单个代码，或整体替换（排序）
  if (patch.watchAdd !== undefined) next.watchlist = cleanWatchlist([...state.watchlist, patch.watchAdd]);
  if (patch.watchRemove !== undefined) next.watchlist = state.watchlist.filter((x) => x.code !== patch.watchRemove);
  if (patch.watchlist !== undefined) next.watchlist = cleanWatchlist(patch.watchlist);

  const needData = next.symbol !== state.symbol || next.period !== state.period;
  if (needData) next.view = { ...next.view, end: null }; // 换标的/周期后回到最新
  if (JSON.stringify(next) === JSON.stringify(state)) return;

  const needRank = next.scene === 'rank' && (state.scene !== 'rank' || JSON.stringify(next.rank) !== JSON.stringify(state.rank));
  state = next;
  saveState();
  broadcast({ type: 'state', state });
  if (needData) loadData();
  if (needRank) loadRank();
}

// ---------------- WebSocket ----------------
const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(raw);
}

function statusMsg() {
  const clients = { render: 0, control: 0, preview: 0 };
  for (const ws of wss.clients) clients[ws.role] = (clients[ws.role] || 0) + 1;
  return {
    type: 'status', error: lastError, clients, updatedAt: current?.updatedAt ?? null,
    source: adapterName, intraday: HAS_INTRADAY, rank: HAS_RANK, macro: HAS_MACRO,
  };
}

function broadcastStatus() {
  broadcast(statusMsg());
}

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://x').searchParams.get('role');
  ws.role = ['render', 'control', 'preview'].includes(role) ? role : 'render';
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.send(JSON.stringify({ type: 'state', state }));
  if (current) ws.send(JSON.stringify(current));
  if (currentRank) ws.send(JSON.stringify(currentRank));
  broadcastStatus();

  ws.on('message', (raw) => {
    if (ws.role !== 'control') return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'set') applyPatch(msg.patch);
    // 导播台鼠标悬停位置：高频、不落盘，只转发给直播画面 / 预览
    else if (msg.type === 'hover') {
      const index = Number.isInteger(msg.index) && msg.index >= 0 ? msg.index : null;
      broadcast({ type: 'hover', scope: String(msg.scope ?? ''), view: String(msg.view ?? ''), index });
    }
    else if (msg.type === 'refresh') { loadData({ force: true }); loadRank(); }
  });
  ws.on('close', broadcastStatus);
});

// 心跳：清理掉线但没触发 close 的连接（网线拔了之类）
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 15_000);

// ---------------- HTTP ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function sendJson(res, body) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function handleHttp(req, res) {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/search') {
    return sendJson(res, search(url.searchParams.get('q')));
  }
  // 宏观数据集：导播台和直播画面按当前图表各自拉取（数据只在盘后同步时变化）
  if (url.pathname === '/api/macro') {
    const ds = url.searchParams.get('ds');
    if (!HAS_MACRO) return sendJson(res, { error: '宏观数据需要本地数据源（DATA_SOURCE=local）' });
    if (!MACRO_DATASETS[ds]) return sendJson(res, { error: `未知数据集 ${ds}` });
    adapter.getMacro(ds)
      .then((rows) => sendJson(res, rows.length ? { ds, rows } : { ds, rows, error: `本地库没有「${ds}」数据，请先运行 npm run sync` }))
      .catch((err) => sendJson(res, { error: err.message }));
    return;
  }
  // 导播台浏览用的完整排名（不排序，前端自己排）；上屏的排名走 WebSocket
  if (url.pathname === '/api/rank') {
    if (!HAS_RANK) return sendJson(res, { error: '板块排名需要本地数据源（DATA_SOURCE=local）' });
    adapter.getRanking(url.searchParams.get('list') || DEFAULT_RANK.list)
      .then((r) => sendJson(res, r))
      .catch((err) => sendJson(res, { error: err.message }));
    return;
  }
  if (url.pathname === '/api/health') {
    return sendJson(res, { ok: !lastError, state, ...statusMsg() });
  }

  // 生产模式：托管 vite build 出来的页面，前端路由回退到 index.html
  if (!fs.existsSync(DIST)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('未找到 dist，开发时请访问 vite 端口（5173），或先 npm run build');
  }
  let file = path.join(DIST, path.normalize(url.pathname).replace(/^([/\\])+/, ''));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

await loadUniverse(adapter);
if (!findSymbol(state.symbol)) state.symbol = defaultSymbol();
state.watchlist = cleanWatchlist(state.watchlist);

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST}:${PORT}  数据源=${adapterName}`);
  loadData();
  loadRank();
});

setInterval(() => { if (state.period !== 'T') loadData({ force: true }); loadRank(); }, REFRESH_MS);
// 定期重新载入标的池：盘后同步新增的股票 / 同花顺概念不用重启服务就能检索到
setInterval(() => loadUniverse(adapter), +(process.env.UNIVERSE_REFRESH_MS || 30 * 60_000));
setInterval(() => { if (state.period === 'T') loadData({ force: true }); }, INTRADAY_REFRESH_MS);
