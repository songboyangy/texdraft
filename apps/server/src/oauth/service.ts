import crypto from 'node:crypto';
import { fetch as proxyFetch, ProxyAgent } from 'undici';
import { and, eq, gt, lt, or } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';

/**
 * OAuth 2.1 授权服务（授权码 + PKCE S256，公开客户端，刷新令牌轮换）。
 * 资源服务器就是本服务的 /mcp；签发的访问令牌是不透明随机串，数据库只存 SHA-256。
 */

export const SCOPES = ['projects', 'offline_access'];
const ACCESS_TTL_S = 3600;
const CODE_TTL_MS = 10 * 60 * 1000;
/** 刷新令牌轮换后，旧令牌在这段时间内仍可用一次（客户端重试 / 并发刷新） */
const REFRESH_GRACE_MS = 2 * 60 * 1000;
const CIMD_TTL_MS = 60 * 60 * 1000;
// Node versions before built-in environment proxy support need an explicit dispatcher.
const cimdProxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
const cimdProxyAgent = cimdProxyUrl ? new ProxyAgent(cimdProxyUrl) : undefined;

export const ACCESS_PREFIX = 'tpa_';
const REFRESH_PREFIX = 'tpr_';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const random = (prefix = '') => prefix + crypto.randomBytes(32).toString('base64url');

export const issuer = () => config.publicUrl.replace(/\/+$/, '');
export const resourceUrl = () => `${issuer()}/mcp`;
export const resourceMetadataUrl = () => `${issuer()}/.well-known/oauth-protected-resource/mcp`;

export class OAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

// ---------------- 元数据 ----------------

export function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [issuer()],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'TeXdraft',
  };
}

export function authorizationServerMetadata() {
  const base = issuer();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    // 允许抓取的主机为空时不宣称支持 CIMD：客户端会改用动态注册（DCR），服务器无需访问对方网站。
    // 机房 IP 抓取 chatgpt.com / claude.ai 常被 Cloudflare 的人机验证拦下（HTTP 403），这时设 OAUTH_CIMD_HOSTS= 即可
    client_id_metadata_document_supported: config.oauth.cimdHosts.length > 0,
  };
}

/** 401 时返回的 WWW-Authenticate，告诉客户端去哪里发现授权服务器 */
export function wwwAuthenticate(error?: string) {
  const parts = [`resource_metadata="${resourceMetadataUrl()}"`, `scope="${SCOPES.join(' ')}"`];
  if (error) parts.push(`error="${error}"`);
  return `Bearer ${parts.join(', ')}`;
}

/** resource 参数可省略；给出时必须指向本服务（容忍末尾斜杠） */
export function checkResource(resource: string | undefined | null) {
  if (!resource) return null;
  const norm = resource.replace(/\/+$/, '');
  if (norm !== resourceUrl() && norm !== issuer()) throw new OAuthError('invalid_target', `Unknown resource: ${resource}`);
  return norm;
}

export function normalizeScope(scope: string | undefined | null) {
  const asked = (scope ?? '').split(/\s+/).filter(Boolean);
  const granted = asked.filter((s) => SCOPES.includes(s));
  return (granted.length ? granted : SCOPES).join(' ');
}

// ---------------- 客户端 ----------------

export interface OAuthClient { clientId: string; name: string; redirectUris: string[] }

const isLoopback = (u: URL) => u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);

function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2000) return false;
  try {
    const u = new URL(raw);
    return !u.hash && (u.protocol === 'https:' || isLoopback(u));
  } catch {
    return false;
  }
}

/** 动态客户端注册（RFC 7591）。只支持公开客户端（token_endpoint_auth_method = none） */
export async function registerClient(body: Record<string, unknown>) {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be 1-10 https (or loopback http) URLs');
  }
  const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'MCP client';
  const clientId = random('tpc_');
  await db.insert(schema.oauthClients).values({ clientId, kind: 'dcr', name, redirectUris: uris as string[] });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: SCOPES.join(' '),
  };
}

/** 抓取 Client ID Metadata Document：client_id 本身就是文档地址 */
async function fetchCimd(clientId: string): Promise<OAuthClient> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError('invalid_client', 'Unknown client');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || !config.oauth.cimdHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new OAuthError('invalid_client', `Client metadata host not allowed: ${host} (set OAUTH_CIMD_HOSTS)`);
  }
  let doc: Record<string, unknown>;
  try {
    const res = await proxyFetch(url, { dispatcher: cimdProxyAgent, signal: AbortSignal.timeout(8000), redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(
        res.status === 403 || res.status === 503
          ? `HTTP ${res.status} — ${host} blocked this server (often a bot check on data-center IPs). The administrator can set OAUTH_CIMD_HOSTS= (empty) so clients register dynamically instead; then remove and re-add the connector.`
          : `HTTP ${res.status}`,
      );
    }
    const text = await res.text();
    if (text.length > 64 * 1024) throw new Error('document too large');
    doc = JSON.parse(text);
  } catch (e) {
    throw new OAuthError('invalid_client', `Could not load client metadata: ${(e as Error).message}`);
  }
  if (doc.client_id !== clientId) throw new OAuthError('invalid_client', 'client_id in metadata document does not match');
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter(validRedirectUri) : [];
  if (!uris.length) throw new OAuthError('invalid_client', 'Client metadata has no valid redirect_uris');
  const methods = [doc.token_endpoint_auth_method, ...(Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : [])];
  if (methods.some(Boolean) && !methods.includes('none')) throw new OAuthError('invalid_client', 'Client does not support token_endpoint_auth_method "none"');
  const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 80) : host;
  return { clientId, name, redirectUris: uris };
}

