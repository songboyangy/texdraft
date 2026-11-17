import crypto from 'node:crypto';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { hashPassword } from '../lib/auth.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/http.js';
import { invalidateUser } from '../lib/userStatus.js';

/**
 * 账号与站点管理：注册模式、邀请码、管理员。
 *  - 第一个注册的用户自动成为管理员（无论注册模式）；ADMIN_EMAILS 中的邮箱注册 / 登录时也会成为管理员
 *  - 注册模式 open | invite | closed 存在 app_settings，环境变量 REGISTRATION 只提供初始默认值
 */

export type RegistrationMode = 'open' | 'invite' | 'closed';
const MODES: RegistrationMode[] = ['open', 'invite', 'closed'];

export async function getRegistrationMode(): Promise<RegistrationMode> {
  const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'registration'));
  const v = row?.value as RegistrationMode | undefined;
  return v && MODES.includes(v) ? v : config.registration;
}

export async function setRegistrationMode(mode: string) {
  if (!MODES.includes(mode as RegistrationMode)) throw badRequest('Invalid registration mode');
  await db
    .insert(schema.appSettings)
    .values({ key: 'registration', value: mode })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: mode, updatedAt: new Date() } });
}

export async function userCount() {
  const [r] = await db.select({ n: count() }).from(schema.users);
  return Number(r.n);
}

const isConfiguredAdmin = (email: string) => config.adminEmails.includes(email.toLowerCase());

// ---------------- 邀请码 ----------------

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createInvite(createdBy: string, opts: { note?: string; maxUses?: number; expiresInDays?: number | null }) {
  const code = crypto.randomBytes(12).toString('base64url');
  const maxUses = Math.min(1000, Math.max(1, Math.floor(opts.maxUses ?? 1)));
  const days = opts.expiresInDays === null ? null : Math.min(365, Math.max(1, Math.floor(opts.expiresInDays ?? 7)));
  const [row] = await db
    .insert(schema.invites)
    .values({
      codeHash: sha256(code),
      prefix: code.slice(0, 4),
      note: (opts.note ?? '').trim().slice(0, 120),
      maxUses,
      expiresAt: days === null ? null : new Date(Date.now() + days * 86400_000),
      createdBy,
    })
    .returning();
  return { code, invite: toInviteSummary(row) };
}

function toInviteSummary(r: typeof schema.invites.$inferSelect) {
  const expired = !!r.expiresAt && r.expiresAt.getTime() < Date.now();
  return {
    id: r.id,
    prefix: r.prefix,
    note: r.note,
    maxUses: r.maxUses,
    uses: r.uses,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    status: r.revokedAt ? 'revoked' : expired ? 'expired' : r.uses >= r.maxUses ? 'used' : 'active',
  } as const;
}

export async function listInvites() {
  const rows = await db.select().from(schema.invites).orderBy(desc(schema.invites.createdAt)).limit(200);
  return rows.map(toInviteSummary);
}

export async function revokeInvite(id: string) {
  const r = await db.update(schema.invites).set({ revokedAt: new Date() }).where(eq(schema.invites.id, id)).returning({ id: schema.invites.id });
  if (!r.length) throw notFound('Invite not found');
}

/** 原子地占用一次邀请码；无效时抛错 */
async function consumeInvite(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], code: string, zh: boolean) {
  const r = await tx
    .update(schema.invites)
    .set({ uses: sql`${schema.invites.uses} + 1` })
    .where(
      and(
        eq(schema.invites.codeHash, sha256(code.trim())),
        isNull(schema.invites.revokedAt),
        sql`${schema.invites.uses} < ${schema.invites.maxUses}`,
        sql`(${schema.invites.expiresAt} IS NULL OR ${schema.invites.expiresAt} > now())`,
      ),
    )
    .returning({ id: schema.invites.id });
  if (!r.length) throw new HttpError(403, zh ? '邀请码无效、已用完或已过期' : 'The invite code is invalid, used up or expired');
}

// ---------------- 注册 ----------------

export async function registerUser(input: { email: string; name: string; password: string; invite?: string }, zh: boolean) {
  const email = input.email.toLowerCase();
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    // 串行化注册，保证“第一个用户成为管理员”与邀请码计数的正确性
    await tx.execute(sql`SELECT pg_advisory_xact_lock(727001)`);
    const [{ n }] = await tx.select({ n: count() }).from(schema.users);
    const first = Number(n) === 0;
    if (!first) {
      const mode = await getRegistrationMode();
      if (mode === 'closed') throw new HttpError(403, zh ? '注册已关闭，请联系管理员' : 'Registration is closed. Ask an administrator for an account.');
      if (mode === 'invite') {
        if (!input.invite?.trim()) throw new HttpError(403, zh ? '需要邀请码才能注册' : 'An invite code is required to register');
        await consumeInvite(tx, input.invite, zh);
      }
    }
    const exists = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    if (exists.length) throw conflict(zh ? '该邮箱已注册' : 'This email is already registered');
    const [u] = await tx
      .insert(schema.users)
      .values({ email, name: input.name, passwordHash, isAdmin: first || isConfiguredAdmin(email) })
      .returning();
    return u;
  });
}

