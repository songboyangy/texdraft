// 每人自带 AI Key：加密保存只回显末四位、自定义地址仅管理员、测试连接、Agent 使用自己的 Key、用量统计、删除后回到服务器模型
// 用法：mock-anthropic.mjs 运行中；服务端用模拟接口作为共享模型（ANTHROPIC_BASE_URL=http://127.0.0.1:8790 ANTHROPIC_API_KEY=test），
//       允许开放注册；需要 seed.mjs（a@test.dev 是管理员）。
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:8790';
const ok = (m) => console.log(`ok - ${m}`);

function session() {
  const s = {
    cookie: '',
    async req(method, path, body) {
      const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', 'accept-language': 'en', ...(s.cookie ? { cookie: s.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie');
      if (set?.startsWith('tp_session=')) s.cookie = set.split(';')[0];
      const text = await r.text();
      return { status: r.status, data: text ? JSON.parse(text) : null, raw: text };
    },
  };
  return s;
}
async function chat(s, pid, message, threadId) {
  const res = await fetch(`${BASE}/api/projects/${pid}/agent/chat`, { method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ message, context: {}, ...(threadId ? { threadId } : {}) }) });
  let buf = '';
  const events = [];
  for await (const c of res.body) {
    buf += new TextDecoder().decode(c);
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}
const lastRequest = async () => (await (await fetch(`${MOCK}/_requests`)).json()).at(-1);

const admin = session();
assert.equal((await admin.req('POST', '/api/auth/login', { email: 'a@test.dev', password: 'password123' })).status, 200);
await admin.req('DELETE', '/api/ai/settings');
const pid = (await admin.req('GET', '/api/projects')).data.find((p) => p.name === 'Demo').id;

// ---- 默认：服务器模型
const v0 = (await admin.req('GET', '/api/ai/settings')).data;
assert.equal(v0.settings, null);
assert.equal(v0.shared.available, true);
assert.ok(v0.presets.some((p) => p.id === 'deepseek' && p.baseUrl.includes('deepseek')));
ok('defaults to the server model; presets listed');

