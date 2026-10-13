/**
 * 鉴权：围炉工作台（WeiLuApp）签发的 JWT（HS256）+ 直播画面只读 key + Origin 校验
 *
 * 角色
 *   admin    管理员：导播台全部操作 + 触发数据同步（POST /api/sync）
 *   control  导播：导播台全部操作
 *   render   直播画面（vMix 浏览器源）：只接收画面数据，不能发控制指令。用 RENDER_KEY，不走登录
 *
 * 凭证从哪里来（按顺序）
 *   1. Authorization: Bearer <JWT>
 *   2. Cookie：AUTH_COOKIE（默认 weilu_token），由工作台登录后写在上级域名上，或经 /api/login 写入
 *   3. URL ?token=<JWT>（仅供调试；正式环境用 Cookie，避免 token 进访问日志）
 *   直播画面：URL ?key=<RENDER_KEY>
 *
 * JWT payload：{ sub, name?, role: 'admin' | 'control', exp, iat? }，exp 必填
 *
 * 没有配置 AUTH_SECRET 时不开启鉴权（内网模式，与之前一致），启动时会打印警告。
 */
import crypto from 'node:crypto';

const SECRET = process.env.AUTH_SECRET || '';
const RENDER_KEY = process.env.RENDER_KEY || '';
export const AUTH_COOKIE = process.env.AUTH_COOKIE || 'weilu_token';
export const AUTH_ENABLED = SECRET.length > 0;
// 允许的页面来源（逗号分隔，如 https://kline.example.com）；不填 = 只允许与服务同域名
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

const USER_ROLES = ['control', 'admin'];
const RANK = { render: 1, control: 2, admin: 3 };

/** 角色是否达到要求：admin ⊃ control ⊃ render */
export const hasRole = (role, need) => (RANK[role] ?? 0) >= RANK[need];

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest();
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

/** 签发 JWT（scripts/token.js 调试用；正式环境由工作台签发） */
export function signToken(payload, ttlSeconds) {
  if (!AUTH_ENABLED) throw new Error('没有配置 AUTH_SECRET');
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now, exp: now + ttlSeconds, ...payload }));
  return `${head}.${body}.${b64url(sign(`${head}.${body}`))}`;
}

/** 校验 JWT：签名、算法、有效期、角色。不合法返回 null */
export function verifyToken(token) {
  if (!AUTH_ENABLED || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  try {
    if (JSON.parse(Buffer.from(head, 'base64url')).alg !== 'HS256') return null;
    if (!safeEqual(Buffer.from(sig, 'base64url'), sign(`${head}.${body}`))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url'));
    const now = Date.now() / 1000;
    if (!Number.isFinite(p.exp) || p.exp <= now) return null;
    if (Number.isFinite(p.nbf) && p.nbf > now) return null;
    if (!USER_ROLES.includes(p.role)) return null;
    return p;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * 识别请求者：{ role: 'admin' | 'control' | 'render' | null, user, exp }
 * 未开启鉴权时一律当管理员
 */
export function authenticate(req, url) {
  if (!AUTH_ENABLED) return { role: 'admin', user: null, exp: null };
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  const token = bearer || readCookie(req, AUTH_COOKIE) || url.searchParams.get('token');
  const p = token && verifyToken(token);
  if (p) return { role: p.role, user: { id: p.sub ?? null, name: p.name ?? p.sub ?? null }, exp: p.exp };
  const key = url.searchParams.get('key');
  if (RENDER_KEY && key && safeEqual(Buffer.from(key), Buffer.from(RENDER_KEY))) return { role: 'render', user: null, exp: null };
  return { role: null, user: null, exp: null };
}

/**
 * Origin 校验（防止别的网站借导播员浏览器里的登录态发指令）。
 * 没有 Origin 头的请求（非浏览器：curl、脚本）放行，它们拿不到浏览器里的 Cookie，仍要自己带凭证。
 */
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ORIGINS.length) return ORIGINS.includes(origin.replace(/\/+$/, ''));
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** /api/login 写入的 Cookie：HttpOnly，过期时间与 token 一致；经 HTTPS 访问时加 Secure */
export function loginCookie(req, token, exp) {
  const https = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  const maxAge = Math.max(0, Math.floor(exp - Date.now() / 1000));
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
}

export function authSummary() {
  if (!AUTH_ENABLED) return '未开启（没有配置 AUTH_SECRET，任何人都能控制，只能在内网使用）';
  return `已开启 · Cookie ${AUTH_COOKIE} · 直播画面 key ${RENDER_KEY ? '已配置' : '未配置（直播画面需要登录才能打开）'} · 允许来源 ${ORIGINS.length ? ORIGINS.join(', ') : '同域名'}`;
}
