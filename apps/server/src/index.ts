import fs from 'node:fs';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { hocuspocus } from './collab/hocuspocus.js';
import { flushAllEditLogs } from './collab/editLog.js';
import { handleBridgeSocket } from './bridge/hub.js';
import { config } from './config.js';
import { db, schema, sqlClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { warmupTectonic } from './compile/warmup.js';
import { describeSandbox, prepareUidSandboxDirs, sandboxKind } from './compile/sandbox.js';
import { INTERRUPTED_RUN_ERROR, pruneEmptyCheckpoints } from './agent/checkpoint.js';
import { userIdFromCookieHeader } from './lib/auth.js';
import { HttpError } from './lib/http.js';
import { PathError } from './lib/paths.js';
import { agentRoutes } from './routes/agent.js';
import { featureRoutes } from './routes/features.js';
import { mcpRoutes } from './routes/mcp.js';
import { authRoutes, installSessionHook } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { oauthRoutes } from './routes/oauth.js';
import { aiRoutes } from './routes/ai.js';
import { loadPlugins } from './plugins.js';
import { quotaProviderName } from './ai/quota.js';

await runMigrations();
// 进程重启后，遗留的“运行中”状态都已失效
await db.update(schema.compileJobs).set({ status: 'error' }).where(eq(schema.compileJobs.status, 'running'));
await db
  .update(schema.agentRuns)
  .set({ status: 'error', error: INTERRUPTED_RUN_ERROR, finishedAt: new Date() })
  .where(eq(schema.agentRuns.status, 'running'));
// 清理没有改动任何文件的 AI 运行留下的检查点
// 编译沙箱状态：未隔离时明确告警
{
  const sb = describeSandbox();
  console[sb.enabled ? 'log' : 'warn'](`[compile] ${sb.message}`);
  if (sb.enabled && (() => { try { return sandboxKind() === 'uid'; } catch { return false; } })()) await prepareUidSandboxDirs();
}
const pruned = await pruneEmptyCheckpoints();
if (pruned) console.log(`[versions] removed ${pruned} empty AI checkpoints`);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 10 * 1024 * 1024,
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: config.limits.maxUploadBytes, files: 50 } });
await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
  if (err instanceof PathError) return reply.status(400).send({ error: err.message });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
  app.log.error(err);
  return reply.status(500).send({ error: 'Internal server error' });
});

// 允许 POST 不带 body（如触发编译）
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try {
    done(null, body === '' ? {} : JSON.parse(body as string));
  } catch {
    done(new HttpError(400, 'Invalid JSON body'), undefined);
  }
});

// Body-less POST/DELETE (logout, delete, stop/undo an AI run) reach us through Cloudflare Tunnel as an empty
// chunked body with no Content-Type, which Fastify rejects with 415. Accept empty bodies; anything with content still needs a type.
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
  if ((body as Buffer).length === 0) return done(null, {});
  done(new HttpError(415, 'Unsupported Media Type'), undefined);
});

// OAuth 令牌端点与授权表单使用 application/x-www-form-urlencoded
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => {
  done(null, Object.fromEntries(new URLSearchParams(body as string)));
});

// 换域名：旧主机名上的请求永久跳转到 PUBLIC_URL（GET/HEAD 用 301，其余用 308 以保留方法与请求体）
if (config.redirectHosts.length) {
  const target = config.publicUrl.replace(/\/+$/, '');
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    if (!config.redirectHosts.includes(host)) return;
    return reply.redirect(target + req.url, req.method === 'GET' || req.method === 'HEAD' ? 301 : 308);
  });
}
installSessionHook(app);
await app.register(authRoutes);
await app.register(projectRoutes);
await app.register(agentRoutes);
await app.register(featureRoutes);
await app.register(mcpRoutes);
await app.register(oauthRoutes);
await app.register(aiRoutes);

app.get('/api/health', async () => ({ ok: true }));

// ---------------- 本地桥接（用户电脑上的 texdraft-bridge 主动连入） ----------------
// 放在 /mcp 下：经 Cloudflare Access 等代理时与 MCP 共用同一条放行规则
app.get('/mcp/bridge', { websocket: true }, (socket) => handleBridgeSocket(socket));
/** 桥接程序本身（单文件、无依赖，Node 22+）：curl -fsSL <站点>/mcp/bridge.mjs -o texdraft-bridge.mjs（同样放在 /mcp 下） */
app.get('/mcp/bridge.mjs', async (_req, reply) => {
  reply.header('cache-control', 'no-cache').type('text/javascript; charset=utf-8');
  return reply.send(await fs.promises.readFile(new URL('./bridge/texdraft-bridge.mjs', import.meta.url), 'utf8'));
});

// ---------------- 实时协作（Yjs over WebSocket，Hocuspocus 协议） ----------------
app.get('/collab', { websocket: true }, (socket, req) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { headers });
  const conn = hocuspocus.handleConnection(socket, request);
  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    conn.handleMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  });
  socket.on('close', (code: number, reason: Buffer) => {
    conn.handleClose({ code, reason: reason.toString() } as CloseEvent);
  });
  socket.on('pong', () => conn.touch());
});

// 服务端插件（TEXDRAFT_PLUGINS）：在内置路由之后、前端兜底路由之前注册
await loadPlugins(app);
if (quotaProviderName() !== 'builtin') app.log.info(`[ai] quota provider: ${quotaProviderName()}`);

// 生产环境：同时托管前端构建产物
if (process.env.SERVE_WEB === '1') {
  const { default: fastifyStatic } = await import('@fastify/static');
  const path = await import('node:path');
  const webRoot = path.resolve(import.meta.dirname, '../../web/dist');
  await app.register(fastifyStatic, { root: webRoot });
  // Product page at / for signed-out visitors (LANDING_PAGE, on by default with PUBLIC_DEMO); signed-in users get the app
  if (config.demo.landingPage && fs.existsSync(path.join(webRoot, 'landing/index.html'))) {
    app.log.info('[web] product page at / for signed-out visitors');
    app.get('/', async (req, reply) => {
      const signedIn = (await userIdFromCookieHeader(req.headers.cookie)) !== null;
      reply.header('cache-control', 'no-cache').header('vary', 'Cookie');
      return reply.sendFile(signedIn ? 'index.html' : 'landing/index.html', { cacheControl: false });
    });
  }
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api') ? reply.status(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
  );
}

const shutdown = async () => {
  app.log.info('shutting down');
  hocuspocus.flushPendingStores();
  flushAllEditLogs();
  await new Promise((r) => setTimeout(r, 500));
  await app.close();
  await sqlClient.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: process.env.HOST ?? '127.0.0.1' });

// 后台预下载常用宏包与字体（仅 tectonic），不阻塞服务启动
void warmupTectonic().catch((e) => console.error('[compile] warmup error', e));
