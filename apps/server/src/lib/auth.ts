import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { sessionStillValid } from './userStatus.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const SESSION_COOKIE = 'tp_session';
const SESSION_TTL_S = 30 * 24 * 3600;

/** 无状态会话令牌：base64url(json).hmac */
export function signSession(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, iat: Date.now(), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }),
  ).toString('base64url');
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** 校验签名与过期时间，返回会话内容（不查库；是否已被作废由 userStatus 判断）。iat 为签发时刻（毫秒） */
export function parseSession(token: string | undefined | null): { uid: string; iat: number } | null {
  const uid = verifySession(token);
  if (!uid) return null;
  try {
    const { iat } = JSON.parse(Buffer.from(token!.split('.')[0], 'base64url').toString());
    return { uid, iat: typeof iat === 'number' ? iat : 0 };
  } catch {
    return null;
  }
}

export function verifySession(token: string | undefined | null): string | null {
  if (!token) return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return null;
  }
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof uid !== 'string' || typeof exp !== 'number' || exp < Date.now() / 1000) return null;
    return uid;
  } catch {
    return null;
  }
}

/**
 * 按本次请求的协议决定 Cookie 是否带 Secure：
 * 经 HTTPS 反向代理 / Cloudflare Tunnel 访问时（X-Forwarded-Proto: https）带 Secure，
 * 内网直接用 http://IP:端口 访问时不带，否则浏览器会丢弃 Cookie 导致无法登录。
 */
export function sessionCookieOptions(req: { headers: Record<string, string | string[] | undefined> }) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: proto === 'https',
    maxAge: SESSION_TTL_S,
  };
}

/** 从原始 Cookie 头里取会话（WebSocket 握手时用），并确认用户未被禁用、会话未被作废 */
export async function userIdFromCookieHeader(cookieHeader: string | null | undefined): Promise<string | null> {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) {
      const s = parseSession(decodeURIComponent(v.join('=')));
      return s && (await sessionStillValid(s.uid, s.iat)) ? s.uid : null;
    }
  }
  return null;
}
