/**
 * 签发调试用的登录 token（正式环境由围炉工作台签发，见 server/auth.js）
 *
 *   npm run token                  导播（control），8 小时
 *   npm run token -- admin 24      管理员，24 小时
 *   npm run token -- secret        生成随机的 AUTH_SECRET / RENDER_KEY，填进 .env
 */
import crypto from 'node:crypto';
import { signToken, AUTH_ENABLED } from '../server/auth.js';

const [arg = 'control', hours = '8'] = process.argv.slice(2);

if (arg === 'secret') {
  console.log(`AUTH_SECRET=${crypto.randomBytes(32).toString('hex')}`);
  console.log(`RENDER_KEY=${crypto.randomBytes(16).toString('hex')}`);
  process.exit(0);
}
if (!AUTH_ENABLED) {
  console.error('没有配置 AUTH_SECRET：先运行 npm run token -- secret，把结果填进 .env');
  process.exit(1);
}
if (!['control', 'admin'].includes(arg)) {
  console.error(`未知角色 ${arg}，可选 control / admin`);
  process.exit(1);
}

const token = signToken({ sub: `dev-${arg}`, name: `调试${arg === 'admin' ? '管理员' : '导播'}`, role: arg }, Math.round(+hours * 3600));
const port = process.env.PORT || 8787;
console.log(token);
console.log(`\n浏览器打开即可登录（写入 Cookie 后跳到导播台）：`);
console.log(`  开发：http://localhost:5173/api/login?token=${token}`);
console.log(`  打包：http://localhost:${port}/api/login?token=${token}`);
