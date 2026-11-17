import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  changeOwnPassword,
  createInvite,
  getRegistrationMode,
  listInvites,
  aiPolicy,
  listUsers,
  promoteConfiguredAdmin,
  registerUser,
  resetPassword,
  revokeInvite,
  setRegistrationMode,
  updateUser,
  userCount,
} from '../accounts/service.js';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { SESSION_COOKIE, parseSession, sessionCookieOptions, signSession, verifyPassword } from '../lib/auth.js';
import { HttpError, badRequest } from '../lib/http.js';
import { checkLimit, clientIp, consume, loginKeys, peekExceeded, recordFailure, resetLimit } from '../lib/rateLimit.js';
import { turnstileEnabled, verifyTurnstile } from '../lib/turnstile.js';
import { createSampleProject } from '../projects/sample.js';
import { sessionStillValid, userStatus } from '../lib/userStatus.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string | null;
  }
}

export function currentUser(req: FastifyRequest): string {
  if (!req.userId) throw new HttpError(401, 'Not signed in');
  return req.userId;
}

/** 接口提示语言：浏览器首选英文时用英文，否则中文 */
export const prefersZh = (req: FastifyRequest) => !/^en\b/i.test(String(req.headers['accept-language'] ?? ''));

const Register = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
  invite: z.string().max(200).optional(),
  /** Cloudflare Turnstile 令牌（启用人机验证时必填） */
  turnstileToken: z.string().max(4096).optional(),
});
const Login = z.object({ email: z.string(), password: z.string() });

/** 必须注册在根实例上（Fastify 插件作用域是封装的） */
export function installSessionHook(app: FastifyInstance) {
  app.decorateRequest('userId', null);
  app.addHook('onRequest', async (req) => {
    const s = parseSession(req.cookies[SESSION_COOKIE]);
    // 用户被禁用、密码被重置后签发的会话之前的会话都视为未登录
    req.userId = s && (await sessionStillValid(s.uid, s.iat)) ? s.uid : null;
  });
}

async function requireAdmin(req: FastifyRequest) {
  const uid = currentUser(req);
  if (!(await userStatus(uid)).isAdmin) throw new HttpError(403, prefersZh(req) ? '需要管理员权限' : 'Administrator access required');
  return uid;
}

const publicUser = (u: { id: string; email: string; name: string; isAdmin: boolean }) => ({ id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin });

/** 登录校验（网页登录与 OAuth 授权页共用）：限流、禁用检查、ADMIN_EMAILS 提升 */
export async function authenticatePassword(req: FastifyRequest, emailRaw: string, password: string) {
  const zh = prefersZh(req);
  const email = emailRaw.trim().toLowerCase();
  const keys = loginKeys(req, email);
  checkLimit(keys, zh);
  const [u] = email ? await db.select().from(schema.users).where(eq(schema.users.email, email)) : [];
  if (!u || !(await verifyPassword(password, u.passwordHash))) {
    recordFailure(keys.map((k) => k.key));
    throw new HttpError(401, zh ? '邮箱或密码错误' : 'Wrong email or password');
  }
  if (u.disabledAt) throw new HttpError(403, zh ? '该账号已被管理员禁用' : 'This account has been disabled by an administrator');
  resetLimit(keys[0].key);
  const isAdmin = await promoteConfiguredAdmin(u);
  return { ...u, isAdmin };
}