// ---- 普通用户：预设可以，自定义地址不行；Key 只回显末四位
const user = session();
const email = `ai-${Date.now().toString(36)}@e2e.test`;
assert.equal((await user.req('POST', '/api/auth/register', { email, name: 'ai user', password: 'password123' })).status, 200);
const custom = await user.req('PUT', '/api/ai/settings', { preset: 'custom', provider: 'openai', baseUrl: 'http://127.0.0.1:8790/v1', model: 'x', apiKey: 'k' });
assert.equal(custom.status, 403);
const saved = await user.req('PUT', '/api/ai/settings', { preset: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-user-secret-1234' });
assert.equal(saved.status, 200, saved.raw);
assert.ok(!saved.raw.includes('sk-user-secret'), 'the key is never returned');
assert.equal(saved.data.settings.keyHint, '1234');
assert.equal(saved.data.settings.hasKey, true);
assert.equal(saved.data.settings.baseUrl, 'https://api.deepseek.com/anthropic', 'preset base URL cannot be overridden');
const keep = await user.req('PUT', '/api/ai/settings', { preset: 'deepseek', model: 'deepseek-reasoner' });
assert.equal(keep.data.settings.keyHint, '1234', 'omitting apiKey keeps the saved key');
assert.equal((await user.req('PUT', '/api/ai/settings', { preset: 'openai', model: 'gpt-x', apiKey: '' })).status, 400, 'a preset needs a key');
ok('users can save a preset with their key (stored encrypted, only last 4 shown); custom endpoints are admin-only');

// ---- 管理员：自定义地址 + 测试连接
const mine = { preset: 'custom', provider: 'openai', baseUrl: 'http://127.0.0.1:8790/v1', model: 'gpt-own', apiKey: 'own-key-5678' };
const t = (await admin.req('POST', '/api/ai/test', mine)).data;
assert.equal(t.ok, true, JSON.stringify(t));
assert.equal(t.reply, 'OK');
const bad = (await admin.req('POST', '/api/ai/test', { ...mine, baseUrl: 'http://127.0.0.1:9/v1' })).data;
assert.equal(bad.ok, false);
assert.match(bad.error, /reach|connect/i);
assert.equal((await admin.req('PUT', '/api/ai/settings', mine)).status, 200);
ok('test connection reports success and failure; admins can use a custom endpoint');

// ---- Agent 使用自己的 Key
const ev = await chat(admin, pid, 'PING with my own key');
assert.equal(ev.at(-1).status, 'completed', JSON.stringify(ev.at(-1)));
const r1 = await lastRequest();
assert.ok(r1.url.startsWith('/v1/chat/completions'));
assert.equal(r1.headers.authorization, 'Bearer own-key-5678');
assert.equal(r1.body.model, 'gpt-own');
const v1 = (await admin.req('GET', '/api/ai/settings')).data;
assert.ok(v1.usage.own.requests >= 1 && v1.usage.own.inputTokens > 0, 'usage recorded under the own key');
const usersList = (await admin.req('GET', '/api/admin/users')).data.users;
const me = usersList.find((u) => u.email === 'a@test.dev');
assert.ok(me.ownAiKey && me.aiTokensToday > 0, 'admin list shows AI usage');
ok('the agent uses the user\'s own provider, model and key; usage is recorded');

// ---- 删除后回到服务器模型
await admin.req('DELETE', '/api/ai/settings');
const ev2 = await chat(admin, pid, 'PING with the server model');
assert.equal(ev2.at(-1).status, 'completed');
const r2 = await lastRequest();
// SDK 版本不同，Key 可能放在 x-api-key 或 Authorization: Bearer 中
const sharedKey = r2.headers['x-api-key'] ?? r2.headers.authorization?.replace(/^Bearer /, '');
assert.ok(r2.url.startsWith('/v1/messages') && sharedKey === 'test', `back to the shared model: ${r2.url} ${JSON.stringify(r2.headers)}`);
ok('removing personal settings falls back to the server model');

// ---- 服务器 AI 的免费额度（管理员按人设置；按 token 单价计费，只算服务器 Key）
await user.req('DELETE', '/api/ai/settings');
const uid = (await user.req('GET', '/api/auth/me')).data.id;
const upid = (await user.req('POST', '/api/projects', { name: 'credit e2e' })).data.id;
const userRow = async () => (await admin.req('GET', '/api/admin/users')).data.users.find((u) => u.id === uid);
assert.equal((await admin.req('PATCH', `/api/admin/users/${uid}`, { aiCredit: 1 })).status, 200);
const c0 = (await user.req('GET', '/api/ai/settings')).data.shared.credit;
assert.deepEqual([c0.limit, c0.spent], [1, 0]);
const e1 = await chat(user, upid, 'PING on free credit');
assert.equal(e1.at(-1).status, 'completed', JSON.stringify(e1.at(-1)));
const c1 = (await user.req('GET', '/api/ai/settings')).data.shared.credit;
assert.ok(c1.spent > 0 && c1.spent < 1, `credit spent: ${c1.spent}`);
const row1 = await userRow();
assert.equal(row1.aiCredit, 1);
assert.ok(Math.abs(row1.aiSpent - c1.spent) < 1e-9);
ok('server AI usage is priced and counted against the user\'s free credit');

// 额度用完：拒绝并提示自带 Key；自带 Key 不受影响
assert.equal((await admin.req('PATCH', `/api/admin/users/${uid}`, { aiCredit: 0 })).status, 200);
const e2 = await chat(user, upid, 'PING after the credit ran out');
const last2 = e2.at(-1);
assert.equal(last2.status, 'error', JSON.stringify(last2));
assert.match(last2.error, /free server AI credit|免费 AI 额度/);
assert.equal((await user.req('PUT', '/api/ai/settings', { preset: 'openai', model: 'gpt-own', apiKey: 'own-key-5678' })).status, 200);
await fetch(`${MOCK}/_requests`);
// 预设 OpenAI 地址不可达（测试环境），只验证不再被额度拦截
const e3 = await chat(user, upid, 'PING with own key after credit');
assert.ok(!/free server AI credit|免费 AI 额度/.test(e3.at(-1).error ?? ''), JSON.stringify(e3.at(-1)));
await user.req('DELETE', '/api/ai/settings');
// 恢复默认（测试环境没有设置 AI_SHARED_CREDIT = 不限）
assert.equal((await admin.req('PATCH', `/api/admin/users/${uid}`, { aiCredit: null })).status, 200);
assert.equal((await user.req('GET', '/api/ai/settings')).data.shared.credit, null);
assert.equal((await chat(user, upid, 'PING unlimited again')).at(-1).status, 'completed');
// 管理员不受额度限制，也不显示额度
assert.equal((await admin.req('GET', '/api/ai/settings')).data.shared.credit, null);
assert.equal((await user.req('PATCH', `/api/admin/users/${uid}`, { aiCredit: 100 })).status, 403);
await user.req('DELETE', `/api/projects/${upid}`);
ok('used-up credit blocks the server model with a clear message; own keys, admins and the default are unaffected');

console.log('ALL AI SETTINGS TESTS PASSED');