/** 登录时：ADMIN_EMAILS 中的账号自动提升为管理员 */
export async function promoteConfiguredAdmin(u: { id: string; email: string; isAdmin: boolean }) {
  if (!u.isAdmin && isConfiguredAdmin(u.email)) {
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, u.id));
    invalidateUser(u.id);
    return true;
  }
  return u.isAdmin;
}

// ---------------- 管理员：用户 ----------------

export async function listUsers() {
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      isAdmin: schema.users.isAdmin,
      disabledAt: schema.users.disabledAt,
      createdAt: schema.users.createdAt,
      projects: sql<number>`(SELECT count(*) FROM project_members m WHERE m.user_id = ${schema.users.id} AND m.role = 'owner')`,
      aiToday: sql<number>`(SELECT coalesce(sum(u.input_tokens + u.output_tokens), 0) FROM ai_usage u WHERE u.user_id = ${schema.users.id} AND u.day = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))`,
      ownKey: sql<boolean>`EXISTS (SELECT 1 FROM user_ai_settings s WHERE s.user_id = ${schema.users.id})`,
      creditMicros: schema.users.aiCreditMicros,
      spentMicros: sql<string>`(SELECT coalesce(sum(u.cost_micros), 0) FROM ai_usage u WHERE u.user_id = ${schema.users.id} AND u.source = 'shared')`,
    })
    .from(schema.users)
    .orderBy(asc(schema.users.createdAt));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    isAdmin: r.isAdmin,
    disabled: !!r.disabledAt,
    createdAt: r.createdAt.toISOString(),
    ownedProjects: Number(r.projects),
    aiTokensToday: Number(r.aiToday),
    ownAiKey: !!r.ownKey,
    /** 服务器 AI：累计花费；单独设置的总额度（null = 默认） */
    aiSpent: Number(r.spentMicros) / 1_000_000,
    aiCredit: r.creditMicros == null ? null : r.creditMicros / 1_000_000,
  }));
}

async function activeAdminCount() {
  const [r] = await db.select({ n: count() }).from(schema.users).where(and(eq(schema.users.isAdmin, true), isNull(schema.users.disabledAt)));
  return Number(r.n);
}

export async function updateUser(actorId: string, userId: string, patch: { isAdmin?: boolean; disabled?: boolean; aiCredit?: number | null }, zh: boolean) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u) throw notFound('User not found');
  if (userId === actorId && (patch.isAdmin === false || patch.disabled === true)) {
    throw badRequest(zh ? '不能取消自己的管理员身份或禁用自己' : 'You cannot demote or disable yourself');
  }
  const losesAdmin = u.isAdmin && !u.disabledAt && (patch.isAdmin === false || patch.disabled === true);
  if (losesAdmin && (await activeAdminCount()) <= 1) throw badRequest(zh ? '至少需要保留一位管理员' : 'At least one administrator is required');
  const set: Partial<typeof schema.users.$inferInsert> = {};
  if (patch.isAdmin !== undefined) set.isAdmin = patch.isAdmin;
  if (patch.disabled !== undefined) set.disabledAt = patch.disabled ? new Date() : null;
  if (patch.aiCredit !== undefined) set.aiCreditMicros = patch.aiCredit === null ? null : Math.round(patch.aiCredit * 1_000_000);
  if (Object.keys(set).length) await db.update(schema.users).set(set).where(eq(schema.users.id, userId));
  invalidateUser(userId);
}

/** 管理员重置密码：生成临时密码，并作废该用户所有会话 */
export async function resetPassword(userId: string) {
  const temp = crypto.randomBytes(9).toString('base64url');
  const r = await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(temp), sessionsValidAfter: new Date() })
    .where(eq(schema.users.id, userId))
    .returning({ id: schema.users.id });
  if (!r.length) throw notFound('User not found');
  invalidateUser(userId);
  return temp;
}

/** 用户自己修改密码：作废其他会话（调用方随后为当前请求签发新会话） */
export async function changeOwnPassword(userId: string, newPassword: string) {
  // 作废此刻之前签发的会话；调用方随后为当前请求签发的新会话不受影响
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(newPassword), sessionsValidAfter: new Date() })
    .where(eq(schema.users.id, userId));
  invalidateUser(userId);
}

/** 管理后台展示用的 AI 额度策略 */
export function aiPolicy() {
  return {
    sharedKey: config.ai.sharedKey,
    defaultCredit: config.ai.sharedCredit > 0 ? config.ai.sharedCredit : null,
    dailyTokens: config.ai.sharedDailyTokens,
    currency: config.ai.currency,
  };
}
