import type { VersionDiff, VersionKind, VersionSummary } from '@texdraft/shared';
import { createTwoFilesPatch } from 'diff';
import { and, desc, eq, sql } from 'drizzle-orm';
import { setWholeText, transactText } from '../collab/hocuspocus.js';
import { db, schema } from '../db/client.js';
import type { SnapshotFile } from '../db/schema.js';
import { publishProjectEvent } from '../lib/events.js';
import { notFound } from '../lib/http.js';
import { createTextFile, deleteFile, findFile, snapshotProject } from './service.js';

/**
 * 项目历史版本：
 *  - checkpoint：AI 运行前自动创建
 *  - manual：用户手动保存（可命名）
 *  - auto：编译时自动保存（项目有变化且距上次快照超过 AUTO_INTERVAL）
 *  - restore：恢复某个版本之前自动保存的当前状态（便于反悔）
 */

const AUTO_INTERVAL_MS = 10 * 60 * 1000;

export async function createVersion(projectId: string, userId: string | null, kind: VersionKind, label: string | null, files?: SnapshotFile[]) {
  const snap = files ?? (await snapshotProject(projectId));
  const [v] = await db
    .insert(schema.versions)
    .values({ projectId, kind, label: label?.slice(0, 200) ?? null, snapshot: { files: snap }, createdBy: userId })
    .returning({ id: schema.versions.id, createdAt: schema.versions.createdAt });
  return { id: v.id, files: snap };
}

export async function listVersions(projectId: string): Promise<VersionSummary[]> {
  const rows = await db
    .select({
      id: schema.versions.id,
      kind: schema.versions.kind,
      label: schema.versions.label,
      createdAt: schema.versions.createdAt,
      author: schema.users.name,
      fileCount: sql<number>`jsonb_array_length(${schema.versions.snapshot}->'files')`,
      // 对应 AI 运行的改动摘要（去掉 patch，避免列表过大）
      run: sql<VersionSummary['run']>`(
        SELECT jsonb_build_object(
          'status', r.status,
          'reverted', r.reverted = 1,
          'changes', COALESCE((SELECT jsonb_agg(c - 'patch') FROM jsonb_array_elements(r.changes) c), '[]'::jsonb))
        FROM agent_runs r WHERE r.checkpoint_id = ${schema.versions.id} LIMIT 1)`,
    })
    .from(schema.versions)
    .leftJoin(schema.users, eq(schema.users.id, schema.versions.createdBy))
    .where(eq(schema.versions.projectId, projectId))
    .orderBy(desc(schema.versions.createdAt))
    .limit(300);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as VersionKind,
    label: r.label,
    createdAt: r.createdAt.toISOString(),
    author: r.author ?? null,
    fileCount: Number(r.fileCount),
    run: r.run ?? null,
  }));
}

async function getVersion(projectId: string, versionId: string) {
  const [v] = await db
    .select()
    .from(schema.versions)
    .where(and(eq(schema.versions.id, versionId), eq(schema.versions.projectId, projectId)));
  if (!v) throw notFound('Version not found');
  return v;
}

const textOf = (f: SnapshotFile | undefined) => (f ? (f.kind === 'text' ? f.content ?? '' : '') : '');

/** 该版本 → 当前项目 的逐文件差异 */
export async function diffVersion(projectId: string, versionId: string): Promise<VersionDiff> {
  const v = await getVersion(projectId, versionId);
  const then = new Map(v.snapshot.files.map((f) => [f.path, f]));
  const now = new Map((await snapshotProject(projectId)).map((f) => [f.path, f]));
  const paths = [...new Set([...then.keys(), ...now.keys()])].sort();
  const files: VersionDiff['files'] = [];
  for (const path of paths) {
    const a = then.get(path);
    const b = now.get(path);
    const binary = (a ?? b)!.kind === 'binary';
    let status: VersionDiff['files'][number]['status'];
    if (!a) status = 'added';
    else if (!b) status = 'removed';
    else if (binary ? a.blobKey === b.blobKey : textOf(a) === textOf(b)) status = 'unchanged';
    else status = 'modified';
    if (status === 'unchanged') {
      files.push({ path, status, binary, additions: 0, deletions: 0, patch: '' });
      continue;
    }
    let patch = '';
    let additions = 0;
    let deletions = 0;
    if (!binary) {
      patch = createTwoFilesPatch(path, path, textOf(a), textOf(b), '', '', { context: 3 });
      for (const l of patch.split('\n').slice(4)) {
        if (l.startsWith('+')) additions++;
        else if (l.startsWith('-')) deletions++;
      }
      if (patch.length > 200_000) patch = patch.slice(0, 200_000) + '\n…';
    }
    files.push({ path, status, binary, additions, deletions, patch });
  }
  return { versionId, createdAt: v.createdAt.toISOString(), files };
}

