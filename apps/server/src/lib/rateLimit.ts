import type { FastifyRequest } from 'fastify';
import { HttpError } from './http.js';

/**
 * 登录 / 注册的失败次数限制（内存计数，单实例）。
 * 经 Cloudflare / 反向代理访问时，请求都来自 127.0.0.1，因此优先使用 CF-Connecting-IP / X-Forwarded-For。
 */
const WINDOW_MS = 15 * 60 * 1000;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function clientIp(req: FastifyRequest) {
  const ip = req.ip;
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (loopback) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf;
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return ip;
}

function bucket(key: string) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, b);
  }
  if (buckets.size > 50_000) for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  return b;
}

/** 失败过多时拒绝（429）；成功登录后调用 reset 清零该账号的计数 */
export function checkLimit(keys: { key: string; max: number }[], zh = true) {
  for (const { key, max } of keys) {
    const b = bucket(key);
    if (b.count >= max) {
      const mins = Math.ceil((b.resetAt - Date.now()) / 60000);
      throw new HttpError(429, zh ? `尝试次数过多，请 ${mins} 分钟后再试` : `Too many attempts, try again in ${mins} min`);
    }
  }
}

export function recordFailure(keys: string[]) {
  for (const k of keys) bucket(k).count++;
}

export function resetLimit(key: string) {
  buckets.delete(key);
}

/** 登录：同一账号 10 次 / 同一 IP 30 次（15 分钟内） */
export function loginKeys(req: FastifyRequest, email: string) {
  return [
    { key: `login:email:${email}`, max: 10 },
    { key: `login:ip:${clientIp(req)}`, max: 30 },
  ];
}

/** 通用固定窗口计数：key 在 windowMs 内最多 max 次（max <= 0 不限）。超出时抛 429 */
const windows = new Map<string, { count: number; resetAt: number }>();
export function consume(key: string, max: number, windowMs: number, message: (retryMin: number) => string) {
  if (max <= 0) return;
  const now = Date.now();
  let w = windows.get(key);
  if (!w || w.resetAt < now) {
    w = { count: 0, resetAt: now + windowMs };
    windows.set(key, w);
  }
  if (windows.size > 50_000) for (const [k, v] of windows) if (v.resetAt < now) windows.delete(k);
  if (w.count >= max) throw new HttpError(429, message(Math.max(1, Math.ceil((w.resetAt - now) / 60000))));
  w.count++;
}

/** 只检查不计数（例如注册成功后才计入） */
export function peekExceeded(key: string, max: number) {
  if (max <= 0) return false;
  const w = windows.get(key);
  return !!w && w.resetAt >= Date.now() && w.count >= max;
}
