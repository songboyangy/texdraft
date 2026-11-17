import type { ProjectTag } from '@texdraft/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { requireRole } from './service.js';

/**
 * 项目标签：每个用户自己的分类，一个项目可以有多个标签。标签只影响自己看到的项目列表，
 * 所以给项目打标签只需要能看到这个项目（viewer 即可）。
 */

const MAX_TAGS = 100;

export function cleanTagName(raw: unknown): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw badRequest('Tag name is required');
  if (name.length > 40) throw badRequest('Tag name is too long (max 40 characters)');
  return name;
}

export async function listTags(userId: string): Promise<ProjectTag[]> {
  const rows = await db
    .select({
      id: schema.tags.id,
      name: schema.tags.name,
      // 只数当前用户仍是成员的项目（被移出共享项目后不再计入）
      count: sql<number>`count(${schema.projectMembers.projectId})::int`,
    })
    .from(schema.tags)
    .leftJoin(schema.projectTags, eq(schema.projectTags.tagId, schema.tags.id))
    .leftJoin(
      schema.projectMembers,
      and(eq(schema.projectMembers.projectId, schema.projectTags.projectId), eq(schema.projectMembers.userId, userId)),
    )
    .where(eq(schema.tags.userId, userId))
    .groupBy(schema.tags.id)
    .orderBy(asc(sql`lower(${schema.tags.name})`));
  return rows;
}

/** projectId → 当前用户给它打的标签 id */
export async function tagsByProject(userId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ projectId: schema.projectTags.projectId, tagId: schema.projectTags.tagId })
    .from(schema.projectTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.projectTags.tagId))
    .where(eq(schema.tags.userId, userId));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.projectId, [...(out.get(r.projectId) ?? []), r.tagId]);
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownTag(userId: string, tagId: string) {
  if (!UUID_RE.test(tagId)) throw notFound('Tag not found');
  const [t] = await db.select().from(schema.tags).where(and(eq(schema.tags.id, tagId), eq(schema.tags.userId, userId)));
  if (!t) throw notFound('Tag not found');
  return t;
}

async function findByName(userId: string, name: string) {
  const [t] = await db
    .select()
    .from(schema.tags)
    .where(and(eq(schema.tags.userId, userId), sql`lower(${schema.tags.name}) = lower(${name})`));
  return t ?? null;
}

export async function createTag(userId: string, rawName: string): Promise<ProjectTag> {
  const name = cleanTagName(rawName);
  if (await findByName(userId, name)) throw conflict(`Tag "${name}" already exists`);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.tags).where(eq(schema.tags.userId, userId));
  if (n >= MAX_TAGS) throw badRequest(`At most ${MAX_TAGS} tags`);
  const [t] = await db.insert(schema.tags).values({ userId, name }).returning();
  return { id: t.id, name: t.name, count: 0 };
}

export async function renameTag(userId: string, tagId: string, rawName: string) {
  await ownTag(userId, tagId);
  const name = cleanTagName(rawName);
  const other = await findByName(userId, name);
  if (other && other.id !== tagId) throw conflict(`Tag "${name}" already exists`);
  await db.update(schema.tags).set({ name }).where(eq(schema.tags.id, tagId));
}

/** 删除标签：项目本身不受影响 */
export async function deleteTag(userId: string, tagId: string) {
  await ownTag(userId, tagId);
  await db.delete(schema.tags).where(eq(schema.tags.id, tagId));
}

export async function setProjectTag(userId: string, tagId: string, projectId: string, on: boolean) {
  await ownTag(userId, tagId);
  if (!UUID_RE.test(projectId)) throw notFound('Project not found');
  await requireRole(projectId, userId, 'viewer');
  if (on) await db.insert(schema.projectTags).values({ tagId, projectId }).onConflictDoNothing();
  else await db.delete(schema.projectTags).where(and(eq(schema.projectTags.tagId, tagId), eq(schema.projectTags.projectId, projectId)));
}

/** 按名称增删一个项目的标签（MCP 用）：add 中不存在的标签会自动创建。返回项目现在的标签名 */
export async function editProjectTagsByName(userId: string, projectId: string, add: string[], remove: string[]): Promise<string[]> {
  await requireRole(projectId, userId, 'viewer');
  for (const raw of add) {
    const name = cleanTagName(raw);
    const t = (await findByName(userId, name)) ?? (await createTag(userId, name));
    await db.insert(schema.projectTags).values({ tagId: t.id, projectId }).onConflictDoNothing();
  }
  for (const raw of remove) {
    const t = await findByName(userId, cleanTagName(raw));
    if (t) await db.delete(schema.projectTags).where(and(eq(schema.projectTags.tagId, t.id), eq(schema.projectTags.projectId, projectId)));
  }
  const ids = (await tagsByProject(userId)).get(projectId) ?? [];
  if (!ids.length) return [];
  const rows = await db.select({ name: schema.tags.name }).from(schema.tags).where(inArray(schema.tags.id, ids)).orderBy(asc(schema.tags.name));
  return rows.map((r) => r.name);
}