export async function versionFileContent(projectId: string, versionId: string, path: string) {
  const v = await getVersion(projectId, versionId);
  const f = v.snapshot.files.find((x) => x.path === path);
  if (!f) throw notFound('File not in this version');
  return f;
}

/**
 * 把指定文件恢复为 baseline 中的状态（baseline 中不存在的文件会被删除）。
 * 文本文件通过 Yjs 事务写入，在线编辑者实时看到；二进制文件重新引用原 blob。
 */
export async function restoreFiles(projectId: string, baseline: Map<string, SnapshotFile>, paths: string[], origin: string) {
  let changed = 0;
  for (const path of paths) {
    const base = baseline.get(path);
    const cur = await findFile(projectId, path);
    if (!base) {
      if (cur) {
        await deleteFile(projectId, path);
        changed++;
      }
      continue;
    }
    if (base.kind === 'text') {
      if (cur?.kind === 'text') {
        await transactText(cur.id, origin, (y) => {
          if (y.toString() !== (base.content ?? '')) {
            setWholeText(y, base.content ?? '');
            changed++;
          }
        });
      } else {
        if (cur) await deleteFile(projectId, path);
        await createTextFile(projectId, path, base.content ?? '');
        changed++;
      }
    } else if (base.blobKey) {
      if (cur?.kind === 'binary' && cur.blobKey === base.blobKey) continue;
      if (cur) await deleteFile(projectId, path);
      await db.insert(schema.files).values({ projectId, path: base.path, kind: 'binary', blobKey: base.blobKey, size: base.size });
      publishProjectEvent(projectId, { type: 'files_changed' });
      changed++;
    }
  }
  return changed;
}

/** 恢复版本：先保存当前状态（kind=restore），再恢复全部或指定文件 */
export async function restoreVersion(projectId: string, userId: string, versionId: string, paths?: string[], label?: string) {
  const v = await getVersion(projectId, versionId);
  const current = await snapshotProject(projectId);
  const safety = await createVersion(projectId, userId, 'restore', label ?? null, current);
  const baseline = new Map(v.snapshot.files.map((f) => [f.path, f]));
  const targets = paths?.length ? paths : [...new Set([...baseline.keys(), ...current.map((f) => f.path)])];
  const changed = await restoreFiles(projectId, baseline, targets, `restore:${versionId}`);
  return { changed, safetyVersionId: safety.id };
}

/** 编译后调用：项目有变化且距上次快照足够久时自动保存一个版本 */
export async function maybeAutoSnapshot(projectId: string, userId: string | null) {
  const [last] = await db
    .select({ createdAt: schema.versions.createdAt, snapshot: schema.versions.snapshot })
    .from(schema.versions)
    .where(eq(schema.versions.projectId, projectId))
    .orderBy(desc(schema.versions.createdAt))
    .limit(1);
  if (last && Date.now() - last.createdAt.getTime() < AUTO_INTERVAL_MS) return null;
  const files = await snapshotProject(projectId);
  const key = (fs: SnapshotFile[]) => JSON.stringify(fs.map((f) => [f.path, f.kind === 'text' ? f.content : f.blobKey]));
  if (last && key(last.snapshot.files) === key(files)) return null;
  return createVersion(projectId, userId, 'auto', null, files);
}
