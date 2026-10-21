import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { SCHEMA } from '../server/db.js';
import { initIfind, writeIfind } from '../server/ifind-store.js';
import { cleanSettings, DEFAULT_SETTINGS } from '../shared/settings.js';

test('设置：副图高度默认值、越界回退到上一次的值', () => {
  assert.deepEqual(cleanSettings({}).subPane, { control: 140, render: 60 });
  const prev = cleanSettings({ ...DEFAULT_SETTINGS, subPane: { control: 200, render: 80 } });
  assert.deepEqual(prev.subPane, { control: 200, render: 80 });
  assert.deepEqual(cleanSettings({ subPane: { control: 1000, render: 20.5 } }, prev).subPane, { control: 200, render: 80 });
});

test('设置：安全区外边框，旧设置没有这一项时不画，不合法回退', () => {
  const old = cleanSettings({ safeArea: { side: 40, color: '#102040', opacity: 70 } });
  assert.deepEqual([old.safeArea.borderWidth, old.safeArea.borderColor], [0, '#c8161d']);
  const set = cleanSettings({ safeArea: { ...old.safeArea, borderWidth: 3, borderColor: '#FFCC4D' } }, old);
  assert.deepEqual([set.safeArea.borderWidth, set.safeArea.borderColor], [3, '#ffcc4d']);
  const bad = cleanSettings({ safeArea: { ...set.safeArea, borderWidth: 2.5, borderColor: 'red' } }, set);
  assert.deepEqual([bad.safeArea.borderWidth, bad.safeArea.borderColor], [3, '#ffcc4d']);
});

const at = (s) => Date.parse(`${s}+08:00`);
/** 一天的 1 分钟线（只放几根，够看出是哪天） */
const minutes = (day, base) => ['09:31', '09:32', '15:00'].map((hm, i) => ({
  ts: at(`${day}T${hm}:00`), open: base + i, high: base + i + 1, low: base + i - 1, close: base + i, vol: 1000, amount: 1e6,
}));

test('导播：双击日K 看某天分时、退回日K 带回视图；方框、副图画线保存', { timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kline-director-test-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const dbPath = path.join(dir, 'market.db');
  const db = new DatabaseSync(dbPath); db.exec(SCHEMA); initIfind(db);
  db.exec("INSERT INTO symbols VALUES ('000001.SH','上证指数','index',NULL)");
  writeIfind(db, 'daily', '000001.SH', [20261016, 20261019, 20261020].map((date, i) =>
    ({ date, open: 3000 + i, high: 3010 + i, low: 2990 + i, close: 3000 + i * 10, vol: 100, amount: 100 })));
  writeIfind(db, 'minute', '000001.SH', [...minutes('2026-10-19', 3100), ...minutes('2026-10-20', 3200)]);
  db.close();

  let child;
  t.after(async () => {
    if (child?.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TZ: 'Asia/Shanghai', DATA_SOURCE: 'ifind', DB_PATH: dbPath,
      IFIND_DB_PATH: path.join(dir, 'ifind.db'), DATA_SOURCE_FILE: path.join(dir, 'source.json'), STATE_FILE: path.join(dir, 'state.json'),
      AUTH_SECRET: '', ALLOWED_ORIGINS: '', TUSHARE_TOKEN: '', IFIND_REFRESH_TOKEN: '', IFIND_ACCESS_TOKEN: '', SYNC_EVERY: '0', SYNC_AT: '', IFIND_BACKFILL: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务启动超时 ${output}`)), 5000);
    child.stdout.on('data', (c) => { output += c; if (output.includes('[server]')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (c) => { output += c; });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`服务提前退出 ${code} ${output}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const get = async (url) => (await fetch(base + url)).json();

  // 历史某天：只返回那一天，昨收是前一天的日线收盘；不传日期 = 最近一天
  const day = await get('/api/kline?symbol=000001.SH&period=T&date=2026-10-19');
  assert.equal(day.date, '2026-10-19');
  assert.deepEqual(day.bars.map((b) => b.close), [3100, 3101, 3102]);
  assert.equal(day.prevClose, 3000);
  const latest = await get('/api/kline?symbol=000001.SH&period=T');
  assert.equal(latest.date, undefined);
  assert.equal(latest.bars[0].close, 3200);
  assert.match((await get('/api/kline?symbol=000001.SH&period=T&date=2026-10-16')).error, /没有分时数据/);
  assert.match((await get('/api/kline?symbol=000001.SH&period=D&date=2026-10-19')).error, /日期参数无效/);
  assert.match((await get('/api/kline?symbol=000001.SH&period=T&date=19-10-2026')).error, /日期参数无效/);

  // 导播台改状态：直播画面收到那天的分时；退回日K 时带上原来的视图，日期清掉
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=control`);
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
  await once(ws, 'open');
  const waitFor = async (pred) => {
    for (let i = 0; i < 100; i++) {
      const hit = inbox.findLast(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('等待消息超时');
  };
  const set = (patch) => { inbox.length = 0; ws.send(JSON.stringify({ type: 'set', patch })); };
  t.after(() => ws.close());

  set({ symbol: '000001.SH', period: 'T', intradayDate: '2026-10-19' });
  assert.equal((await waitFor((m) => m.type === 'state')).state.intradayDate, '2026-10-19');
  assert.equal((await waitFor((m) => m.type === 'data' && m.period === 'T')).date, '2026-10-19');
  const view = { bars: 80, end: at('2026-10-16T00:00:00') };
  set({ period: 'D', view });
  const back = (await waitFor((m) => m.type === 'state')).state;
  assert.deepEqual([back.period, back.intradayDate, back.view], ['D', null, view]);
  // 直接切分时（回车）：最近一天，不带日期
  set({ period: 'T' });
  assert.equal((await waitFor((m) => m.type === 'state')).state.intradayDate, null);

  // 方框；副图上的线记下副图指标，指标不认识就当主图的线
  set({ drawPut: { symbol: '000001.SH', drawing: { id: 'r1', name: 'rect', points: [{ t: 1, v: 1 }, { t: 2, v: 2 }] } } });
  set({ drawPut: { symbol: '000001.SH', drawing: { id: 's1', name: 'segment', pane: 'sub', sub: 'MACD', points: [{ t: 1, v: 0.5 }, { t: 2, v: -0.5 }] } } });
  set({ drawPut: { symbol: '000001.SH', drawing: { id: 's2', name: 'segment', pane: 'sub', sub: 'XYZ', points: [{ t: 1, v: 1 }, { t: 2, v: 2 }] } } });
  const drawn = (await waitFor((m) => m.type === 'state' && m.state.drawings['000001.SH']?.length === 3)).state.drawings['000001.SH'];
  assert.equal(drawn[0].name, 'rect');
  assert.deepEqual([drawn[1].pane, drawn[1].sub], ['sub', 'MACD']);
  assert.equal(drawn[2].pane, undefined);
});
