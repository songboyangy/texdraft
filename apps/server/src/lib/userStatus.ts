import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

/**
 * 用户状态（管理员 / 禁用 / 会话作废时间）的短时缓存。
 * 会话令牌是无状态签名的，禁用用户或重置密码需要在每次请求时确认；缓存避免每个请求都查库。
 * 修改状态的地方调用 invalidateUser，单实例下立即生效。
 */
interface Status { exists: boolean; isAdmin: boolean; disabled: boolean; validAfter: number }
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; status: Status }>();

export async function userStatus(uid: string): Promise<Status> {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.status;
  const [u] = await db
    .select({ isAdmin: schema.users.isAdmin, disabledAt: schema.users.disabledAt, validAfter: schema.users.sessionsValidAfter })
    .from(schema.users)
    .where(eq(schema.users.id, uid));
  const status: Status = u
    ? { exists: true, isAdmin: u.isAdmin, disabled: !!u.disabledAt, validAfter: u.validAfter ? u.validAfter.getTime() : 0 }
    : { exists: false, isAdmin: false, disabled: true, validAfter: 0 };
  cache.set(uid, { at: Date.now(), status });
  return status;
}

export function invalidateUser(uid: string) {
  cache.delete(uid);
}

/** 会话是否仍然有效：用户存在、未被禁用、签发时间（毫秒）不早于作废时间 */
export async function sessionStillValid(uid: string, iatMs: number) {
  const s = await userStatus(uid);
  return s.exists && !s.disabled && iatMs >= s.validAfter;
}
