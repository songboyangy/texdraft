import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { SESSION_COOKIE, sessionCookieOptions, signSession } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { authenticatePassword } from './auth.js';
import {
  authorizationServerMetadata,
  checkResource,
  createCode,
  exchangeCode,
  getClient,
  issuer,
  normalizeScope,
  OAuthError,
  protectedResourceMetadata,
  refreshTokens,
  registerClient,
  type AuthorizeParams,
  type OAuthClient,
} from '../oauth/service.js';
import { listProjects } from '../projects/service.js';

/**
 * OAuth 2.1 端点（ChatGPT 插件 / Claude.ai 连接器等远程 MCP 客户端使用）：
 *   /.well-known/oauth-protected-resource[/mcp]   资源元数据（RFC 9728）
 *   /.well-known/oauth-authorization-server       授权服务器元数据（RFC 8414）
 *   POST /oauth/register                          动态客户端注册（RFC 7591）
 *   GET/POST /oauth/authorize                     登录 + 授权确认页
 *   POST /oauth/token                             授权码 / 刷新令牌换取访问令牌
 */

type Form = Record<string, string | undefined>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · TeXdraft</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6f8;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1d2330}
.card{width:min(420px,calc(100vw - 32px));background:#fff;border:1px solid #e3e6eb;border-radius:12px;padding:28px;box-shadow:0 8px 30px rgba(20,30,50,.06)}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;margin-bottom:18px}
.logo{width:26px;height:26px;border-radius:7px;background:#1f8f5f;color:#fff;display:grid;place-items:center;font-size:14px}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 14px;color:#4b5565}
label{display:block;font-size:13px;color:#4b5565;margin:12px 0 4px}
input,select{width:100%;box-sizing:border-box;height:38px;border:1px solid #d5d9e0;border-radius:8px;padding:0 10px;font:inherit;background:#fff}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;height:38px;border-radius:8px;border:1px solid #d5d9e0;background:#fff;font:inherit;cursor:pointer}
button.primary{background:#1f8f5f;border-color:#1f8f5f;color:#fff;font-weight:600}
ul{margin:0 0 6px;padding-left:20px;color:#4b5565}.err{background:#fdecec;color:#b42318;border-radius:8px;padding:8px 10px;margin-bottom:12px}
.muted{font-size:12.5px;color:#8a93a3;margin-top:14px}code{font-size:12.5px}
</style></head><body><div class="card"><div class="brand"><span class="logo">T</span>TeXdraft</div>${body}</div></body></html>`;
}

function sendPage(reply: FastifyReply, status: number, title: string, body: string) {
  return reply.status(status).header('Cache-Control', 'no-store').header('X-Frame-Options', 'DENY').type('text/html; charset=utf-8').send(page(title, body));
}

/** 不能安全重定向回客户端时（client 或 redirect_uri 无效）只显示错误页 */
const errorPage = (reply: FastifyReply, message: string) =>
  sendPage(reply, 400, '授权失败', `<h1>无法完成授权</h1><div class="err">${esc(message)}</div><p>请回到发起连接的应用重试。</p>`);

function redirectWith(reply: FastifyReply, redirectUri: string, params: Record<string, string | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set('iss', issuer()); // RFC 9207：每个授权响应（含错误）都带 iss
  return reply.redirect(u.toString(), 302);
}

/** 校验授权请求。返回 client 与规范化参数；redirect_uri 已确认合法后的错误抛 OAuthError 以重定向回客户端 */
async function parseAuthorize(q: Form): Promise<{ client: OAuthClient; params: AuthorizeParams }> {
  const client = await getClient(q.client_id);
  const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) throw new SafeError('redirect_uri 未在该客户端登记');
  const params: AuthorizeParams = {
    clientId: client.clientId,
    redirectUri,
    state: q.state,
    codeChallenge: q.code_challenge ?? '',
    scope: normalizeScope(q.scope),
    resource: null,
  };
  try {
    if (q.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) {
      throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    params.resource = checkResource(q.resource);
  } catch (e) {
    throw Object.assign(e as Error, { params });
  }
  return { client, params };
}

/** client / redirect_uri 本身有问题：只能显示错误页 */
class SafeError extends Error {}

async function handleAuthorizeError(reply: FastifyReply, e: unknown) {
  const params = (e as { params?: AuthorizeParams }).params;
  if (e instanceof OAuthError && params) {
    return redirectWith(reply, params.redirectUri, { error: e.code, error_description: e.message, state: params.state });
  }
  if (e instanceof OAuthError || e instanceof SafeError) return errorPage(reply, e.message);
  throw e;
}

/** 授权确认表单携带的参数签名，防止被篡改或跨用户重放 */
function signContext(params: AuthorizeParams, userId: string) {
  const payload = Buffer.from(JSON.stringify(params)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(`oauth:${userId}:${payload}`).digest('base64url');
  return `${payload}.${mac}`;
}

function verifyContext(ctx: string | undefined, userId: string): AuthorizeParams | null {
  const [payload, mac] = (ctx ?? '').split('.');
  if (!payload || !mac) return null;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(`oauth:${userId}:${payload}`).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function loginForm(query: string, error?: string, email = '') {
  return `<h1>登录以继续授权</h1><p>有应用请求访问你的 TeXdraft 项目，请先登录。</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/oauth/authorize/login">
<input type="hidden" name="next" value="${esc(query)}">
<label>邮箱</label><input name="email" type="email" value="${esc(email)}" required autofocus>
<label>密码</label><input name="password" type="password" required>
<div class="row"><button class="primary" type="submit">登录</button></div></form>`;
}

async function consentForm(client: OAuthClient, params: AuthorizeParams, userId: string) {
  const [user] = await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId));
  const projects = await listProjects(userId);
  const options = [`<option value="">全部项目（${projects.length} 个）</option>`]
    .concat(projects.map((p) => `<option value="${esc(p.id)}">仅「${esc(p.name)}」</option>`))
    .join('');
  const host = new URL(params.redirectUri).host;
  return `<h1>授权「${esc(client.name)}」访问 TeXdraft</h1>
<p>登录账号：${esc(user?.name ?? '')}（${esc(user?.email ?? '')}）</p>
<p>授权后，它可以：</p>
<ul><li>列出、读取、搜索项目文件</li><li>修改、新建、删除文件（首次修改前自动保存检查点，可在「历史」中恢复）</li><li>编译项目、检索并添加参考文献</li></ul>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="ctx" value="${esc(signContext(params, userId))}">
<label>可访问的项目</label><select name="project">${options}</select>
<div class="row"><button name="action" value="deny" type="submit">拒绝</button><button class="primary" name="action" value="allow" type="submit">允许</button></div></form>
<p class="muted">授权完成后将返回 <code>${esc(host)}</code>。可随时在编辑器「连接本地 Agent」的令牌列表中撤销。</p>`;
}

function setCors(reply: FastifyReply) {
  reply.header('Access-Control-Allow-Origin', '*').header('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
}

function oauthJsonError(reply: FastifyReply, e: unknown) {
  if (e instanceof OAuthError) {
    return reply.status(e.code === 'invalid_client' ? 401 : e.status).header('Cache-Control', 'no-store').send({ error: e.code, error_description: e.message });
  }
  throw e;
}

export async function oauthRoutes(app: FastifyInstance) {
  // ---------------- 元数据 ----------------
  const prm = async (_req: FastifyRequest, reply: FastifyReply) => (setCors(reply), protectedResourceMetadata());
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get('/.well-known/oauth-protected-resource/mcp', prm);
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => (setCors(reply), authorizationServerMetadata()));
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/token', '/oauth/register']) {
    app.options(path, async (_req, reply) => {
      setCors(reply);
      return reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS').status(204).send();
    });
  }

  // ---------------- 动态客户端注册 ----------------
  app.post('/oauth/register', async (req, reply) => {
    setCors(reply);
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return reply.status(201).header('Cache-Control', 'no-store').send(await registerClient(body));
    } catch (e) {
      return oauthJsonError(reply, e);
    }
  });

  // ---------------- 令牌 ----------------
  app.post('/oauth/token', async (req, reply) => {
    setCors(reply);
    try {
      const body = (req.body ?? {}) as Form;
      // 只支持公开客户端 + PKCE（token_endpoint_auth_method = none）
      if (body.client_secret || /^Basic\s/i.test(req.headers.authorization ?? '')) {
        throw new OAuthError('invalid_client', 'Only token_endpoint_auth_method "none" is supported');
      }
      const result =
        body.grant_type === 'authorization_code'
          ? await exchangeCode(body)
          : body.grant_type === 'refresh_token'
            ? await refreshTokens(body)
            : (() => {
                throw new OAuthError('unsupported_grant_type', `Unsupported grant_type: ${body.grant_type ?? ''}`);
              })();
      return reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(result);
    } catch (e) {
      return oauthJsonError(reply, e);
    }
  });

  // ---------------- 授权（登录 + 确认） ----------------
  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Form;
    let parsed: Awaited<ReturnType<typeof parseAuthorize>>;
    try {
      parsed = await parseAuthorize(q);
    } catch (e) {
      return handleAuthorizeError(reply, e);
    }
    const query = new URLSearchParams(q as Record<string, string>).toString();
    if (!req.userId) return sendPage(reply, 200, '登录', loginForm(query));
    return sendPage(reply, 200, '授权', await consentForm(parsed.client, parsed.params, req.userId));
  });

  app.post('/oauth/authorize/login', async (req, reply) => {
    const body = (req.body ?? {}) as Form;
    const next = body.next ?? '';
    const email = (body.email ?? '').trim().toLowerCase();
    let u: { id: string };
    try {
      u = await authenticatePassword(req, email, body.password ?? '');
    } catch (e) {
      if (e instanceof HttpError) return sendPage(reply, e.statusCode, '登录', loginForm(next, e.message, email));
      throw e;
    }
    reply.setCookie(SESSION_COOKIE, signSession(u.id), sessionCookieOptions(req));
    // 只回到本服务的授权页，参数会被重新校验
    return reply.redirect(`/oauth/authorize?${new URLSearchParams(next).toString()}`, 303);
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const body = (req.body ?? {}) as Form;
    if (!req.userId) return errorPage(reply, '登录已失效，请回到应用重新发起连接');
    const params = verifyContext(body.ctx, req.userId);
    if (!params) return errorPage(reply, '授权请求无效或已被篡改');
    // 重新确认客户端与回调地址仍然有效
    let client: OAuthClient;
    try {
      client = await getClient(params.clientId);
      if (!client.redirectUris.includes(params.redirectUri)) throw new SafeError('redirect_uri 未在该客户端登记');
    } catch (e) {
      return handleAuthorizeError(reply, e);
    }
    if (body.action !== 'allow') {
      return redirectWith(reply, params.redirectUri, { error: 'access_denied', error_description: 'The user denied access', state: params.state });
    }
    let projectId: string | null = null;
    if (body.project) {
      const mine = await listProjects(req.userId);
      if (!mine.some((p) => p.id === body.project)) return errorPage(reply, '无权访问所选项目');
      projectId = body.project;
    }
    const code = await createCode(params, req.userId, projectId);
    req.log.info({ client: client.clientId, projectId }, 'oauth authorization granted');
    return redirectWith(reply, params.redirectUri, { code, state: params.state });
  });
}
