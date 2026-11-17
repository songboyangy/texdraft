import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { readText } from '../collab/hocuspocus.js';
import { addEditHint } from '../collab/editLog.js';
import { checkCompileRate, compileProject, getCompileJob, latestCompile } from '../compile/service.js';
import { db, schema } from '../db/client.js';
import { blobStore } from '../lib/blobStore.js';
import { subscribeProjectEvents } from '../lib/events.js';
import { badRequest, notFound } from '../lib/http.js';
import {
  assertCanCreateProject, createProject, createTextFile, deleteFile, deleteProject, getFileById, getProject, listFiles, listProjects,
  renameFile, requireRole, updateProject, uploadFile,
  createFolder, deleteFolder, listFolders, renameFolder,
} from '../projects/service.js';
import { cachedIndex, forwardSearch, parseSynctex, reverseSearch } from '../compile/synctex.js';
import { projectTexts, replaceInProject, searchProject } from '../projects/search.js';
import { projectSymbols } from '../projects/symbols.js';
import { createTag, deleteTag, listTags, renameTag, setProjectTag } from '../projects/tags.js';
import { exportProjectZip, importProjectZip } from '../projects/zip.js';
import { SAMPLE_NAME, createSampleProject } from '../projects/sample.js';
import { currentUser, prefersZh } from './auth.js';
import { openSse } from './sse.js';

type P = { id: string };
type PF = { id: string; fileId: string };

