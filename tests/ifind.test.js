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
test('iFinD 模式个股隐藏分钟，其余境内标的显示分时与分钟 K',()=>{
  const caps={intraday:true,minutes:false,indexOnly:true};
  assert.deepEqual(periodsFor(caps,stock).map(p=>p.key),['D','W','M','Y']);
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