export async function authRoutes(app: FastifyInstance) {
  /** 登录页需要知道是否开放注册 */
  app.get('/api/auth/config', async () => {
    const users = await userCount();
    return {
      registration: users === 0 ? 'open' : await getRegistrationMode(),
      firstUser: users === 0,
      demo: config.demo.enabled,
      sourceUrl: config.demo.sourceUrl || null,
      notice: config.demo.notice && config.demo.notice !== 'off' ? config.demo.notice : null,
      turnstileSiteKey: turnstileEnabled() ? config.demo.turnstileSiteKey : null,
    };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const zh = prefersZh(req);
    const parsed = Register.safeParse(req.body);
    if (!parsed.success) throw badRequest(zh ? '请填写有效的邮箱、昵称和至少 8 位的密码' : 'Enter a valid email, a name and a password of at least 8 characters');
    const ip = clientIp(req);
    const ipKey = { key: `register:ip:${ip}`, max: 20 };
    checkLimit([ipKey], zh);
    recordFailure([ipKey.key]); // 计入每次注册尝试，限制批量注册
    // 同一 IP 每天成功注册的账号数（REGISTRATIONS_PER_IP_PER_DAY，体验站防止批量注册薅免费额度）
    const dayKey = `register:day:${ip}`;
    const perDay = config.quota.registrationsPerIpPerDay;
    if (peekExceeded(dayKey, perDay)) {
      throw new HttpError(429, zh ? '这个网络今天注册的账号太多了，请明天再试' : 'Too many accounts were registered from this network today. Please try again tomorrow.');
    }
    await verifyTurnstile(parsed.data.turnstileToken, ip, zh);
    const { turnstileToken: _t, ...data } = parsed.data;
    const u = await registerUser(data, zh);
    consume(dayKey, perDay, 24 * 60 * 60 * 1000, () => '');
    if (config.demo.sampleProject) await createSampleProject(u.id).catch((e) => req.log.error(e, 'sample project'));
    reply.setCookie(SESSION_COOKIE, signSession(u.id), sessionCookieOptions(req));
    return publicUser(u);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = Login.safeParse(req.body);
    if (!parsed.success) throw badRequest(prefersZh(req) ? '请输入邮箱和密码' : 'Enter your email and password');
    const u = await authenticatePassword(req, parsed.data.email, parsed.data.password);
    reply.setCookie(SESSION_COOKIE, signSession(u.id), sessionCookieOptions(req));
    return publicUser(u);
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const uid = currentUser(req);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, uid));
    if (!u) throw new HttpError(401, 'Not signed in');
    return publicUser(u);
  });

  /** 修改自己的密码：校验当前密码，作废其他设备上的会话，本设备重新签发 */
  app.post('/api/auth/password', async (req, reply) => {
    const uid = currentUser(req);
    const zh = prefersZh(req);
    const body = z.object({ current: z.string(), next: z.string().min(8).max(200) }).safeParse(req.body);
    if (!body.success) throw badRequest(zh ? '新密码至少 8 位' : 'The new password must have at least 8 characters');
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, uid));
    const keys = loginKeys(req, u.email);
    checkLimit(keys, zh);
    if (!(await verifyPassword(body.data.current, u.passwordHash))) {
      recordFailure(keys.map((k) => k.key));
      throw new HttpError(400, zh ? '当前密码不正确' : 'The current password is incorrect');
    }
    await changeOwnPassword(uid, body.data.next);
    reply.setCookie(SESSION_COOKIE, signSession(uid), sessionCookieOptions(req));
    return { ok: true };
  });

  // ---------------- 管理员 ----------------

  app.get('/api/admin/users', async (req) => {
    await requireAdmin(req);
    return { users: await listUsers(), ai: aiPolicy() };
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    const uid = await requireAdmin(req);
    const body = z
      .object({
        isAdmin: z.boolean().optional(),
        disabled: z.boolean().optional(),
        /** 服务器 AI 总额度（货币单位）；null = 恢复默认 */
        aiCredit: z.number().min(0).max(1_000_000).nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('Invalid request');
    await updateUser(uid, req.params.id, body.data, prefersZh(req));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-password', async (req) => {
    await requireAdmin(req);
    return { password: await resetPassword(req.params.id) };
  });

  app.get('/api/admin/settings', async (req) => {
    await requireAdmin(req);
    return { registration: await getRegistrationMode() };
  });

  app.patch('/api/admin/settings', async (req) => {
    await requireAdmin(req);
    const body = z.object({ registration: z.enum(['open', 'invite', 'closed']) }).safeParse(req.body);
    if (!body.success) throw badRequest('Invalid settings');
    await setRegistrationMode(body.data.registration);
    return { registration: body.data.registration };
  });

  app.get('/api/admin/invites', async (req) => {
    await requireAdmin(req);
    return listInvites();
  });

  app.post('/api/admin/invites', async (req) => {
    const uid = await requireAdmin(req);
    const body = z
      .object({ note: z.string().max(120).optional(), maxUses: z.number().int().min(1).max(1000).optional(), expiresInDays: z.number().int().min(1).max(365).nullable().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) throw badRequest('Invalid invite');
    return createInvite(uid, body.data);
  });

  app.delete<{ Params: { id: string } }>('/api/admin/invites/:id', async (req) => {
    await requireAdmin(req);
    await revokeInvite(req.params.id);
    return { ok: true };
  });
}
