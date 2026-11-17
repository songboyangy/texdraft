// OAuth 2.1 + MCP 端到端测试：模拟 ChatGPT（CIMD client_id）与动态注册客户端走完整授权流程。
// 用法：node scripts/e2e/oauth.mjs（需先启动服务端，并存在 a@test.dev / password123 用户）
//   BASE=http://127.0.0.1:8787  CIMD=0 可跳过需要外网的 ChatGPT CIMD 用例
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const EMAIL = 'a@test.dev';
const PASSWORD = 'password123';
const ok = (m) => console.log(`ok - ${m}`);

const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
assert.equal(prm.authorization_servers[0], meta.issuer);
assert.ok(meta.code_challenge_methods_supported.includes('S256'));
assert.equal(meta.authorization_response_iss_parameter_supported, true);
ok('discovery metadata');

const unauth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(unauth.status, 401);
assert.match(unauth.headers.get('www-authenticate'), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
ok('unauthenticated /mcp returns 401 with resource_metadata');

const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** 浏览器部分：登录 → 授权确认 → 拿到回调里的 code */
async function authorize(clientId, redirectUri, { project, deny } = {}) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(8).toString('hex');
  const q = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'projects offline_access', resource: prm.resource };
  const url = `${BASE}/oauth/authorize?${form(q)}`;

  let r = await fetch(url, { redirect: 'manual' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /登录以继续授权/);

  r = await fetch(`${BASE}/oauth/authorize/login`, { method: 'POST', headers: FORM, body: form({ next: form(q), email: EMAIL, password: PASSWORD }), redirect: 'manual' });
  assert.equal(r.status, 303);
  const cookie = r.headers.get('set-cookie').split(';')[0];

  r = await fetch(url, { headers: { cookie }, redirect: 'manual' });
  const html = await r.text();
  assert.match(html, /授权「/);
  const ctx = /name="ctx" value="([^"]+)"/.exec(html)[1];

  r = await fetch(`${BASE}/oauth/authorize`, { method: 'POST', headers: { ...FORM, cookie }, body: form({ ctx, project: project ?? '', action: deny ? 'deny' : 'allow' }), redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(`${loc.origin}${loc.pathname}`, redirectUri);
  assert.equal(loc.searchParams.get('state'), state);
  assert.equal(loc.searchParams.get('iss'), meta.issuer);
  return { code: loc.searchParams.get('code'), error: loc.searchParams.get('error'), verifier, cookie };
}

async function token(body) {
  const r = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: FORM, body: form(body) });
  return { status: r.status, json: await r.json() };
}

let rpcId = 0;
async function mcp(accessToken, method, params = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}

async function fullFlow(label, clientId, redirectUri) {
  const { code, verifier, cookie } = await authorize(clientId, redirectUri);
  assert.ok(code);
  ok(`${label}: login + consent → authorization code (state & iss echoed)`);

  const bad = await token({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: 'x'.repeat(43) });
  assert.equal(bad.json.error, 'invalid_grant');
  ok(`${label}: wrong PKCE verifier rejected (and code consumed)`);

  const again = await authorize(clientId, redirectUri);
  const t = await token({ grant_type: 'authorization_code', client_id: clientId, code: again.code, redirect_uri: redirectUri, code_verifier: again.verifier, resource: prm.resource });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.ok(t.json.access_token.startsWith('tpa_') && t.json.refresh_token.startsWith('tpr_'));
  ok(`${label}: code exchanged for access + refresh token`);

  const reuse = await token({ grant_type: 'authorization_code', client_id: clientId, code: again.code, redirect_uri: redirectUri, code_verifier: again.verifier });
  assert.equal(reuse.json.error, 'invalid_grant');
  ok(`${label}: authorization code cannot be reused`);

  const init = await mcp(t.json.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  assert.equal(init.status, 200);
  const tools = await mcp(t.json.access_token, 'tools/list');
  const byName = Object.fromEntries(tools.body.result.tools.map((x) => [x.name, x]));
  assert.equal(byName.read_file.annotations.readOnlyHint, true);
  assert.equal(byName.delete_file.annotations.destructiveHint, true);
  assert.equal(byName.list_projects._meta.securitySchemes[0].type, 'oauth2');
  const list = await mcp(t.json.access_token, 'tools/call', { name: 'list_projects', arguments: {} });
  assert.match(list.body.result.content[0].text, /Demo/);
  ok(`${label}: MCP initialize / tools/list (annotations) / list_projects with access token`);

  const r1 = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: t.json.refresh_token });
  assert.equal(r1.status, 200);
  assert.equal((await mcp(t.json.access_token, 'tools/list')).status, 401, 'old access token should stop working');
  assert.equal((await mcp(r1.json.access_token, 'tools/list')).status, 200);
  const grace = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: t.json.refresh_token });
  assert.equal(grace.status, 200, 'previous refresh token usable within grace period');
  ok(`${label}: refresh rotates tokens (old access revoked, grace for previous refresh token)`);

  // 撤销：在令牌列表里删除这条连接
  const tokens = await (await fetch(`${BASE}/api/tokens`, { headers: { cookie } })).json();
  const conn = tokens.find((x) => x.prefix === 'OAuth' && x.lastUsedAt !== undefined && x.name);
  const latest = tokens.filter((x) => x.prefix === 'OAuth').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  assert.ok(conn && latest);
  const del = await fetch(`${BASE}/api/tokens/${latest.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(del.status, 200);
  assert.equal((await mcp(grace.json.access_token, 'tools/list')).status, 401);
  assert.equal((await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: grace.json.refresh_token })).json.error, 'invalid_grant');
  ok(`${label}: revoking the connection invalidates access and refresh tokens`);
  // 清理第一次失败流程留下的令牌（未换取过，不存在）——无需处理
}

// ---- 动态注册客户端（Claude.ai 等）
const reg = await fetch(`${BASE}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'E2E client', redirect_uris: ['https://example.test/callback'], token_endpoint_auth_method: 'client_secret_post' }),
});
assert.equal(reg.status, 201);
const client = await reg.json();
assert.equal(client.token_endpoint_auth_method, 'none');
ok('dynamic client registration');

