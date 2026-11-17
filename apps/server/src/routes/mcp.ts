import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { badRequest, forbidden } from '../lib/http.js';
import { userStatus } from '../lib/userStatus.js';
import { buildMcpServer } from '../mcp/server.js';
import { localAgentStatus, setupLocalAgents } from '../mcp/localSetup.js';
import { authenticateToken, createToken, listTokens, revokeToken } from '../mcp/tokens.js';
import { wwwAuthenticate } from '../oauth/service.js';
import { requireRole } from '../projects/service.js';
import { currentUser } from './auth.js';

export async function mcpRoutes(app: FastifyInstance) {
  // 部分客户端会用非标准的 Content-Type 发送 JSON-RPC：在本插件范围内兜底按 JSON 解析，避免 415
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch {
      done(null, body);
    }
  });
  // 记录 /mcp 的 4xx 请求特征，便于排查不同客户端的兼容问题
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/mcp') && reply.statusCode >= 400 && reply.statusCode !== 401) {
      req.log.warn({ status: reply.statusCode, contentType: req.headers['content-type'], accept: req.headers.accept, ua: req.headers['user-agent'] }, 'mcp request rejected');
    }
  });

  // ---------------- MCP（Streamable HTTP，无状态模式） ----------------
  app.post('/mcp', async (req, reply) => {
    const auth = await authenticateToken(req.headers.authorization);
    if (!auth) {
      // 按 MCP 授权规范返回资源元数据地址，ChatGPT / Claude.ai 据此发起 OAuth
      return reply
        .status(401)
        .header('WWW-Authenticate', wwwAuthenticate(req.headers.authorization ? 'invalid_token' : undefined))
        .send({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or missing TeXdraft access token' }, id: null });
    }
    const server = buildMcpServer(auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // 无状态模式不提供服务器推送流 / 会话
  const notAllowed = async (_req: unknown, reply: { status: (n: number) => { header: (k: string, v: string) => { send: (b: unknown) => unknown } } }) =>
    reply.status(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  // ---------------- 访问令牌 ----------------
  app.get('/api/tokens', async (req) => listTokens(currentUser(req)));

  app.post('/api/tokens', async (req) => {
    const uid = currentUser(req);
    const body = z.object({ name: z.string().max(80).default(''), projectId: z.string().uuid().nullable().optional() }).safeParse(req.body);
    if (!body.success) throw badRequest('Invalid token request');
    if (body.data.projectId) await requireRole(body.data.projectId, uid, 'viewer');
    return createToken(uid, body.data.name, body.data.projectId ?? null);
  });

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    await revokeToken(currentUser(req), req.params.id);
    return { ok: true };
  });

  /** 一键配置本机 Agent（ALLOW_LOCAL_AGENT_SETUP=true 时可用） */
  // 会写入服务器用户的 CLI 配置，仅管理员可用；普通用户看到的是未开启
  app.get('/api/agent-setup/local', async (req) => {
    const uid = currentUser(req);
    if (!(await userStatus(uid)).isAdmin) return { enabled: false, url: '', agents: [] };
    return localAgentStatus();
  });
  app.post('/api/agent-setup/local', async (req) => {
    const uid = currentUser(req);
    if (!(await userStatus(uid)).isAdmin) throw forbidden('Only administrators can configure local agents');
    return setupLocalAgents(uid);
  });

  /** 前端展示连接命令用：MCP 地址（PUBLIC_URL 可配置为 Agent 能访问到的地址） */
  app.get('/api/mcp/info', async (req) => {
    currentUser(req);
    return { url: `${config.publicUrl.replace(/\/$/, '')}/mcp` };
  });
}
