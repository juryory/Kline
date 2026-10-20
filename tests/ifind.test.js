import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../server/db.js';
import { initIfind, mergedDaily, mergedMinutes, writeIfind } from '../server/ifind-store.js';
import { dailyBars, aggregateMinutes } from '../server/adapters/ifind.js';
import { createIfindClient, normalizeIfind, parseIfind } from '../server/ifind-client.js';
import { syncIfind, reserveBudget, remoteSymbol } from '../server/ifind-sync.js';
import { periodsFor } from '../shared/periods.js';
import { computeRanking, clearRankingCache } from '../server/rank.js';
import { reserveWeekly, quotaStatus, weekKey } from '../server/ifind-budget.js';
import { openIfindDb } from '../server/ifind-db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const index = { code: '000001.SH', name: '指数', type: 'index', category: null };
const stock = { code: '600000.SH', name: '股票', type: 'stock', category: null };
const etf = { code: '510300.SH', name: 'ETF', type: 'etf', category: 'ETF' };
const board = { code: '885001.TI', name: '概念', type: 'index', category: 'THN' };
const now = Date.parse('2026-10-16T18:15:00+08:00');
const raw = (code, time = '2026-10-16') => ({ code, time, open: 10, high: 12, low: 9, close: 11, volume: 1000, amount: 11000 });
function database(t) {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA); initIfind(db);
  t.after(() => db.close()); return db;
}
test('按日期补齐原始历史，同日 iFinD 优先，Tushare 行和复权因子保持不变', (t) => {
  const db = database(t);
  db.exec("INSERT INTO daily VALUES ('510300.SH',20261014,4,5,3,4.294,100,50),('510300.SH',20261015,5,6,4,5.294,200,60); INSERT INTO adj VALUES ('510300.SH',20261014,2),('510300.SH',20261015,4);");
  writeIfind(db, 'daily', etf.code, [{ date: 20261015, open: 5, high: 6, low: 4, close: 5.295, vol: 210, amount: 61 }]);
  const bars = dailyBars(db, etf);
  assert.deepEqual(bars.map(b => b.close), [4.294, 5.295]);
  assert.deepEqual(bars.map(b => b.dataSource), ['tushare','ifind']);
  assert.equal(bars[1].turnover, 61000);
  assert.equal(db.prepare('SELECT close FROM daily WHERE date=20261015').get().close, 5.294);
  assert.equal(db.prepare('SELECT SUM(factor) AS n FROM adj').get().n, 6);
  assert.equal(mergedDaily(db, 'missing').length, 0);
});
test('分钟按时间戳补缺，原 Tushare 分钟不改写', (t) => {
  const db = database(t);
  db.exec("INSERT INTO minute VALUES ('000001.SH',1,1000,10,11,9,10,100,1000),('000001.SH',1,2000,10,11,9,10,100,1000)");
  writeIfind(db, 'minute', index.code, [{ ts: 2000, open: 11, high: 12, low: 10, close: 12, vol: 200, amount: 2400 }]);
  assert.deepEqual(mergedMinutes(db, index.code).map(r=>[r.ts,r.close,r.source]), [[1000,10,'tushare'],[2000,12,'ifind']]);
  assert.equal(db.prepare('SELECT close FROM minute WHERE ts=2000').get().close, 10);
});
test('iFinD 解析、空值、北京时间及单位转换', () => {
  assert.equal(normalizeIfind({...raw(stock.code), close:null}, 'daily'), null);
  assert.equal(normalizeIfind({...raw(stock.code), volume:''}, 'daily'), null);
  const daily = normalizeIfind(raw(stock.code), 'daily');
  assert.equal(daily.ts, Date.parse('2026-10-16T00:00:00+08:00'));
  assert.equal(daily.vol, 10); assert.equal(daily.amount, 11);
  assert.equal(normalizeIfind({...raw(board.code), amount:null},'daily',{allowMissingAmount:true}).amount,null);
  const minute = normalizeIfind(raw(index.code,'2026-10-16 10:30:00'), 'minute', {volumeUnit:'lot',amountUnit:'thousand'});
  assert.equal(minute.vol, 100000); assert.equal(minute.amount, 11000000);
  assert.throws(() => parseIfind({tables:{}}), /tables/);
  assert.deepEqual(parseIfind({tables:[{thscode:'x',time:['2026-10-16'],table:{close:[10]}}]}), [{code:'x',time:'2026-10-16',close:10}]);
  assert.equal(remoteSymbol(board,{}).code,'885001.TI');
  assert.equal(remoteSymbol(board,{[board.code]:{code:'CUSTOM.INDEX'}}).code,'CUSTOM.INDEX');
});
test('官方 HTTP 路径、认证仅在请求头，未复权参数及脱敏报错', async () => {
  const calls=[];
  const client=createIfindClient({refreshToken:'private-test-secret', intervalMs:0,fetchImpl:async(url,opt)=>{
    calls.push({url,opt});
    return new Response(JSON.stringify(url.endsWith('get_access_token') ? {errorcode:0,data:{access_token:'test-access'}} : {errorcode:0,tables:[],dataVol:0}));
  }});
  await client.query('daily',[stock.code],'2026-10-16');
  await client.query('minute',[index.code],'2026-10-16');
  assert.equal(calls.length,3);
  assert.ok(calls[1].url.endsWith('/cmd_history_quotation'));
  assert.equal(JSON.parse(calls[1].opt.body).functionpara.CPS,'1');
  assert.equal(JSON.parse(calls[2].opt.body).functionpara.CPS,'no');
  assert.equal(calls[0].opt.headers.refresh_token,'private-test-secret');
  const bad=createIfindClient({accessToken:'test-access',intervalMs:0,fetchImpl:async()=>new Response(JSON.stringify({errorcode:-1,errmsg:'private-test-secret'}))});
  await assert.rejects(bad.query('daily',['x'],'2026-10-16'), e=>!e.message.includes('private-test-secret'));
});
test('指数/板块/ETF 分时及日线、个股仅日线，完成项跳过，缺口继续补', async(t) => {
  const db=database(t), calls=[];
  const options={db,now,startDate:'2026-10-16',endDate:'2026-10-16',symbols:[index,stock,etf,board],log:()=>{},
    client:{query:async(kind,codes,day)=>{
      calls.push({kind,codes});
      return {cells:codes.length*6,rows:codes.filter(c=>c!==etf.code).map(c=>raw(c,kind==='minute'?day+' 15:00:00':day))};
    }}};
  const first=await syncIfind(options);
  assert.equal(first.pending,4);
  assert.deepEqual(calls[1],{kind:'minute',codes:[index.code,etf.code,board.code]});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily').get().n,0);
  assert.equal(db.prepare('SELECT complete FROM ifind_progress WHERE kind=? AND code=?').get('minute',index.code).complete,0);
  calls.length=0;
  await syncIfind({...options,now:now+15*60_000});
  assert.deepEqual(calls,[{kind:'daily',codes:[etf.code]},{kind:'minute',codes:[index.code,etf.code,board.code]}]);
});
test('额度上限阻止访问，失败请求预留预算，跨月独立计数', async(t)=>{
  const db=database(t); let requests=0;
  reserveBudget(db,'2026-10','daily',6,6);
  assert.throws(()=>reserveBudget(db,'2026-10','daily',1,6),/预算/);
  reserveBudget(db,'2026-11','daily',6,6);
  const result=await syncIfind({db,now,startDate:'2026-10-16',endDate:'2026-10-16',symbols:[stock],log:()=>{},quota:{profile:'free',total:150000000,history:100000000,reserve:20000000},budgets:{daily:6,minute:1500000},client:{query:async()=>{requests++;throw Error('should not run');}}});
  assert.equal(requests,0); assert.ok(result.errors.length);
});
test('指数完整全天断点跳过，独立补分时不会重复补日线，最新日期优先', async(t)=>{
  const db=database(t), calls=[];
  const options={db,now,dailyStartDate:'2026-10-16',minuteStartDate:'2026-10-15',endDate:'2026-10-16',symbols:[index],log:()=>{},
    client:{query:async(kind,codes,day)=>{
      calls.push([kind,day]);
      if(kind==='daily') return {cells:6,rows:[raw(index.code,day)]};
      const times=[];
      for(const start of ['09:31','13:01']) for(let i=0;i<120;i++) {
        const ts=Date.parse(`${day}T${start}:00Z`)+i*60_000;
        times.push(new Date(ts).toISOString().slice(0,19).replace('T',' '));
      }
      return {cells:1440,rows:times.map(time=>raw(index.code,time))};
    }}};
  const first=await syncIfind(options);
  assert.equal(first.pending,0);
  assert.deepEqual(calls,[['daily','2026-10-16'],['minute','2026-10-16'],['minute','2026-10-15']]);
  calls.length=0;
  await syncIfind({...options,now:now+15*60_000});assert.equal(calls.length,0);
});
test('盘中不会将当天数据标记完成，dry-run 不调用接口', async(t)=>{
  const db=database(t); let calls=0;
  const options={db,now,startDate:'2026-10-16',endDate:'2026-10-16',symbols:[stock],log:()=>{},client:{query:async()=>{calls++;}}};
  await assert.rejects(syncIfind({...options,now:Date.parse('2026-10-16T10:00:00+08:00')}),/已收盘/);
  await syncIfind({...options,dryRun:true}); assert.equal(calls,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ifind_progress').get().n,0);
});
test('iFinD 模式个股有分时、没有分钟 K，其余境内标的显示分时与分钟 K',()=>{
  const caps={intraday:true,minutes:false,indexOnly:true};
  assert.deepEqual(periodsFor(caps,stock).map(p=>p.key),['T','D','W','M','Y']);
  assert.ok(!periodsFor({...caps,minutes:true},stock).some(p=>p.key==='m5'));
  for(const symbol of [index,etf,board]) {
    assert.equal(periodsFor(caps,symbol)[0].key,'T');
    assert.ok(periodsFor({...caps,minutes:true},symbol).some(p=>p.key==='m5'));
  }
});

test('独立数据库只读挂载旧库，旧库变化能读到，写旧库被 SQLite 阻止', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'kline-ifind-db-'));
  const fallback = path.join(dir,'old.db'), file = path.join(dir,'new.db');
  const old = new DatabaseSync(fallback); old.exec(SCHEMA);
  old.exec("INSERT INTO daily VALUES ('510300.SH',20261015,4,5,3,4.294,100,50)");
  const db = openIfindDb({file,fallback});
  t.after(()=>{
    db.close();old.close();
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('kline-ifind-db-'));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  assert.equal(mergedDaily(db,etf.code)[0].close,4.294);
  assert.throws(()=>db.exec("UPDATE legacy.daily SET close=99"),/readonly/i);
  writeIfind(db,'daily',etf.code,[{date:20261016,open:4,high:5,low:3,close:4.295,vol:100,amount:50}]);
  assert.equal(mergedDaily(db,etf.code).length,2);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM daily').get().n,1);
  old.exec("INSERT INTO daily VALUES ('510300.SH',20261014,4,5,3,4.293,100,50)");
  assert.equal(mergedDaily(db,etf.code).length,3);
  assert.throws(()=>openIfindDb({file:fallback,fallback}),/必须/);
});