const badRedirect = await fetch(`${BASE}/oauth/authorize?${form({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.test/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`, { redirect: 'manual' });
assert.equal(badRedirect.status, 400);
ok('unregistered redirect_uri shows an error page instead of redirecting');

const noPkce = await fetch(`${BASE}/oauth/authorize?${form({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://example.test/callback', state: 's' })}`, { redirect: 'manual' });
assert.equal(noPkce.status, 302);
assert.equal(new URL(noPkce.headers.get('location')).searchParams.get('error'), 'invalid_request');
ok('missing PKCE is rejected via redirect');

const denied = await authorize(client.client_id, 'https://example.test/callback', { deny: true });
assert.equal(denied.error, 'access_denied');
ok('user can deny');

await fullFlow('DCR', client.client_id, 'https://example.test/callback');

// 授权时只选一个项目：list_projects 只能看到它
{
  const probe = await authorize(client.client_id, 'https://example.test/callback', { deny: true });
  const projects = await (await fetch(`${BASE}/api/projects`, { headers: { cookie: probe.cookie } })).json();
  const target = projects.find((p) => p.name === 'Demo');
  const scoped = await authorize(client.client_id, 'https://example.test/callback', { project: target.id });
  const t = await token({ grant_type: 'authorization_code', client_id: client.client_id, code: scoped.code, redirect_uri: 'https://example.test/callback', code_verifier: scoped.verifier });
  const list = await mcp(t.json.access_token, 'tools/call', { name: 'list_projects', arguments: {} });
  const shown = list.body.result.content[0].text;
  assert.match(shown, /Demo/);
  for (const other of projects.filter((p) => p.id !== target.id)) assert.ok(!shown.includes(other.id), `scoped token must not list ${other.name}`);
  const tokens = await (await fetch(`${BASE}/api/tokens`, { headers: { cookie: scoped.cookie } })).json();
  const row = tokens.find((x) => x.prefix === 'OAuth' && x.projectId === target.id);
  assert.equal(row.projectName, 'Demo');
  await fetch(`${BASE}/api/tokens/${row.id}`, { method: 'DELETE', headers: { cookie: scoped.cookie } });
  ok(`project-scoped grant only sees "Demo" (${projects.length - 1} other projects hidden)`);
}

const ssrf = await fetch(`${BASE}/oauth/authorize?${form({ response_type: 'code', client_id: 'https://10.0.0.1/client.json', redirect_uri: 'https://example.test/callback' })}`, { redirect: 'manual' });
assert.equal(ssrf.status, 400);
ok('CIMD client_id on a non-allowlisted host is refused (no SSRF)');

// ---- ChatGPT（CIMD：client_id 是 https://chatgpt.com/oauth/client.json）
if (process.env.CIMD !== '0') {
  await fullFlow('ChatGPT CIMD', 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect');
}

console.log('ALL OAUTH TESTS PASSED');