export async function getClient(clientId: string | undefined): Promise<OAuthClient> {
  if (!clientId) throw new OAuthError('invalid_client', 'Missing client_id');
  const [row] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, clientId));
  if (row && (row.kind === 'dcr' || (row.fetchedAt && Date.now() - row.fetchedAt.getTime() < CIMD_TTL_MS))) {
    return { clientId: row.clientId, name: row.name, redirectUris: row.redirectUris };
  }
  if (!clientId.startsWith('https://')) throw new OAuthError('invalid_client', 'Unknown client');
  const c = await fetchCimd(clientId);
  await db
    .insert(schema.oauthClients)
    .values({ clientId, kind: 'cimd', name: c.name, redirectUris: c.redirectUris, fetchedAt: new Date() })
    .onConflictDoUpdate({ target: schema.oauthClients.clientId, set: { name: c.name, redirectUris: c.redirectUris, fetchedAt: new Date() } });
  return c;
}

// ---------------- 授权码 ----------------

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
}

export async function createCode(p: AuthorizeParams, userId: string, projectId: string | null) {
  const code = random('tpk_');
  // 顺带清理过期授权码
  await db.delete(schema.oauthCodes).where(lt(schema.oauthCodes.expiresAt, new Date()));
  await db.insert(schema.oauthCodes).values({
    codeHash: sha256(code),
    clientId: p.clientId,
    userId,
    projectId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    scope: p.scope,
    resource: p.resource,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

// ---------------- 令牌 ----------------

function tokenResponse(access: string, refresh: string, scope: string) {
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
}

const pkceS256 = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');

export async function exchangeCode(body: Record<string, string | undefined>) {
  const client = await getClient(body.client_id);
  if (!body.code) throw new OAuthError('invalid_request', 'Missing code');
  // 一次性：先删后用，并发重放只有一个能拿到
  const [row] = await db.delete(schema.oauthCodes).where(eq(schema.oauthCodes.codeHash, sha256(body.code))).returning();
  if (!row || row.expiresAt.getTime() < Date.now()) throw new OAuthError('invalid_grant', 'Invalid or expired authorization code');
  if (row.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'Code was issued to another client');
  if (body.redirect_uri !== row.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
  const verifier = body.code_verifier ?? '';
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || pkceS256(verifier) !== row.codeChallenge) {
    throw new OAuthError('invalid_grant', 'PKCE verification failed');
  }
  const resource = checkResource(body.resource) ?? row.resource;

  // 一次授权对应一条 api_tokens 记录：出现在“连接本地 Agent”的令牌列表里，删除即撤销
  const [token] = await db
    .insert(schema.apiTokens)
    .values({ userId: row.userId, name: client.name, tokenHash: sha256(random()), prefix: 'OAuth', projectId: row.projectId })
    .returning({ id: schema.apiTokens.id });
  const access = random(ACCESS_PREFIX);
  const refresh = random(REFRESH_PREFIX);
  await db.insert(schema.oauthGrants).values({
    apiTokenId: token.id,
    clientId: client.clientId,
    scope: row.scope,
    resource,
    accessHash: sha256(access),
    accessExpiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
    refreshHash: sha256(refresh),
  });
  return tokenResponse(access, refresh, row.scope);
}

export async function refreshTokens(body: Record<string, string | undefined>) {
  const client = await getClient(body.client_id);
  const presented = body.refresh_token ?? '';
  if (!presented.startsWith(REFRESH_PREFIX)) throw new OAuthError('invalid_grant', 'Invalid refresh token');
  const h = sha256(presented);
  const graceStart = new Date(Date.now() - REFRESH_GRACE_MS);
  const [grant] = await db
    .select()
    .from(schema.oauthGrants)
    .where(or(eq(schema.oauthGrants.refreshHash, h), and(eq(schema.oauthGrants.prevRefreshHash, h), gt(schema.oauthGrants.refreshedAt, graceStart))));
  if (!grant || grant.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'Invalid refresh token');
  const access = random(ACCESS_PREFIX);
  const refresh = random(REFRESH_PREFIX);
  await db
    .update(schema.oauthGrants)
    .set({
      accessHash: sha256(access),
      accessExpiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
      refreshHash: sha256(refresh),
      prevRefreshHash: h,
      refreshedAt: new Date(),
    })
    .where(eq(schema.oauthGrants.id, grant.id));
  return tokenResponse(access, refresh, grant.scope);
}

/** 校验 OAuth 访问令牌，返回对应的 api_tokens 记录 id；过期或已撤销返回 null */
export async function apiTokenIdForAccessToken(token: string): Promise<string | null> {
  const [g] = await db
    .select({ apiTokenId: schema.oauthGrants.apiTokenId, exp: schema.oauthGrants.accessExpiresAt, resource: schema.oauthGrants.resource })
    .from(schema.oauthGrants)
    .where(eq(schema.oauthGrants.accessHash, sha256(token)));
  if (!g || g.exp.getTime() < Date.now()) return null;
  if (g.resource && g.resource !== resourceUrl() && g.resource !== issuer()) return null;
  return g.apiTokenId;
}