test('周共享额度跨函数计费，历史预算和保留额度生效，周一北京时间重置', t => {
  const db=database(t), config={profile:'trial',total:150,history:100,reserve:20};
  reserveWeekly(db,now,'history','daily',60,config);
  reserveWeekly(db,now,'history','minute',40,config);
  assert.throws(()=>reserveWeekly(db,now,'history','minute',1,config),/共享预算/);
  reserveWeekly(db,now,'fresh','minute',30,config);
  assert.throws(()=>reserveWeekly(db,now,'fresh','daily',1,config),/共享预算/);
  assert.equal(quotaStatus(db,now,config).used,130);
  assert.equal(weekKey(Date.parse('2026-10-18T23:59:59+08:00')),'2026-10-12');
  const monday=Date.parse('2026-10-19T00:00:00+08:00');
  assert.equal(weekKey(monday),'2026-10-19');
  assert.equal(quotaStatus(db,monday,config).used,0);
});

test('盘中增量从上一根后继续，收盘前不标完成，网络失败保留周预算', async t => {
  const db=database(t), calls=[];
  const options={db,now:Date.parse('2026-10-16T10:32:00+08:00'),mode:'intraday',symbols:[etf],log:()=>{},
    client:{query:async(kind,codes,day,window)=>{
      calls.push({kind,window});
      return {cells:6,rows:[raw(etf.code,day+' '+window.to)]};
    }}};
  await syncIfind(options);
  await syncIfind({...options,now:options.now+60_000});
  assert.deepEqual(calls.map(c=>c.window),[{from:'09:30:00',to:'10:31:00'},{from:'10:32:00',to:'10:32:00'}]);
  assert.equal(db.prepare('SELECT complete FROM ifind_progress').get().complete,0);
  assert.equal(quotaStatus(db,now).used,12);
  await syncIfind({...options,now:options.now+120_000,client:{query:async()=>{throw Error('offline');}}});
  assert.equal(quotaStatus(db,now).used,18);
});

