import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describeLlmError, streamText } from '../agent/llm.js';
import { recordUsage } from '../ai/quota.js';
import { resolveModel } from '../ai/settings.js';
import { userStatus } from '../lib/userStatus.js';
import { buildTransformPrompt, cleanTransformOutput } from '../agent/transform.js';
import { badRequest } from '../lib/http.js';
import { addBibliographyToMain, addCitation, searchOnline } from '../projects/citations.js';
import { requireRole } from '../projects/service.js';
import { createVersion, diffVersion, listVersions, restoreVersion, versionFileContent } from '../projects/versions.js';
import { currentUser } from './auth.js';
import { openSse } from './sse.js';

type P = { id: string };

const TransformBody = z.object({
  action: z.enum(['polish', 'translate', 'shorten', 'expand', 'grammar', 'explain', 'custom']),
  text: z.string().min(1).max(20000),
  instruction: z.string().max(2000).optional(),
  before: z.string().max(5000).optional(),
  after: z.string().max(5000).optional(),
  lang: z.enum(['zh-CN', 'en']).default('zh-CN'),
});

const CitationBody = z.object({
  source: z.enum(['crossref', 'arxiv', 'openalex']),
  id: z.string().min(3).max(300),
  title: z.string().max(1000),
  authors: z.array(z.string().max(300)).max(500),
  year: z.number().int().optional(),
  venue: z.string().max(500).optional(),
  doi: z.string().max(300).optional(),
  category: z.string().max(50).optional(),
  type: z.string().max(50).optional(),
  url: z.string().max(500).optional(),
  arxivId: z.string().max(50).optional(),
  citedBy: z.number().int().nonnegative().optional(),
});

export async function featureRoutes(app: FastifyInstance) {
  // ---------------- 选中文字 AI（流式） ----------------
  app.post<{ Params: P }>('/api/projects/:id/ai/transform', async (req, reply) => {
    const uid = currentUser(req);
    await requireRole(req.params.id, uid, 'editor');
    const body = TransformBody.safeParse(req.body);
    if (!body.success) throw badRequest('Invalid request');
    const zh = body.data.lang !== 'en';
    const { cfg, source } = await resolveModel(uid, (await userStatus(uid)).isAdmin, zh);
    const { system, user } = buildTransformPrompt(body.data);
    const sse = openSse(reply);
    const abort = new AbortController();
    sse.onClose(() => abort.abort());
    try {
      const out = await streamText({
        system,
        user,
        maxTokens: body.data.action === 'expand' ? 6000 : 4096,
        signal: abort.signal,
        model: cfg,
        onUsage: (u) => void recordUsage(uid, source, u).catch(() => {}),
        onDelta: (text) => sse.send({ type: 'delta', text }),
      });
      sse.send({ type: 'done', text: body.data.action === 'explain' ? out.trim() : cleanTransformOutput(out) });
    } catch (err) {
      if (!abort.signal.aborted) sse.send({ type: 'error', message: describeLlmError(err, zh, cfg) });
    }
    sse.end();
  });

  // ---------------- 文献 ----------------
  app.get<{ Params: P; Querystring: { q: string } }>('/api/projects/:id/citations/search', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    return searchOnline(String(req.query.q ?? ''));
  });

  app.post<{ Params: P }>('/api/projects/:id/citations', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    const body = CitationBody.safeParse(req.body);
    if (!body.success) throw badRequest('Invalid citation');
    return addCitation(req.params.id, body.data);
  });

  app.post<{ Params: P }>('/api/projects/:id/citations/bibliography', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'editor');
    return addBibliographyToMain(req.params.id);
  });

  // ---------------- 历史版本 ----------------
  app.get<{ Params: P }>('/api/projects/:id/versions', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    return listVersions(req.params.id);
  });

  app.post<{ Params: P; Body: { label?: string } }>('/api/projects/:id/versions', async (req) => {
    const uid = currentUser(req);
    await requireRole(req.params.id, uid, 'editor');
    const label = String(req.body?.label ?? '').trim() || null;
    const v = await createVersion(req.params.id, uid, 'manual', label);
    return { id: v.id };
  });

  app.get<{ Params: P & { vid: string } }>('/api/projects/:id/versions/:vid/diff', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    return diffVersion(req.params.id, req.params.vid);
  });

  app.get<{ Params: P & { vid: string }; Querystring: { path: string } }>('/api/projects/:id/versions/:vid/file', async (req) => {
    await requireRole(req.params.id, currentUser(req), 'viewer');
    const f = await versionFileContent(req.params.id, req.params.vid, String(req.query.path ?? ''));
    return { path: f.path, kind: f.kind, content: f.kind === 'text' ? f.content ?? '' : null };
  });

  app.post<{ Params: P & { vid: string }; Body: { paths?: string[]; label?: string } }>('/api/projects/:id/versions/:vid/restore', async (req) => {
    const uid = currentUser(req);
    await requireRole(req.params.id, uid, 'editor');
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.map(String) : undefined;
    return restoreVersion(req.params.id, uid, req.params.vid, paths, req.body?.label ? String(req.body.label).slice(0, 200) : undefined);
  });
}
