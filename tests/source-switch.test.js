import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../server/db.js';
import { initIfind, writeIfind } from '../server/ifind-store.js';

test('HTTP 数据源切换：权限、缓存、日线回退、重启持久化与无凭证同步禁用', {timeout:20000}, async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kline-source-test-'));
  const probe=net.createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening');
  const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
  const dbPath=path.join(dir,'market.db');
  const db=new DatabaseSync(dbPath); db.exec(SCHEMA); initIfind(db);
  db.exec("INSERT INTO symbols VALUES ('000001.SH','指数','index',NULL),('510300.SH','测试ETF','etf','ETF'); INSERT INTO daily VALUES ('000001.SH',20261015,10,11,9,10,100,100),('510300.SH',20261014,4,5,3,4.294,100,50),('510300.SH',20261015,5,6,4,5.294,200,60); INSERT INTO adj VALUES ('510300.SH',20261014,2),('510300.SH',20261015,4);");
  writeIfind(db,'daily','510300.SH',[{date:20261015,open:5,high:6,low:4,close:5.295,vol:210,amount:61}]); db.close();
  const secret='test-secret-only';
  const token=role=>{
    const payload=[{alg:'HS256',typ:'JWT'},{sub:'test',role,exp:Math.floor(Date.now()/1000)+60}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
    return payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
  };
  let child;
  const stop=async()=>{if(child && child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}};
  t.after(async()=>{
    await stop();
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('kline-source-test-'));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const start=async()=>{
    child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',TZ:'Asia/Shanghai',
      DATA_SOURCE:'local',DB_PATH:dbPath,IFIND_DB_PATH:path.join(dir,'ifind.db'),IFIND_INTRADAY_ENABLED:'0',
      DATA_SOURCE_FILE:path.join(dir,'source.json'),STATE_FILE:path.join(dir,'state.json'),
      AUTH_SECRET:secret,ALLOWED_ORIGINS:'',TUSHARE_TOKEN:'',IFIND_REFRESH_TOKEN:'',IFIND_ACCESS_TOKEN:'',MINUTE_MONTHS:'0',SYNC_EVERY:'0',SYNC_AT:''},stdio:['ignore','pipe','pipe']});
    let output='';
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('服务启动超时 '+output)),5000);
      child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('[server]')){clearTimeout(timeout);resolve();}});
      child.stderr.on('data',chunk=>{output+=chunk;});
      child.once('exit',code=>{clearTimeout(timeout);reject(new Error('服务提前退出 '+code+' '+output));});
    });
  };
  const base=`http://127.0.0.1:${port}`;
  const request=(url,body,role='admin')=>fetch(base+url,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token(role),origin:base,'content-type':'application/json'},...(body&&{body:JSON.stringify(body)})});
  await start();
  const original=await (await request('/api/kline?symbol=510300.SH&period=D')).json();
  assert.equal(original.bars[0].close,2.147);
  assert.equal((await request('/api/data-source',{source:'ifind'},'control')).status,403);
  assert.equal((await request('/api/data-source',{source:'invalid'})).status,400);
  assert.equal((await request('/api/data-source',{source:'ifind'})).status,200);
  const changed=await (await request('/api/kline?symbol=510300.SH&period=D')).json();
  assert.deepEqual(changed.bars.map(b=>b.close),[4.294,5.295]);
  assert.deepEqual(changed.provenance,['tushare','ifind']);
  assert.ok(changed.source.includes('不复权'));
  const sync=await (await request('/api/sync')).json();
  assert.equal(sync.source,'ifind');assert.ok(sync.schedule.includes('没有配置'));
  assert.equal((await (await request('/api/data-source')).json()).ifindConfigured,false);
  await stop(); await start();
  assert.equal((await (await request('/api/data-source')).json()).source,'ifind');
  await request('/api/data-source',{source:'local'});
  const restored=await (await request('/api/kline?symbol=510300.SH&period=D')).json();
  assert.deepEqual(restored.bars.map(b=>b.close),[2.147,5.294]);
});