export async function projectRoutes(app: FastifyInstance) {
  // ---------------- 项目 ----------------
  app.get('/api/projects', async (req) => listProjects(currentUser(req)));

  app.post<{ Body: { name?: string } }>('/api/projects', async (req) => {
    return createProject(currentUser(req), String(req.body?.name ?? ''));
  });

  app.get<{ Params: P }>('/api/projects/:id', async (req) => getProject(req.params.id, currentUser(req)));

  /** 打开示例项目：已有就返回，没有就创建一份（中文短文 + 公式 + 参考文献） */
  app.post('/api/projects/sample', async (req) => {
    const uid = currentUser(req);
    const existing = (await listProjects(uid)).find((p) => p.role === 'owner' && p.name === SAMPLE_NAME);
    if (existing) return existing;
    await assertCanCreateProject(uid);
    return createSampleProject(uid);
  });

  /** 上传 zip 导入为新项目（字段：file，可选 name） */
  app.post('/api/projects/import', async (req) => {
    const uid = currentUser(req);
    let name = '';
    let data: Buffer | null = null;
    let filename = '';
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'name') name = String(part.value ?? '');
      if (part.type === 'file') {
        filename = part.filename;
        data = await part.toBuffer();
      }
    }
    const zh = prefersZh(req);
    if (!data) throw badRequest(zh ? '请上传 zip 文件' : 'Upload a zip file');
    return importProjectZip(uid, name || filename.replace(/\.zip$/i, ''), data, zh);
  });

  app.get<{ Params: P }>('/api/projects/:id/download', async (req, reply) => {
    const project = await getProject(req.params.id, currentUser(req));
    const zip = await exportProjectZip(req.params.id);
    const name = encodeURIComponent(`${project.name}.zip`);
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${name}`);
    return reply.type('application/zip').send(Buffer.from(zip));
  });

  app.get<{ Params: P }>('/api/projects/:id/symbols', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    return projectSymbols(req.params.id);
  });

  app.patch<{ Params: P; Body: { name?: string; mainFile?: string; engine?: string } }>('/api/projects/:id', async (req) => {
    await updateProject(req.params.id, currentUser(req), req.body ?? {});
    return getProject(req.params.id, currentUser(req));
  });

  app.delete<{ Params: P }>('/api/projects/:id', async (req) => {
    await deleteProject(req.params.id, currentUser(req));
    return { ok: true };
  });

  // ---------------- 成员 ----------------
  app.get<{ Params: P }>('/api/projects/:id/members', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    return db
      .select({ userId: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.projectMembers.userId))
      .where(eq(schema.projectMembers.projectId, req.params.id));
  });

  app.post<{ Params: P; Body: { email: string; role: string } }>('/api/projects/:id/members', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'owner');
    const body = z.object({ email: z.string(), role: z.enum(['editor', 'viewer']) }).safeParse(req.body);
    if (!body.success) throw badRequest(prefersZh(req) ? '需要 email 与 role（editor/viewer）' : 'email and role (editor/viewer) are required');
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, body.data.email.toLowerCase()));
    if (!u) throw notFound(prefersZh(req) ? '该邮箱尚未注册' : 'No account uses this email yet');
    await db
      .insert(schema.projectMembers)
      .values({ projectId: req.params.id, userId: u.id, role: body.data.role })
      .onConflictDoUpdate({
        target: [schema.projectMembers.projectId, schema.projectMembers.userId],
        set: { role: body.data.role },
        // 不允许把 owner 降级
        setWhere: sql`${schema.projectMembers.role} <> 'owner'`,
      });
    return { ok: true };
  });

  /**
   * 编辑记录（元数据：谁 / 何时 / 来源 / 改了多少 / 哪几行），用于排查“这段内容是怎么没的”。
   * 可编辑成员可查看；可选 fileId 过滤，最多 500 条，新的在前。
   */
  app.get<{ Params: P; Querystring: { fileId?: string; limit?: string } }>('/api/projects/:id/edit-log', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const conds = [eq(schema.editLog.projectId, req.params.id)];
    if (req.query.fileId) conds.push(eq(schema.editLog.fileId, req.query.fileId));
    const rows = await db
      .select({
        id: schema.editLog.id,
        fileId: schema.editLog.fileId,
        path: schema.files.path,
        userId: schema.editLog.userId,
        userName: schema.users.name,
        source: schema.editLog.source,
        origin: schema.editLog.origin,
        insertedChars: schema.editLog.insertedChars,
        deletedChars: schema.editLog.deletedChars,
        insertedLines: schema.editLog.insertedLines,
        deletedLines: schema.editLog.deletedLines,
        fromLine: schema.editLog.fromLine,
        toLine: schema.editLog.toLine,
        startedAt: schema.editLog.startedAt,
        endedAt: schema.editLog.createdAt,
      })
      .from(schema.editLog)
      .leftJoin(schema.files, eq(schema.files.id, schema.editLog.fileId))
      .leftJoin(schema.users, eq(schema.users.id, schema.editLog.userId))
      .where(and(...conds))
      .orderBy(desc(schema.editLog.id))
      .limit(limit);
    return rows.map((r) => ({ ...r, startedAt: r.startedAt.toISOString(), endedAt: r.endedAt.toISOString() }));
  });

  /** 浏览器上报的编辑操作类型（删除跨行时），写进编辑记录，用于排查内容被误删 */
  app.post<{ Params: P; Body: { fileId?: string; event?: string } }>('/api/projects/:id/edit-log/hint', async (req) => {
    const uid = currentUser(req);
    await requireRole(req.params.id, uid, 'editor');
    const { fileId, event } = req.body ?? {};
    if (typeof fileId === 'string' && typeof event === 'string') addEditHint(fileId, uid, event);
    return { ok: true };
  });

  /** 移除协作者（所有者不能被移除） */
  app.delete<{ Params: P & { userId: string } }>('/api/projects/:id/members/:userId', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'owner');
    const removed = await db
      .delete(schema.projectMembers)
      .where(and(eq(schema.projectMembers.projectId, req.params.id), eq(schema.projectMembers.userId, req.params.userId), ne(schema.projectMembers.role, 'owner')))
      .returning({ userId: schema.projectMembers.userId });
    if (!removed.length) throw notFound('Member not found');
    return { ok: true };
  });

  // ---------------- 项目标签（每个用户自己的分类） ----------------
  type TP = { tagId: string };
  app.get('/api/tags', async (req) => listTags(currentUser(req)));
  app.post<{ Body: { name?: string } }>('/api/tags', async (req) => createTag(currentUser(req), String(req.body?.name ?? '')));
  app.patch<{ Params: TP; Body: { name?: string } }>('/api/tags/:tagId', async (req) => {
    await renameTag(currentUser(req), req.params.tagId, String(req.body?.name ?? ''));
    return { ok: true };
  });
  app.delete<{ Params: TP }>('/api/tags/:tagId', async (req) => {
    await deleteTag(currentUser(req), req.params.tagId);
    return { ok: true };
  });
  app.put<{ Params: TP & P }>('/api/tags/:tagId/projects/:id', async (req) => {
    await setProjectTag(currentUser(req), req.params.tagId, req.params.id, true);
    return { ok: true };
  });
  app.delete<{ Params: TP & P }>('/api/tags/:tagId/projects/:id', async (req) => {
    await setProjectTag(currentUser(req), req.params.tagId, req.params.id, false);
    return { ok: true };
  });

  // ---------------- 文件 ----------------
  app.get<{ Params: P }>('/api/projects/:id/files', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    return listFiles(req.params.id);
  });

  app.post<{ Params: P; Body: { path: string; content?: string } }>('/api/projects/:id/files', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    return createTextFile(req.params.id, String(req.body?.path ?? ''), req.body?.content ?? '');
  });

  app.post<{ Params: P }>('/api/projects/:id/upload', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    const results = [];
    let dir = '';
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'dir') dir = String(part.value ?? '').replace(/^\/+|\/+$/g, '');
      if (part.type === 'file') {
        const data = await part.toBuffer();
        const name = part.filename.split(/[\\/]/).pop() || 'file';
        results.push(await uploadFile(req.params.id, dir ? `${dir}/${name}` : name, data));
      }
    }
    return results;
  });

  app.get<{ Params: PF }>('/api/projects/:id/files/:fileId/raw', async (req, reply) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    const f = await getFileById(req.params.id, req.params.fileId);
    const name = encodeURIComponent(f.path.split('/').pop() || 'file');
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${name}`);
    if (f.kind === 'text') return reply.type('text/plain; charset=utf-8').send(await readText(f.id));
    if (!f.blobKey) throw notFound();
    return reply.type(guessMime(f.path)).send(await blobStore.get(f.blobKey));
  });

  app.patch<{ Params: PF; Body: { path: string } }>('/api/projects/:id/files/:fileId', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    const f = await getFileById(req.params.id, req.params.fileId);
    await renameFile(req.params.id, f.path, String(req.body?.path ?? ''));
    return { ok: true };
  });

  app.delete<{ Params: PF }>('/api/projects/:id/files/:fileId', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    const f = await getFileById(req.params.id, req.params.fileId);
    await deleteFile(req.params.id, f.path);
    return { ok: true };
  });

  // ---------------- 文件夹（显式创建的，可为空；文件路径中隐含的目录由前端从文件列表推出） ----------------
  app.get<{ Params: P }>('/api/projects/:id/folders', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    return listFolders(req.params.id);
  });

  app.post<{ Params: P; Body: { path: string } }>('/api/projects/:id/folders', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    return createFolder(req.params.id, String(req.body?.path ?? ''));
  });

  /** 重命名 / 移动文件夹（连同其中的文件） */
  app.patch<{ Params: P; Body: { from: string; to: string } }>('/api/projects/:id/folders', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    const moved = await renameFolder(req.params.id, String(req.body?.from ?? ''), String(req.body?.to ?? ''));
    return { ok: true, moved: moved.length };
  });

  /** 删除文件夹及其中的全部文件 */
  app.delete<{ Params: P; Querystring: { path?: string } }>('/api/projects/:id/folders', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    const deleted = await deleteFolder(req.params.id, String(req.query.path ?? ''));
    return { ok: true, deleted: deleted.length };
  });

  // ---------------- 编译 ----------------
  app.post<{ Params: P }>('/api/projects/:id/compile', async (req) => {
    const uid = currentUser(req);
    await requireRole(req.params.id, uid, 'viewer');
    await checkCompileRate(uid, prefersZh(req));
    return compileProject(req.params.id, uid);
  });

  app.get<{ Params: P }>('/api/projects/:id/compile/latest', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    return (await latestCompile(req.params.id)) ?? null;
  });

  app.get<{ Params: { id: string; jobId: string } }>('/api/projects/:id/compile/:jobId/pdf', async (req, reply) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    const job = await getCompileJob(req.params.id, req.params.jobId);
    if (!job?.pdfKey) throw notFound('PDF not found');
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.type('application/pdf').send(await blobStore.get(job.pdfKey));
  });

  app.get<{ Params: { id: string; jobId: string } }>('/api/projects/:id/compile/:jobId/log', async (req, reply) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    const job = await getCompileJob(req.params.id, req.params.jobId);
    if (!job?.logKey) throw notFound('Log not found');
    return reply.type('text/plain; charset=utf-8').send(await blobStore.get(job.logKey));
  });

  // ---------------- 全项目搜索 / 替换 / 文本 ----------------
  const SearchBody = z.object({
    query: z.string().min(1).max(500),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
  });

  app.post<{ Params: P }>('/api/projects/:id/search', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    const body = SearchBody.safeParse(req.body);
    if (!body.success) throw badRequest('Invalid search query');
    return searchProject(req.params.id, body.data);
  });

  app.post<{ Params: P }>('/api/projects/:id/replace', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    const body = SearchBody.extend({ replacement: z.string().max(5000), paths: z.array(z.string()).optional() }).safeParse(req.body);
    if (!body.success) throw badRequest('Invalid replace request');
    return replaceInProject(req.params.id, body.data);
  });

  app.get<{ Params: P }>('/api/projects/:id/texts', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    return projectTexts(req.params.id);
  });

  // ---------------- SyncTeX ----------------
  const synctexFor = async (projectId: string, jobId: string, zh: boolean) => {
    const job = await getCompileJob(projectId, jobId);
    if (!job?.synctexKey) throw notFound(zh ? '该次编译没有 SyncTeX 数据' : 'This compile has no SyncTeX data');
    const paths = (await listFiles(projectId)).map((f) => f.path);
    const gz = await blobStore.get(job.synctexKey);
    return cachedIndex(jobId, () => parseSynctex(gz, paths));
  };

  app.get<{ Params: { id: string; jobId: string }; Querystring: { file: string; line: string } }>(
    '/api/projects/:id/compile/:jobId/synctex/pdf',
    async (req) => {
      await requireRole(req.params.id, currentUser(req), 'viewer');
      const zh = prefersZh(req);
      const r = forwardSearch(await synctexFor(req.params.id, req.params.jobId, zh), req.query.file, Number(req.query.line));
      if (!r) throw notFound(zh ? '在 PDF 中找不到该位置' : 'This position was not found in the PDF');
      return r;
    },
  );

  app.get<{ Params: { id: string; jobId: string }; Querystring: { page: string; x: string; y: string } }>(
    '/api/projects/:id/compile/:jobId/synctex/source',
    async (req) => {
      await requireRole(req.params.id, currentUser(req), 'viewer');
      const q = req.query;
      const zh = prefersZh(req);
      const r = reverseSearch(await synctexFor(req.params.id, req.params.jobId, zh), Number(q.page), Number(q.x), Number(q.y));
      if (!r) throw notFound(zh ? '找不到对应的源码位置' : 'No matching source position');
      return r;
    },
  );

  // ---------------- 项目事件（文件树变化、编译结果） ----------------
  app.get<{ Params: P }>('/api/projects/:id/events', async (req, reply) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    const sse = openSse(reply);
    const unsubscribe = subscribeProjectEvents(req.params.id, (e) => sse.send(e));
    sse.onClose(unsubscribe);
  });
}

function guessMime(p: string) {
  const ext = p.split('.').pop()?.toLowerCase();
  return (
    {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', pdf: 'application/pdf',
      svg: 'image/svg+xml', eps: 'application/postscript', webp: 'image/webp',
    } as Record<string, string>
  )[ext ?? ''] ?? 'application/octet-stream';
}
