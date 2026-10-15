import test from 'node:test';
import assert from 'node:assert/strict';
import { isEtf, validDaily, etfPages, syncEtf } from '../server/etf-sync.js';
import { periodsFor } from '../shared/periods.js';
import { quoteOf } from '../web/src/view.js';

process.env.TUSHARE_TOKEN='test-token';
// 显式使用内存数据库，不触及真实行情库，也不请求远程接口。
const { DatabaseSync } = await import('node:sqlite');
const db=new DatabaseSync(':memory:');
db.exec('CREATE TABLE symbols(code TEXT PRIMARY KEY,name,type,category);CREATE TABLE daily(code,date,open,high,low,close,vol,amount,PRIMARY KEY(code,date));CREATE TABLE adj(code,date,factor,PRIMARY KEY(code,date));CREATE TABLE synced(kind,date,PRIMARY KEY(kind,date));');
const symbol={code:'510300.SH',name:'测试ETF',type:'etf',category:'ETF'};
test('ETF 识别、数据校验、三位报价及分钟权限隔离',()=>{
  assert.equal(isEtf({ts_code:symbol.code,name:symbol.name}),true);
  assert.equal(isEtf({ts_code:symbol.code,name:'沪深300ETF联接'}),false);
  assert.equal(validDaily({trade_date:'20261014',open:4.3,high:4.4,low:4.2,close:4.294,vol:0,amount:0}),true);
  assert.equal(validDaily({trade_date:'20261014',open:null,high:4.4,low:4.2,close:4.294}),false);
  assert.equal(quoteOf({symbol,quote:{close:4.294,prevClose:4.345}}).close,'4.294');
  assert.deepEqual(periodsFor({intraday:true,minutes:true},symbol).map(p=>p.key),['D','W','M','Y']);
});
test('分批写入与断点续传，不写入普通基金，不丢失ETF价格精度',async()=>{
  const old=globalThis.fetch, calls=[];
  const response=rows=>new Response(JSON.stringify({code:0,data:{fields:rows.length?Object.keys(rows[0]):[],items:rows.map(Object.values),has_more:false}}));
  globalThis.fetch=async(_url,opt)=>{
    const {api_name:api,params}=JSON.parse(opt.body);calls.push(api+':'+params.trade_date);
    if(api==='fund_basic')return response([{ts_code:symbol.code,name:symbol.name},{ts_code:'161725.SZ',name:'普通基金'}]);
    if(api==='trade_cal')return response([{cal_date:'20261012'},{cal_date:'20261013'},{cal_date:'20261014'}]);
    if(api==='fund_daily')return response([symbol.code,'161725.SZ'].map(ts_code=>({ts_code,trade_date:params.trade_date,open:4.3,high:4.4,low:4.2,close:4.294,vol:100,amount:50})));
    return response([{ts_code:symbol.code,trade_date:params.trade_date,adj_factor:1.2671}]);
  };
  try{
    const a=await syncEtf({db,call:(_label,fn)=>fn(),log:()=>{}});
    assert.equal(a.rows,3);assert.equal(a.symbols,1);
    assert.equal(db.prepare('SELECT close FROM daily LIMIT 1').get().close,4.294);
    assert.equal(db.prepare('SELECT count(*) AS n FROM adj').get().n,3);
    calls.length=0;
    await syncEtf({db,call:(_label,fn)=>fn(),log:()=>{}});
    assert.ok(!calls.includes('fund_daily:20261012'));
    assert.ok(calls.includes('fund_daily:20261014'));
  }finally{globalThis.fetch=old;db.close();}
});
test('接口重复返回同一页时终止，不误报全量完成',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({code:0,data:{fields:['ts_code'],items:[['510300.SH']],has_more:true}}));
  try{await assert.rejects(etfPages('fund_daily',{},'',1,(_label,fn)=>fn()),/分页重复/);}
  finally{globalThis.fetch=old;}
});
