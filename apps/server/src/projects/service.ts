import type { Engine, FileEntry, ProjectDetail, ProjectSummary, Role } from '@texdraft/shared';
import { and, asc, count, desc, eq, sql, sum } from 'drizzle-orm';
import { config } from '../config.js';
import {
  encodeInitialState, evictDocument, readText, setWholeText, transactText,
} from '../collab/hocuspocus.js';
import { db, schema } from '../db/client.js';
import type { SnapshotFile } from '../db/schema.js';
import { blobStore } from '../lib/blobStore.js';
import { publishProjectEvent } from '../lib/events.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { userStatus } from '../lib/userStatus.js';
import { isTextPath, normalizeProjectPath } from '../lib/paths.js';
import { tagsByProject } from './tags.js';

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
export const ENGINES: Engine[] = ['pdflatex', 'xelatex', 'lualatex'];

export const MAIN_TEMPLATE = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled Paper}
\author{Author Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Write your abstract here.
\end{abstract}

\section{Introduction}
Start writing here. Ask the AI assistant on the right to draft, polish or fix anything.

\end{document}
`;

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

export async function getRole(projectId: string, userId: string): Promise<Role | null> {
  const rows = await db
    .select({ role: schema.projectMembers.role })
    .from(schema.projectMembers)
    .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, userId)))
    .limit(1);
  return (rows[0]?.role as Role) ?? null;
}

export async function requireRole(projectId: string, userId: string, min: Role): Promise<Role> {
  const role = await getRole(projectId, userId);
  if (!role) throw notFound('Project not found');
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw forbidden(`Requires ${min} access`);
  return role;
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

export async function listProjects(userId: string): Promise<ProjectSummary[]> {
  const rows = await db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
      role: schema.projectMembers.role,
      updatedAt: schema.projects.updatedAt,
    })
    .from(schema.projectMembers)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectMembers.projectId))
    .where(eq(schema.projectMembers.userId, userId))
    .orderBy(desc(schema.projects.updatedAt));
  const tags = await tagsByProject(userId);
  return rows.map((r) => ({ ...r, role: r.role as Role, updatedAt: r.updatedAt.toISOString(), tags: tags.get(r.id) ?? [] }));
}

export async function getProject(projectId: string, userId: string): Promise<ProjectDetail> {
  const role = await requireRole(projectId, userId, 'viewer');
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!p) throw notFound();
  return {
    id: p.id,
    name: p.name,
    role,
    mainFile: p.mainFile,
    engine: p.engine as Engine,
    updatedAt: p.updatedAt.toISOString(),
  };
}

// ---------------- 配额（MAX_PROJECTS_PER_USER / MAX_PROJECT_BYTES，PUBLIC_DEMO 时默认开启） ----------------

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** 新建 / 导入 / 复制项目前检查项目数上限（管理员不限） */
export async function assertCanCreateProject(userId: string) {
  const max = config.quota.maxProjectsPerUser;
  if (max <= 0 || (await userStatus(userId)).isAdmin) return;
  const [r] = await db.select({ n: count() }).from(schema.projects).where(eq(schema.projects.ownerId, userId));
  if (Number(r.n) >= max) {
    throw new HttpError(403, `项目数已达上限（${max} 个），请删除不用的项目后再试 / Project limit reached (${max}). Delete a project you no longer need.`);
  }
}

/** 写入文件前检查项目总大小上限；replacedBytes 为被覆盖文件原来的大小 */
export async function assertProjectSpace(projectId: string, addBytes: number, replacedBytes = 0) {
  const max = config.quota.maxProjectBytes;
  if (max <= 0) return;
  const [r] = await db.select({ total: sum(schema.files.size) }).from(schema.files).where(eq(schema.files.projectId, projectId));
  if (Number(r.total ?? 0) - replacedBytes + addBytes > max) {
    throw new HttpError(413, `项目文件总大小超过上限（${mb(max)}） / The project would exceed the size limit (${mb(max)}).`);
  }
}

export async function createProject(userId: string, name: string): Promise<ProjectSummary> {
  await assertCanCreateProject(userId);
  const trimmed = name.trim().slice(0, 120) || 'Untitled Project';
  const project = await db.transaction(async (tx) => {
    const [p] = await tx.insert(schema.projects).values({ ownerId: userId, name: trimmed }).returning();
    await tx.insert(schema.projectMembers).values({ projectId: p.id, userId, role: 'owner' });
    const [f] = await tx
      .insert(schema.files)
      .values({ projectId: p.id, path: 'main.tex', kind: 'text', size: Buffer.byteLength(MAIN_TEMPLATE) })
      .returning();
    await tx.insert(schema.docStates).values({ fileId: f.id, state: encodeInitialState(MAIN_TEMPLATE) });
    return p;
  });
  return { id: project.id, name: project.name, role: 'owner', updatedAt: project.updatedAt.toISOString() };
}

export async function updateProject(
  projectId: string,
  userId: string,
  patch: { name?: string; mainFile?: string; engine?: string },
) {
  await requireRole(projectId, userId, 'editor');
  const set: Partial<typeof schema.projects.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || 'Untitled Project';
  if (patch.mainFile !== undefined) {
    const p = normalizeProjectPath(patch.mainFile);
    if (!(await findFile(projectId, p))) throw badRequest(`File not found: ${p}`);
    set.mainFile = p;
  }
  if (patch.engine !== undefined) {
    if (!ENGINES.includes(patch.engine as Engine)) throw badRequest('Unsupported engine');
    set.engine = patch.engine;
  }
  await db.update(schema.projects).set(set).where(eq(schema.projects.id, projectId));
}

export async function deleteProject(projectId: string, userId: string) {
  await requireRole(projectId, userId, 'owner');
  const fs = await listFiles(projectId);
  await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
  for (const f of fs) {
    if (f.kind === 'text') await evictDocument(f.id);
  }
}

// ---------------------------------------------------------------------------
// 文件（所有路径均为项目内相对路径）
// ---------------------------------------------------------------------------

type FileRow = typeof schema.files.$inferSelect;

export async function listFiles(projectId: string): Promise<FileEntry[]> {
  const rows = await db
    .select()
    .from(schema.files)
    .where(eq(schema.files.projectId, projectId))
    .orderBy(asc(schema.files.path));
  return rows.map(toEntry);
}

function toEntry(r: FileRow): FileEntry {
  return { id: r.id, path: r.path, kind: r.kind as FileEntry['kind'], size: r.size, updatedAt: r.updatedAt.toISOString() };
}

export async function findFile(projectId: string, path: string): Promise<FileRow | null> {
  const rows = await db
    .select()
    .from(schema.files)
    .where(and(eq(schema.files.projectId, projectId), eq(schema.files.path, path)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getFileById(projectId: string, fileId: string): Promise<FileRow> {
  const rows = await db
    .select()
    .from(schema.files)
    .where(and(eq(schema.files.projectId, projectId), eq(schema.files.id, fileId)))
    .limit(1);
  if (!rows[0]) throw notFound('File not found');
  return rows[0];
}

function filesChanged(projectId: string) {
  publishProjectEvent(projectId, { type: 'files_changed' });
  void db.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
}

export async function createTextFile(projectId: string, rawPath: string, content = ''): Promise<FileEntry> {
  const path = normalizeProjectPath(rawPath);
  if (Buffer.byteLength(content) > config.limits.maxTextFileBytes) throw badRequest('File too large');
  if (await findFile(projectId, path)) throw conflict(`File already exists: ${path}`);
  await assertNoDirConflict(projectId, path);
  await assertProjectSpace(projectId, Buffer.byteLength(content));
  const row = await db.transaction(async (tx) => {
    const [f] = await tx
      .insert(schema.files)
      .values({ projectId, path, kind: 'text', size: Buffer.byteLength(content) })
      .returning();
    await tx.insert(schema.docStates).values({ fileId: f.id, state: encodeInitialState(content) });
    return f;
  });
  filesChanged(projectId);
  return toEntry(row);
}

export async function upsertBinaryFile(projectId: string, rawPath: string, data: Buffer): Promise<FileEntry> {
  const path = normalizeProjectPath(rawPath);
  const existing = await findFile(projectId, path);
  if (existing && existing.kind === 'text') throw conflict(`A text file already exists at ${path}`);
  if (!existing) await assertNoDirConflict(projectId, path);
  await assertProjectSpace(projectId, data.length, existing?.size ?? 0);
  const blobKey = await blobStore.put(data);
  let row: FileRow;
  if (existing) {
    [row] = await db
      .update(schema.files)
      .set({ blobKey, size: data.length, updatedAt: new Date() })
      .where(eq(schema.files.id, existing.id))
      .returning();
    // 旧 blob 保留：历史版本 / 检查点可能仍引用它（与 deleteFile 一致）
  } else {
    [row] = await db.insert(schema.files).values({ projectId, path, kind: 'binary', blobKey, size: data.length }).returning();
  }
  filesChanged(projectId);
  return toEntry(row);
}

/** 上传文件：按扩展名决定是文本（进入 Yjs）还是二进制 */
export async function uploadFile(projectId: string, rawPath: string, data: Buffer): Promise<FileEntry> {
  const path = normalizeProjectPath(rawPath);
  if (isTextPath(path) && data.length <= config.limits.maxTextFileBytes) {
    const text = data.toString('utf8');
    const existing = await findFile(projectId, path);
    if (existing?.kind === 'text') {
      await transactText(existing.id, 'upload', (y) => setWholeText(y, text));
      filesChanged(projectId);
      return toEntry({ ...existing, size: data.length, updatedAt: new Date() });
    }
    if (!existing) return createTextFile(projectId, path, text);
  }
  return upsertBinaryFile(projectId, path, data);
}

/** 防止 a/b.tex 与文件 a 同时存在，也防止文件占用已有文件夹（含空文件夹）的路径 */
async function assertNoDirConflict(projectId: string, path: string) {
  const all = await listFiles(projectId);
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (all.some((f) => f.path === dir)) throw conflict(`${dir} is a file, cannot be used as a folder`);
  }
  if (all.some((f) => f.path.startsWith(path + '/'))) throw conflict(`${path} is a folder`);
  if ((await listFolders(projectId)).some((d) => d === path || d.startsWith(path + '/'))) throw conflict(`${path} is a folder`);
}

// ---------------------------------------------------------------------------
// 文件夹：显式创建的（可为空，存于 folders 表）∪ 文件路径中隐含的
// ---------------------------------------------------------------------------

/** 文件夹路径：与文件路径相同的规则，允许末尾的 / */
export function normalizeFolderPath(raw: string): string {
  return normalizeProjectPath(String(raw ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, ''));
}

/** 显式创建的文件夹 */
export async function listFolders(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ path: schema.folders.path })
    .from(schema.folders)
    .where(eq(schema.folders.projectId, projectId))
    .orderBy(asc(schema.folders.path));
  return rows.map((r) => r.path);
}

/** 项目中所有文件夹（含空文件夹和文件路径隐含的上级目录） */
export async function allFolders(projectId: string, files?: FileEntry[]): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (p: string) => {
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'));
  };
  for (const d of await listFolders(projectId)) add(d);
  for (const f of files ?? (await listFiles(projectId))) if (f.path.includes('/')) add(f.path.replace(/\/[^/]*$/, ''));
  return out;
}

const underPath = (col: typeof schema.files.path | typeof schema.folders.path, dir: string) =>
  sql`starts_with(${col}, ${dir + '/'})`;

/** 新建文件夹（可为空）。已存在时不报错，返回 created=false */
export async function createFolder(projectId: string, rawPath: string): Promise<{ path: string; created: boolean }> {
  const path = normalizeFolderPath(rawPath);
  const files = await listFiles(projectId);
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    if (files.some((f) => f.path === p)) throw conflict(`${p} is a file, cannot be used as a folder`);
  }
  if ((await allFolders(projectId, files)).has(path)) return { path, created: false };
  await db.insert(schema.folders).values({ projectId, path }).onConflictDoNothing();
  filesChanged(projectId);
  return { path, created: true };
}

/** 重命名 / 移动文件夹及其中的全部内容。返回被移动的文件 */
export async function renameFolder(projectId: string, rawFrom: string, rawTo: string): Promise<{ from: string; to: string }[]> {
  const from = normalizeFolderPath(rawFrom);
  const to = normalizeFolderPath(rawTo);
  if (from === to) return [];
  if (to.startsWith(from + '/')) throw badRequest(`Cannot move ${from} into itself`);
  const files = await listFiles(projectId);
  const folders = await allFolders(projectId, files);
  if (!folders.has(from)) throw notFound(`Folder not found: ${from}`);
  if (folders.has(to) || files.some((f) => f.path === to || f.path.startsWith(to + '/'))) throw conflict(`${to} already exists`);
  const toParts = to.split('/');
  for (let i = 1; i < toParts.length; i++) {
    const p = toParts.slice(0, i).join('/');
    if (files.some((f) => f.path === p)) throw conflict(`${p} is a file, cannot be used as a folder`);
  }
  const moved = files.filter((f) => f.path.startsWith(from + '/')).map((f) => ({ from: f.path, to: to + f.path.slice(from.length) }));
  const cut = from.length + 1;
  await db.transaction(async (tx) => {
    await tx
      .update(schema.files)
      .set({ path: sql`${to} || substr(${schema.files.path}, ${cut})`, updatedAt: new Date() })
      .where(and(eq(schema.files.projectId, projectId), underPath(schema.files.path, from)));
    await tx
      .update(schema.folders)
      .set({ path: sql`${to} || substr(${schema.folders.path}, ${cut})` })
      .where(and(eq(schema.folders.projectId, projectId), sql`(${schema.folders.path} = ${from} or ${underPath(schema.folders.path, from)})`));
    const [p] = await tx.select({ mainFile: schema.projects.mainFile }).from(schema.projects).where(eq(schema.projects.id, projectId));
    const main = moved.find((m) => m.from === p?.mainFile);
    if (main) await tx.update(schema.projects).set({ mainFile: main.to }).where(eq(schema.projects.id, projectId));
  });
  filesChanged(projectId);
  return moved;
}

/** 删除文件夹及其中的全部文件。返回被删除的文件路径 */
export async function deleteFolder(projectId: string, rawPath: string): Promise<string[]> {
  const path = normalizeFolderPath(rawPath);
  const files = await listFiles(projectId);
  if (!(await allFolders(projectId, files)).has(path)) throw notFound(`Folder not found: ${path}`);
  const inside = files.filter((f) => f.path.startsWith(path + '/'));
  await db.transaction(async (tx) => {
    await tx.delete(schema.files).where(and(eq(schema.files.projectId, projectId), underPath(schema.files.path, path)));
    await tx
      .delete(schema.folders)
      .where(and(eq(schema.folders.projectId, projectId), sql`(${schema.folders.path} = ${path} or ${underPath(schema.folders.path, path)})`));
  });
  for (const f of inside) if (f.kind === 'text') await evictDocument(f.id);
  // 二进制 blob 保留：检查点/历史版本可能仍引用它（与 deleteFile 一致）
  await repairMainFile(projectId, inside.map((f) => f.path));
  filesChanged(projectId);
  return inside.map((f) => f.path);
}

export async function readTextFile(projectId: string, rawPath: string): Promise<{ file: FileRow; content: string }> {
  const path = normalizeProjectPath(rawPath);
  const file = await findFile(projectId, path);
  if (!file) throw notFound(`File not found: ${path}`);
  if (file.kind !== 'text') throw badRequest(`${path} is a binary file`);
  return { file, content: await readText(file.id) };
}

/** 主文件被删掉后改指向剩下的 main.tex 或第一个 .tex 文件，避免主文件设置指向不存在的文件（编译、复制项目都会失败） */
async function repairMainFile(projectId: string, deleted: string[]) {
  const [p] = await db.select({ mainFile: schema.projects.mainFile }).from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!p || !deleted.includes(p.mainFile)) return;
  const tex = (await listFiles(projectId)).filter((f) => f.kind === 'text' && f.path.endsWith('.tex')).map((f) => f.path);
  const next = tex.find((t) => t === 'main.tex') ?? tex.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  if (next) await db.update(schema.projects).set({ mainFile: next }).where(eq(schema.projects.id, projectId));
}

export async function deleteFile(projectId: string, rawPath: string) {
  const path = normalizeProjectPath(rawPath);
  const file = await findFile(projectId, path);
  if (!file) throw notFound(`File not found: ${path}`);
  await db.delete(schema.files).where(eq(schema.files.id, file.id));
  if (file.kind === 'text') await evictDocument(file.id);
  // 二进制 blob 保留：检查点/历史版本可能仍引用它（由后台 GC 清理）
  await repairMainFile(projectId, [path]);
  filesChanged(projectId);
}

export async function renameFile(projectId: string, rawFrom: string, rawTo: string) {
  const from = normalizeProjectPath(rawFrom);
  const to = normalizeProjectPath(rawTo);
  if (from === to) return;
  const file = await findFile(projectId, from);
  if (!file) throw notFound(`File not found: ${from}`);
  if (await findFile(projectId, to)) throw conflict(`File already exists: ${to}`);
  await assertNoDirConflict(projectId, to);
  await db.update(schema.files).set({ path: to, updatedAt: new Date() }).where(eq(schema.files.id, file.id));
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  if (p?.mainFile === from) await db.update(schema.projects).set({ mainFile: to }).where(eq(schema.projects.id, projectId));
  filesChanged(projectId);
}

// ---------------------------------------------------------------------------
// 快照：编译物化、Agent 检查点都基于它
// ---------------------------------------------------------------------------

export async function snapshotProject(projectId: string): Promise<SnapshotFile[]> {
  const rows = await db.select().from(schema.files).where(eq(schema.files.projectId, projectId)).orderBy(asc(schema.files.path));
  return Promise.all(
    rows.map(async (r) =>
      r.kind === 'text'
        ? { path: r.path, kind: 'text' as const, content: await readText(r.id), size: r.size }
        : { path: r.path, kind: 'binary' as const, blobKey: r.blobKey, size: r.size },
    ),
  );
}
