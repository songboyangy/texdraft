import crypto from 'node:crypto';
import type { ApiTokenSummary } from '@texdraft/shared';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { notFound } from '../lib/http.js';
import { userStatus } from '../lib/userStatus.js';
import { ACCESS_PREFIX, apiTokenIdForAccessToken } from '../oauth/service.js';

/** 令牌格式：tp_ + 32 字节随机数（base64url）；数据库只保存 SHA-256 */
const PREFIX = 'tp_';
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export interface TokenAuth {
  tokenId: string;
  tokenName: string;
  userId: string;
  /** 令牌限定的项目；为空表示可访问用户的所有项目 */
  projectId: string | null;
}

export async function createToken(userId: string, name: string, projectId: string | null) {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(schema.apiTokens)
    .values({ userId, name: name.trim().slice(0, 80) || 'Local agent', tokenHash: hash(token), prefix: token.slice(0, 10), projectId })
    .returning();
  return { token, summary: await toSummary(row) };
}

async function toSummary(r: typeof schema.apiTokens.$inferSelect): Promise<ApiTokenSummary> {
  let projectName: string | null = null;
  if (r.projectId) {
    const [p] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, r.projectId));
    projectName = p?.name ?? null;
  }
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    projectId: r.projectId,
    projectName,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  };
}

export async function listTokens(userId: string): Promise<ApiTokenSummary[]> {
  const rows = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, userId)).orderBy(desc(schema.apiTokens.createdAt));
  return Promise.all(rows.map(toSummary));
}

export async function revokeToken(userId: string, id: string) {
  const res = await db
    .delete(schema.apiTokens)
    .where(and(eq(schema.apiTokens.id, id), eq(schema.apiTokens.userId, userId)))
    .returning({ id: schema.apiTokens.id });
  if (!res.length) throw notFound('Token not found');
}

const lastTouched = new Map<string, number>();

/**
 * 校验 Authorization: Bearer …；成功时更新最后使用时间（最多每分钟写一次库）
 *  - tp_…：网页上生成的个人访问令牌
 *  - tpa_…：OAuth 访问令牌（ChatGPT / Claude.ai 等），映射到授权时创建的 api_tokens 记录
 */
export async function authenticateToken(header: string | undefined): Promise<TokenAuth | null> {
  const m = /^Bearer\s+((?:tp|tpa)_[A-Za-z0-9_-]{20,})\s*$/.exec(header ?? '');
  if (!m) return null;
  let row: typeof schema.apiTokens.$inferSelect | undefined;
  if (m[1].startsWith(ACCESS_PREFIX)) {
    const id = await apiTokenIdForAccessToken(m[1]);
    if (!id) return null;
    [row] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id));
  } else {
    [row] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, hash(m[1])));
  }
  if (!row) return null;
  // 被禁用的用户：令牌立即失效
  if ((await userStatus(row.userId)).disabled) return null;
  if (Date.now() - (lastTouched.get(row.id) ?? 0) > 60_000) {
    lastTouched.set(row.id, Date.now());
    // drizzle 查询是惰性的，必须 then 才会真正执行
    db.update(schema.apiTokens).set({ lastUsedAt: new Date() }).where(eq(schema.apiTokens.id, row.id)).then(() => {}, () => {});
  }
  return { tokenId: row.id, tokenName: row.name, userId: row.userId, projectId: row.projectId };
}
