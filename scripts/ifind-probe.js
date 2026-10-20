// 核对 iFinD 原始返回：打印未经单位换算的 volume / amount，以及 amount/volume 推算的均价
//   node scripts/ifind-probe.js 000001.SH,883418.TI 2026-10-19 2026-10-20
// 均价落在股价范围（几元到几十元）说明 volume 单位是股；放大 100 倍说明是手。
// 每个日期 1 次日线请求，不计入本地额度账本。
import { createIfindClient } from '../server/ifind-client.js';

const [codes, ...days] = process.argv.slice(2);
if (!codes || !days.length) throw new Error('用法：node scripts/ifind-probe.js 代码1,代码2 日期1 [日期2 …]');
const client = createIfindClient();
for (const day of days) {
  const { rows, cells } = await client.query('daily', codes.split(','), day);
  console.log(`== ${day}（dataVol=${cells}）`);
  for (const r of rows) {
    const price = Number(r.amount) / Number(r.volume);
    console.log(`${r.code}  volume=${r.volume}  amount=${r.amount}  均价=${Number.isFinite(price) ? price.toFixed(2) : '-'}`);
  }
}
