// 账号与管理端到端测试：注册方式、邀请码、管理员、禁用、重置 / 修改密码、登录限流
// 用法：node scripts/e2e/accounts.mjs（需先启动服务端；a@test.dev 必须是管理员——全新数据库上由 seed.mjs 第一个注册即可）
// 测试结束时恢复原来的注册方式，并禁用本次创建的测试账号。
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ok = (m) => console.log(`ok - ${m}`);
const run = Date.now().toString(36);
const mail = (n) => `${n}-${run}@e2e.test`;

/** 带 Cookie 的简易会话 */
function session(cookie = '') {
  const s = {
    cookie,
    async req(method, path, body) {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'accept-language': 'en', ...(s.cookie ? { cookie: s.cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = r.headers.get('set-cookie');
      if (set?.startsWith('tp_session=')) s.cookie = set.split(';')[0];
      const text = await r.text();
      return { status: r.status, data: text ? JSON.parse(text) : null };
    },
  };
  return s;
}
const login = async (email, password) => {
  const s = session();
  const r = await s.req('POST', '/api/auth/login', { email, password });
  return { s, r };
};
const register = async (email, invite) => {
  const s = session();
  const r = await s.req('POST', '/api/auth/register', { email, name: email.split('@')[0], password: 'password123', ...(invite ? { invite } : {}) });
  return { s, r };
};

const { s: admin, r: adminLogin } = await login('a@test.dev', 'password123');
assert.equal(adminLogin.status, 200);
assert.equal(adminLogin.data.isAdmin, true, 'a@test.dev must be an admin');
const original = (await admin.req('GET', '/api/admin/settings')).data.registration;
const created = [];

try {
  // ---- 注册方式
  await admin.req('PATCH', '/api/admin/settings', { registration: 'closed' });
  assert.equal((await session().req('GET', '/api/auth/config')).data.registration, 'closed');
  assert.equal((await register(mail('closed'))).r.status, 403);
  ok('closed registration rejects sign-ups');

  await admin.req('PATCH', '/api/admin/settings', { registration: 'invite' });
  assert.equal((await register(mail('noinvite'))).r.status, 403);
  const inv = (await admin.req('POST', '/api/admin/invites', { note: 'e2e', maxUses: 1, expiresInDays: 1 })).data;
  assert.ok(inv.code && inv.invite.status === 'active');
  const b = await register(mail('b'), inv.code);
  assert.equal(b.r.status, 200, JSON.stringify(b.r.data));
  assert.equal(b.r.data.isAdmin, false);
  created.push(b.r.data.id);
  assert.equal((await register(mail('reuse'), inv.code)).r.status, 403);
  const inv2 = (await admin.req('POST', '/api/admin/invites', { maxUses: 5 })).data;
  await admin.req('DELETE', `/api/admin/invites/${inv2.invite.id}`);
  assert.equal((await register(mail('revoked'), inv2.code)).r.status, 403);
  const list = (await admin.req('GET', '/api/admin/invites')).data;
  assert.equal(list.find((i) => i.id === inv.invite.id).status, 'used');
  assert.equal(list.find((i) => i.id === inv2.invite.id).status, 'revoked');
  ok('invite-only: code required, single-use codes are consumed, revoked codes rejected');

  await admin.req('PATCH', '/api/admin/settings', { registration: 'open' });
  const d = await register(mail('d'));
  assert.equal(d.r.status, 200);
  created.push(d.r.data.id);
  ok('open registration works');

  // ---- 权限
  assert.equal((await b.s.req('GET', '/api/admin/users')).status, 403);
  assert.equal((await b.s.req('PATCH', '/api/admin/settings', { registration: 'open' })).status, 403);
  const users = (await admin.req('GET', '/api/admin/users')).data.users;
  assert.ok(users.some((u) => u.id === b.r.data.id));
  ok('admin API is admin-only');

  // 本机 CLI 后端（Claude Code / Codex）用的是服务器所有者的账号，只给管理员
  assert.deepEqual((await b.s.req('GET', '/api/agent/backends')).data.backends, ['builtin']);
  const bp = (await b.s.req('POST', '/api/projects', { name: 'cli guard' })).data;
  for (const backend of ['codex', 'claude']) {
    assert.equal((await b.s.req('POST', `/api/projects/${bp.id}/agent/chat`, { backend, message: 'hi' })).status, 403);
  }
  assert.equal((await b.s.req('GET', '/api/agent-setup/local')).data.enabled, false);
  assert.equal((await b.s.req('POST', '/api/agent-setup/local', {})).status, 403);
  await b.s.req('DELETE', `/api/projects/${bp.id}`);
  ok('local CLI backends and local agent setup are admin-only');

  // 「打开示例」：没有就创建一份，再次打开返回同一个
  const s1 = await b.s.req('POST', '/api/projects/sample', {});
  assert.equal(s1.status, 200, JSON.stringify(s1.data));
  const s2 = await b.s.req('POST', '/api/projects/sample', {});
  assert.equal(s2.data.id, s1.data.id);
  const bFiles = (await b.s.req('GET', `/api/projects/${s1.data.id}/files`)).data.map((f) => f.path).sort();
  assert.deepEqual(bFiles, ['main.tex', 'refs.bib']);
  await b.s.req('DELETE', `/api/projects/${s1.data.id}`);
  ok('opening the sample creates it once and reuses it');

  // ---- 禁用：会话与访问令牌立即失效
  const tok = (await b.s.req('POST', '/api/tokens', { name: 'e2e' })).data;
  const mcp = (token) =>
    fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }).then((r) => r.status);
  assert.equal(await mcp(tok.token), 200);
  await admin.req('PATCH', `/api/admin/users/${b.r.data.id}`, { disabled: true });
  assert.equal((await b.s.req('GET', '/api/auth/me')).status, 401);
  assert.equal(await mcp(tok.token), 401);
  assert.equal((await login(mail('b'), 'password123')).r.status, 403);
  await admin.req('PATCH', `/api/admin/users/${b.r.data.id}`, { disabled: false });
  const b2 = await login(mail('b'), 'password123');
  assert.equal(b2.r.status, 200);
  assert.equal(await mcp(tok.token), 200);
  ok('disabling a user revokes sessions and MCP tokens immediately; re-enabling restores access');

  // ---- 管理员重置密码
  const temp = (await admin.req('POST', `/api/admin/users/${b.r.data.id}/reset-password`)).data.password;
  assert.equal((await b2.s.req('GET', '/api/auth/me')).status, 401);
  assert.equal((await login(mail('b'), 'password123')).r.status, 401);
  const b3 = await login(mail('b'), temp);
  assert.equal(b3.r.status, 200);
  ok('admin password reset: temporary password works, old password and sessions do not');

  // ---- 用户修改自己的密码：其他会话失效，本会话保留
  const other = await login(mail('b'), temp);
  assert.equal((await b3.s.req('POST', '/api/auth/password', { current: 'wrong-password', next: 'newpassword1' })).status, 400);
  assert.equal((await b3.s.req('POST', '/api/auth/password', { current: temp, next: 'newpassword1' })).status, 200);
  assert.equal((await b3.s.req('GET', '/api/auth/me')).status, 200);
  assert.equal((await other.s.req('GET', '/api/auth/me')).status, 401);
  assert.equal((await login(mail('b'), 'newpassword1')).r.status, 200);
  ok('changing your password keeps this session and signs out other sessions');

  // ---- 管理员自我保护与提权
  const me = (await admin.req('GET', '/api/auth/me')).data;
  assert.equal((await admin.req('PATCH', `/api/admin/users/${me.id}`, { disabled: true })).status, 400);
  assert.equal((await admin.req('PATCH', `/api/admin/users/${me.id}`, { isAdmin: false })).status, 400);
  await admin.req('PATCH', `/api/admin/users/${b.r.data.id}`, { isAdmin: true });
  assert.equal((await b3.s.req('GET', '/api/admin/users')).status, 200);
  await admin.req('PATCH', `/api/admin/users/${b.r.data.id}`, { isAdmin: false });
  assert.equal((await b3.s.req('GET', '/api/admin/users')).status, 403);
  ok('admins cannot disable or demote themselves; promote / demote others takes effect immediately');

  // ---- 登录限流
  const victim = mail('d');
  for (let i = 0; i < 10; i++) assert.equal((await login(victim, 'wrong-password')).r.status, 401);
  const blocked = await login(victim, 'password123');
  assert.equal(blocked.r.status, 429, 'correct password is still blocked after 10 failures');
  ok('login is rate-limited per account after 10 failures');

  console.log('ALL ACCOUNT TESTS PASSED');
} finally {
  await admin.req('PATCH', '/api/admin/settings', { registration: original });
  for (const id of created) await admin.req('PATCH', `/api/admin/users/${id}`, { isAdmin: false, disabled: true });
}