test('补历史复用旧日线，限制个股三年，达到单轮请求数保留待续状态', async t => {
  const db=database(t);
  db.exec("INSERT INTO daily VALUES ('600000.SH',20261015,10,12,9,11,10,11)");
  const calls=[];
  const result=await syncIfind({db,now,mode:'history',symbols:[stock],startDate:'2026-10-14',endDate:'2026-10-16',maxRequests:1,log:()=>{},
    client:{query:async(kind,codes,day)=>{calls.push(day);return {cells:6,rows:[raw(stock.code,day)]};}}});
  assert.deepEqual(calls,['2026-10-16']);
  assert.equal(result.reusedDaily,1);assert.equal(result.deferred,true);
  assert.equal(quotaStatus(db,now).historyUsed,6);
});

test('ETF 分钟聚合保留三位小数、成交量求和，不跨午休合并', () => {
  const rows=['11:29','11:30','13:01','13:02'].map((time,i)=>({
    ts:Date.parse(`2026-10-16T${time}:00+08:00`),open:4.291+i/1000,high:4.299,low:4.290,close:4.292+i/1000,vol:100,amount:429.2,source:'ifind'
  }));
  const bars=aggregateMinutes(rows,5);
  assert.equal(bars.length,2);
  assert.equal(bars[0].open,4.291);assert.equal(bars[0].close,4.293);
  assert.equal(bars[0].volume,2);
  assert.equal(bars[1].timestamp,Date.parse('2026-10-16T13:05:00+08:00'));
});

