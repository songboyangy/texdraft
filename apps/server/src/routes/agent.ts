import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { revertRun } from '../agent/checkpoint.js';
import { listThreads, threadItems } from '../agent/history.js';
import { availableCliBackends, isBridgeBackend, runCliAgent, type ChatCliBackend, type CliBackend } from '../agent/cli.js';
import { bridgeAgents, listBridges } from '../bridge/hub.js';
import { getActiveRunForThread, resolveThread, runAgent, stopRun } from '../agent/runner.js';
import { badRequest, forbidden } from '../lib/http.js';
import { userStatus } from '../lib/userStatus.js';
import { requireRole } from '../projects/service.js';
import { currentUser, prefersZh } from './auth.js';
import { openSse } from './sse.js';

const ChatBody = z.object({
  lang: z.enum(['zh-CN', 'en']).optional(),
  backend: z.enum(['builtin', 'claude', 'codex', 'bridge-claude', 'bridge-codex']).default('builtin'),
  threadId: z.string().uuid().optional(),
  message: z.string().min(1).max(20000),
  context: z
    .object({
      activePath: z.string().max(300).optional(),
      cursorLine: z.number().int().optional(),
      selection: z.string().max(50000).optional(),
    })
    .default({}),
});

export async function agentRoutes(app: FastifyInstance) {
  /** 聊天可用的后端（本机 CLI 需服务端开启 ALLOW_LOCAL_AGENT_SETUP，且仅管理员可用） */
  app.get('/api/agent/backends', async (req) => {
    const uid = currentUser(req);
    return {
      backends: ['builtin', ...availableCliBackends((await userStatus(uid)).isAdmin), ...bridgeAgents(uid).map((a) => `bridge-${a}`)],
      bridges: listBridges(uid),
    };
  });

  /** 当前用户在线的本地桥接（自己电脑上的 texdraft-bridge） */
  app.get('/api/agent/bridges', async (req) => ({ bridges: listBridges(currentUser(req)) }));

  app.get<{ Params: { id: string } }>('/api/projects/:id/agent/threads', async (req) => {
    const uid = currentUser(req);
    await requireRole(req.params.id, uid, 'editor');
    return listThreads(req.params.id, uid);
  });

  app.get<{ Params: { id: string; threadId: string } }>('/api/projects/:id/agent/threads/:threadId', async (req) => {
    const uid = currentUser(req);
    await requireRole(req.params.id, uid, 'editor');
    return {
      items: await threadItems(req.params.id, uid, req.params.threadId),
      runningRunId: getActiveRunForThread(req.params.threadId),
    };
  });

  /** 发送消息并以 SSE 流式返回 Agent 事件 */
  app.post<{ Params: { id: string } }>('/api/projects/:id/agent/chat', async (req, reply) => {
    const uid = currentUser(req);
    await requireRole(req.params.id, uid, 'editor');
    const body = ChatBody.safeParse(req.body);
    if (!body.success) throw badRequest('Invalid chat request');
    const backend = body.data.backend;
    const cli = availableCliBackends((await userStatus(uid)).isAdmin);
    // 桥接后端用的是用户自己的电脑与订阅，任何人都可以用；电脑不在线时由运行过程给出提示
    const allowed = (b: string) => b === 'builtin' || isBridgeBackend(b) || cli.includes(b as CliBackend);
    if (!allowed(backend)) throw forbidden(`${backend} is not available for this account`);
    const thread = await resolveThread(req.params.id, uid, body.data.threadId, body.data.message, backend);
    const threadId = thread.id;
    // 已有对话沿用创建时的后端：再检查一次（例如管理员权限已被撤销）
    if (!allowed(thread.backend)) throw forbidden(`${thread.backend} is not available for this account`);
    if (getActiveRunForThread(threadId)) throw badRequest(prefersZh(req) ? '该对话正在运行中' : 'This conversation is already running');

    const sse = openSse(reply);
    // 浏览器断开不会中止运行：Agent 继续在服务端完成，重新打开对话即可看到结果
    const runInput = {
      projectId: req.params.id,
      userId: uid,
      threadId,
      lang: body.data.lang,
      message: body.data.message,
      context: body.data.context,
      emit: (e: Parameters<typeof sse.send>[0]) => sse.send(e),
    };
    // 已有对话沿用创建时的后端
    await (thread.backend === 'builtin' ? runAgent(runInput) : runCliAgent({ ...runInput, backend: thread.backend as ChatCliBackend })).catch((err) => sse.send({ type: 'run_finished', runId: '', status: 'error', changes: [], error: String(err?.message ?? err) }));
    sse.end();
  });

  app.post<{ Params: { id: string; runId: string } }>('/api/projects/:id/agent/runs/:runId/stop', async (req) => {
    const uid = currentUser(req);
    await requireRole(req.params.id, uid, 'editor');
    return { stopped: stopRun(req.params.runId, uid) };
  });

  app.post<{ Params: { id: string; runId: string } }>('/api/projects/:id/agent/runs/:runId/revert', async (req) => {
    const uid = currentUser(req);
    await requireRole(req.params.id, uid, 'editor');
    await revertRun(req.params.id, req.params.runId);
    return { ok: true };
  });
}