test('盘后复用盘中完整分钟；行数够但缺一根时仍请求补齐', async t => {
  const db=database(t), day='2026-10-16', rows=[];
  for (const session of ['09:31','13:01']) {
    const start=Date.parse(`${day}T${session}:00+08:00`);
    for(let i=0;i<120;i++) rows.push({ts:start+i*60_000,open:10,high:12,low:9,close:11,vol:100,amount:1000});
  }
  writeIfind(db,'minute',index.code,rows);
  const calls=[];
  const options={db,now,symbols:[index],startDate:day,endDate:day,log:()=>{},
    client:{query:async(kind)=>{calls.push(kind);return {cells:6,rows:kind==='daily'?[raw(index.code)]:[]};}}};
  await syncIfind(options);
  assert.deepEqual(calls,['daily']);
  db.prepare('DELETE FROM ifind_progress WHERE kind=?').run('minute');
  db.prepare('DELETE FROM ifind_minute WHERE ts=?').run(rows[0].ts);
  writeIfind(db,'minute',index.code,[{...rows[0],ts:rows[0].ts-60_000}]);
  calls.length=0;
  await syncIfind({...options,now:now+15*60_000});
  assert.deepEqual(calls,['minute']);
  assert.equal(db.prepare("SELECT complete FROM ifind_progress WHERE kind='minute'").get().complete,0);
});
test('板块排名同样读取 iFinD 优先历史，不使用另一源的缓存',t=>{
  const db=database(t); clearRankingCache();
  db.prepare('INSERT INTO symbols VALUES (?,?,?,?)').run(board.code,board.name,board.type,board.category);
  db.exec("INSERT INTO daily VALUES ('885001.TI',20261015,10,10,10,10,1,1),('885001.TI',20261016,10,10,10,10,1,1)");
  writeIfind(db,'daily',board.code,[{date:20261016,open:10,high:11,low:10,close:11,vol:1,amount:1}]);
  assert.equal(computeRanking(db,'THN').rows[0].pct,0);
  assert.ok(Math.abs(computeRanking(db,'THN','merged_daily').rows[0].pct-10)<1e-9);
});
test('宏观 EDB：周期换算、单位换算、增量回看，按期合并时 iFinD 字段覆盖 tushare', async t => {
  const { edbPeriod } = await import('../shared/macro.js');
  const { syncIfindMacro } = await import('../server/ifind-macro.js');
  const { mergeMacro } = await import('../server/adapters/ifind.js');
  assert.equal(edbPeriod('2026-09-30', 'quarter'), '2026Q3');
  assert.equal(edbPeriod('2026-09-30', 'month'), '202609');
  assert.equal(edbPeriod('2026-10-20', 'daily'), '20261020');
  const db = database(t), calls = [];
  const client = { async edb(ids, start, end) {
    calls.push({ ids, start, end });
    const series = Object.fromEntries(ids.map(id => [id, [{ time: '2026-09-30', value: id === 'S004273887' ? '2.5' : '50.1' }, { time: '2026-08-31', value: '' }]]));
    return { series, cells: ids.length };
  } };
  const first = await syncIfindMacro({ db, client, now, log: () => {}, years: 5 });
  assert.equal(first.failed, false);
  assert.equal(calls[0].start, '2021-10-16');
  const margin = JSON.parse(db.prepare("SELECT data FROM ifind_macro WHERE dataset='margin' AND period='20260930'").get().data);
  assert.equal(margin.rzye, 2.5e8);
  const pmi = db.prepare("SELECT period, data FROM ifind_macro WHERE dataset='pmi'").all();
  assert.deepEqual(pmi.map(r => r.period), ['202609']);
  calls.length = 0;
  assert.equal((await syncIfindMacro({ db, client, now, log: () => {} })).skipped, true); // 每天一次
  assert.equal(calls.length, 0);
  await syncIfindMacro({ db, client, now, log: () => {}, force: true });
  assert.equal(calls.find(c => c.ids.includes('M002043802')).start, '2025-07-28');
  const merged = mergeMacro(
    [{ period: '202608', data: '{"pmi010000":49.5,"pmi020100":50.3}' }, { period: '202609', data: '{"pmi010000":49.9,"pmi020100":50.6}' }],
    pmi);
  assert.deepEqual(merged.map(r => [r.period, r.pmi010000, r.pmi020100]), [['202608', 49.5, 50.3], ['202609', 50.1, 50.6]]);
});
test('EDB 客户端解析返回表，不把 token 放进请求体', async () => {
  const calls = [];
  const client = createIfindClient({ accessToken: 'test-access', intervalMs: 0, fetchImpl: async (url, opt) => {
    calls.push({ url, opt });
    return new Response(JSON.stringify({ errorcode: 0, dataVol: 2, tables: [{ id: ['M1'], time: ['2026-09-30'], value: ['1.5'], index_name: ['x'] }, { id: ['M2'] }] }));
  } });
  const { series, cells } = await client.edb(['M1', 'M2'], '2026-01-01', '2026-10-20');
  assert.ok(calls[0].url.endsWith('/edb_service'));
  assert.equal(calls[0].opt.headers.access_token, 'test-access');
  assert.ok(!calls[0].opt.body.includes('test-access'));
  assert.deepEqual(series, { M1: [{ time: '2026-09-30', value: '1.5' }] });
  assert.equal(cells, 2);
});
test('概念板块：只取常规概念、按名称查指数代码并缓存、成分股入库、每周一次、异常空树不清空', async t => {
  const { refreshConceptBoards } = await import('../server/ifind-boards.js');
  const db = database(t), lookups = [];
  const leaves = Array.from({ length: 120 }, (_, i) => ({ p03321_f001: `概念${i}`, p03321_f003: `001042_${300000 + i}`, p03321_f004: '001042' }));
  let tree = [{ p03321_f001: '常规概念', p03321_f003: '001042', p03321_f004: '001042_1' }, ...leaves,
    { p03321_f001: '新兴题材', p03321_f003: '001042002_1', p03321_f004: '001042002' }];
  const client = {
    async report(name, para) {
      if (name === 'p03321') return tree;
      return para.blockname === '001042_300000' ? [{ p03291_f002: '600000.SH' }, { p03291_f002: '000001.SZ' }] : [];
    },
    async thscode(secname, exact = true) {
      lookups.push(secname);
      const i = +secname.slice(2);
      if (i === 119) return { codes: ['3085.TWO'], multiple: false };
      // 同名多个品种：精确匹配不给候选，模糊匹配列出全部
      if (i === 1) return exact ? { codes: [], multiple: true } : { codes: ['885001.TI', '864024.TI'], multiple: false };
      // 模糊匹配仍不唯一时用 tushare 同名板块
      if (i === 2) return exact ? { codes: [], multiple: true } : { codes: ['885002.TI', '885998.TI'], multiple: false };
      return { codes: [`${885000 + i}.TI`], multiple: false };
    },
  };
  db.exec("INSERT INTO symbols VALUES ('885777.TI','概念2','index','THN')");
  const first = await refreshConceptBoards({ db, client, now, log: () => {} });
  assert.deepEqual([first.boards, first.withCode, first.members], [120, 119, 2]);
  assert.equal(db.prepare("SELECT code FROM ifind_boards WHERE name='概念119'").get().code, null);
  assert.equal(db.prepare("SELECT code FROM ifind_boards WHERE name='概念1'").get().code, '885001.TI');
  assert.equal(db.prepare("SELECT code FROM ifind_boards WHERE name='概念2'").get().code, '885777.TI');
  assert.equal(db.prepare("SELECT category FROM ifind_symbols WHERE code='885000.TI'").get().category, 'THN');
  assert.ok(!lookups.includes('新兴题材'));
  assert.equal((await refreshConceptBoards({ db, client, now, log: () => {} })).skipped, true);
  lookups.length = 0;
  await refreshConceptBoards({ db, client, now, log: () => {}, force: true });
  assert.deepEqual(lookups, ['概念119']); // 只重查上次没查到的（同一名称一次）
  tree = tree.slice(0, 5);
  await assert.rejects(refreshConceptBoards({ db, client, now, log: () => {}, force: true }), /疑似异常/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ifind_boards").get().n, 120);
});
test('日线同步记录个股涨停，重拉时覆盖旧状态，非个股不记', async t => {
  const db = database(t);
  let status = '涨停';
  const options = { db, now, startDate: '2026-10-16', endDate: '2026-10-16', symbols: [stock, index], log: () => {},
    client: { query: async (kind, codes, day) => ({ cells: codes.length * 7,
      rows: kind === 'daily' ? codes.map(c => ({ ...raw(c, day), ths_up_and_down_status_stock: c === stock.code ? status : '涨停' })) : [] }) } };
  await syncIfind(options);
  assert.deepEqual(db.prepare('SELECT date, code FROM ifind_limit_up').all().map(r => ({ ...r })), [{ date: 20261016, code: stock.code }]);
  db.exec('DELETE FROM ifind_progress'); status = '非涨跌停';
  await syncIfind(options);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ifind_limit_up').get().n, 0);
});
test('iFinD 概念排行：iFinD 日线优先、缺的日期用 tushare 补，涨停数来自 iFinD 成分股，主力净额隐藏', async t => {
  const { computeIfindRanking } = await import('../server/rank.js');
  const db = database(t); clearRankingCache();
  assert.throws(() => computeIfindRanking(db), /概念板块列表/);
  db.exec(`INSERT INTO ifind_boards VALUES ('THN','b1','概念A','885001.TI'),('THN','b2','概念B','885002.TI'),('THN','b3','无指数',NULL);
    INSERT INTO daily VALUES ('885001.TI',20251231,8,8,8,8,1,1),('885001.TI',20261012,10,10,10,10,1,1),('885001.TI',20261013,10,10,10,10,1,1),
      ('885001.TI',20261014,10,10,10,10,1,1),('885001.TI',20261015,10,10,10,10,1,1),('885002.TI',20261015,5,5,5,5,1,1);
    INSERT INTO ifind_members VALUES ('885001.TI','600000.SH'),('885001.TI','000001.SZ'),('885002.TI','000001.SZ');
    INSERT INTO ifind_limit_up VALUES (20261016,'600000.SH');`);
  writeIfind(db, 'daily', '885001.TI', [{ date: 20261015, open: 10, high: 10, low: 10, close: 10, vol: 1, amount: 1 },
    { date: 20261016, open: 11, high: 11, low: 11, close: 11, vol: 1, amount: 1 }]);
  const r = computeIfindRanking(db);
  assert.equal(r.date, 20261016);
  assert.deepEqual(r.hidden, ['mainNet']);
  assert.equal(r.rows.length, 1); // 概念B 当天无行情，无指数代码的不参与
  const a = r.rows[0];
  assert.ok(Math.abs(a.pct - 10) < 1e-9);
  assert.ok(Math.abs(a.ytd - 37.5) < 1e-9);
  assert.equal(a.pct5, null);
  assert.equal(a.limitUp, 1);
  assert.equal(a.mainNet, null);
});
test('实时排行行情：开盘前/周末不请求，交易中按 1 分钟缓存，午休收盘沿用，节假日不当作今天，失败沿用并退避，计入周额度', async t => {
  const { liveQuotes, resetLive } = await import('../server/ifind-live.js');
  const db = database(t); resetLive(); t.after(resetLive);
  const at = (hm, day = '2026-10-16') => Date.parse(`${day}T${hm}:00+08:00`);
  let calls = 0, tradeDate = '2026-10-16', fail = false;
  const client = { async realtime(codes) {
    calls++;
    if (fail) throw new Error('网络失败');
    return { cells: codes.length * 5, rows: codes.map(code => ({ code, tradeDate, tradeTime: '10:00:03', latest: 11, changeRatio: 10, upLimitCount: 3 })) };
  } };
  const opts = (now) => ({ db, client, codes: ['885001.TI', '885002.TI'], now, quota: { profile: 'trial', total: 1000, history: 100, reserve: 10 } });
  assert.equal(await liveQuotes(opts(at('09:00'))), null);
  assert.equal(await liveQuotes(opts(at('10:00', '2026-10-17'))), null); // 周六
  assert.equal(calls, 0);
  const first = await liveQuotes(opts(at('10:00')));
  assert.equal(first.date, 20261016);
  assert.equal(first.quotes.get('885001.TI').upLimitCount, 3);
  await liveQuotes(opts(at('10:00') + 30_000));
  assert.equal(calls, 1);
  await liveQuotes(opts(at('10:01') + 1000));
  assert.equal(calls, 2);
  await liveQuotes(opts(at('12:00'))); await liveQuotes(opts(at('16:00')));
  assert.equal(calls, 2); // 午休、收盘后沿用
  assert.equal(db.prepare("SELECT cells FROM ifind_weekly_usage WHERE kind='realtime'").get().cells, 20);
  fail = true;
  assert.equal((await liveQuotes(opts(at('14:00')))).date, 20261016); // 失败沿用当天结果
  await liveQuotes(opts(at('14:00') + 10_000));
  assert.equal(calls, 3); // 退避期内不再请求
  resetLive(); fail = false; tradeDate = '2026-09-30';
  assert.equal(await liveQuotes(opts(at('10:00', '2026-10-05'))), null); // 节假日返回上个交易日
  await liveQuotes(opts(at('10:05', '2026-10-05')));
  assert.equal(calls, 4);
});
test('iFinD 概念排行接入实时行情：最新价接在历史后面，涨幅和涨停家数用实时值；库里已有当天日线时用库里', async t => {
  const { computeIfindRanking } = await import('../server/rank.js');
  const db = database(t); clearRankingCache();
  db.exec(`INSERT INTO ifind_boards VALUES ('THN','b1','概念A','885001.TI'),('THN','b2','概念B','885002.TI');
    INSERT INTO daily VALUES ('885001.TI',20251231,8,8,8,8,1,1),('885001.TI',20261009,9,9,9,9,1,1),('885001.TI',20261012,10,10,10,10,1,1),
      ('885001.TI',20261013,10,10,10,10,1,1),('885001.TI',20261014,10,10,10,10,1,1),('885001.TI',20261015,10,10,10,10,1,1),
      ('885002.TI',20261015,5,5,5,5,1,1);`);
  const live = { date: 20261016, time: '10:00:03', quotes: new Map([
    ['885001.TI', { latest: 11, changeRatio: 10, upLimitCount: 3 }], ['885002.TI', { latest: null, changeRatio: null, upLimitCount: null }]]) };
  const r = computeIfindRanking(db, live);
  assert.equal(r.date, 20261016);
  assert.equal(r.liveAt, '10:00:03');
  assert.equal(r.rows.length, 1); // 无实时价的不参与
  const a = r.rows[0];
  assert.equal(a.pct, 10);
  assert.ok(Math.abs(a.pct5 - (11 / 9 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(a.ytd - 37.5) < 1e-9);
  assert.equal(a.limitUp, 3);
  writeIfind(db, 'daily', '885001.TI', [{ date: 20261016, open: 11, high: 11, low: 11, close: 11.5, vol: 1, amount: 1 }]);
  clearRankingCache();
  const after = computeIfindRanking(db, live);
  assert.equal(after.liveAt, undefined);
  assert.equal(after.rows[0].close, 11.5);
});
test('按需分时：只取已走完的分钟并与上一根重叠，20 秒内不重复请求，午休不请求，收盘后取到 15:00，节假日取上个交易日，写库供盘后复用', async t => {
  const { refreshMinutes, resetLive } = await import('../server/ifind-live.js');
  const db = database(t); resetLive(); t.after(resetLive);
  const at = (hms, day = '2026-10-16') => Date.parse(`${day}T${hms}+08:00`);
  const windows = [];
  const client = {
    async tradeDates() { return ['2026-09-30', '2026-10-15', '2026-10-16']; },
    async query(kind, codes, day, w) {
      windows.push(`${day} ${w.from}-${w.to}`);
      const rows = [];
      for (let ts = Date.parse(`${day}T${w.from}+08:00`); ts <= Date.parse(`${day}T${w.to}+08:00`); ts += 60_000) {
        rows.push(raw(codes[0], new Date(ts + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')));
      }
      return { cells: rows.length * 6, rows };
    },
  };
  const quota = { profile: 'trial', total: 10_000_000, history: 100, reserve: 10 };
  const run = (now) => refreshMinutes({ db, client, symbol: stock, now, quota });
  assert.equal(await run(at('09:20:00')), true); // 开盘前：取上个交易日
  assert.deepEqual(windows, ['2026-10-15 09:30:00-15:00:00']);
  resetLive(); windows.length = 0;
  await run(at('10:05:30'));
  assert.deepEqual(windows, ['2026-10-16 09:30:00-10:04:00']);
  await run(at('10:05:40'));
  assert.equal(windows.length, 1); // 20 秒内不重复请求
  await run(at('10:10:30'));
  assert.equal(windows[1], '2026-10-16 10:04:00-10:09:00'); // 与上一根重叠
  await run(at('11:31:30'));
  await run(at('12:00:00'));
  assert.equal(windows.length, 3); // 午休不请求
  await run(at('16:00:00'));
  assert.equal(windows[3], '2026-10-16 11:30:00-15:00:00');
  await run(at('16:30:00'));
  assert.equal(windows.length, 4); // 当天已取全
  const saved = db.prepare('SELECT COUNT(*) AS n FROM ifind_minute WHERE code = ? AND ts BETWEEN ? AND ?').get(stock.code, at('09:30:00'), at('15:00:00')).n;
  assert.equal(saved, 242); // 09:30—11:30 共 121 根 + 13:00—15:00 共 121 根，午休时段不入库
  assert.equal(db.prepare("SELECT cells FROM ifind_weekly_usage WHERE kind = 'live_minute'").get().cells > 0, true);
  resetLive(); windows.length = 0;
  await run(at('10:00:00', '2026-10-05')); // 节假日
  assert.deepEqual(windows, ['2026-09-30 09:30:00-15:00:00']);
});
test('今天的实时日K：拼在库里日线后面，库里已有当天日线时不拼，节假日不拼', async t => {
  const { liveDailyBar, resetLive } = await import('../server/ifind-live.js');
  const { withLiveBar } = await import('../server/adapters/ifind.js');
  resetLive(); t.after(resetLive);
  const db = database(t);
  let tradeDate = '2026-10-16';
  const client = {
    async tradeDates() { return ['2026-10-15', '2026-10-16']; },
    async realtime(codes) { return { cells: 7, rows: [{ code: codes[0], tradeDate, open: 10, high: 12, low: 9, latest: 11, volume: 34135, amount: 4525399000 }] }; },
  };
  const now = Date.parse('2026-10-16T10:00:00+08:00');
  const bar = await liveDailyBar({ db, client, symbol: stock, now, quota: { profile: 'free' } });
  assert.deepEqual([bar.date, bar.close, bar.volume, bar.turnover], [20261016, 11, 34135, 4525399000]);
  const stored = [{ timestamp: Date.parse('2026-10-15T00:00:00+08:00'), close: 10 }];
  assert.deepEqual(withLiveBar(stored, bar).map(b => b.dataSource), [undefined, 'ifind-live']);
  assert.equal(withLiveBar([...stored, { timestamp: bar.timestamp, close: 11.2 }], bar).at(-1).close, 11.2);
  resetLive(); tradeDate = '2026-10-15';
  assert.equal(await liveDailyBar({ db, client, symbol: stock, now, quota: { profile: 'free' } }), null);
});
test('盘后同步 15:30 后才同步当天日线', async t => {
  const db = database(t), days = [];
  const client = { query: async (kind, codes, day) => { days.push(day); return { cells: 7, rows: [raw(codes[0], day)] }; } };
  const opts = { db, client, symbols: [stock], log: () => {}, startDate: '2026-10-16' };
  await assert.rejects(syncIfind({ ...opts, endDate: '2026-10-16', now: Date.parse('2026-10-16T15:20:00+08:00') }), /15:30 前截止/);
  const r = await syncIfind({ ...opts, now: Date.parse('2026-10-16T15:40:00+08:00') });
  assert.equal(r.end, '2026-10-16');
  assert.deepEqual(days, ['2026-10-16']);
});
