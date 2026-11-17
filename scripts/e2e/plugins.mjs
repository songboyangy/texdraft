// Server plugins: a plugin loaded through TEXDRAFT_PLUGINS can add routes and replace the quota provider.
// Usage: mock-anthropic.mjs running; server started with
//   TEXDRAFT_PLUGINS=<repo>/scripts/e2e/fixtures/quota-plugin.mjs ANTHROPIC_BASE_URL=http://127.0.0.1:8790 ANTHROPIC_API_KEY=test
// and open registration.
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ok = (m) => console.log(`ok - ${m}`);

let cookie = '';
async function req(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'accept-language': 'en', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.get('set-cookie');
  if (set?.startsWith('tp_session=')) cookie = set.split(';')[0];
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}
async function chat(pid, message) {
  const res = await fetch(`${BASE}/api/projects/${pid}/agent/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ message, context: {} }) });
  const events = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  return events.at(-1);
}
const calls = async () => (await req('GET', '/api/_test_plugin/calls')).data;

const c0 = await calls();
assert.ok(c0 && typeof c0.check === 'number', 'the plugin registered its route');
ok('plugin loaded and its routes are served');

assert.equal((await req('POST', '/api/auth/register', { email: `plugin-${Date.now().toString(36)}@e2e.test`, name: 'plugin user', password: 'password123' })).status, 200);
const me = (await req('GET', '/api/auth/me')).data;
const pid = (await req('POST', '/api/projects', { name: 'plugin e2e' })).data.id;

assert.equal((await chat(pid, 'PING through plugin')).status, 'completed');
assert.ok((await req('GET', '/api/ai/settings')).data.shared.available);
const c1 = await calls();
assert.ok(c1.check > c0.check && c1.record > c0.record && c1.status > c0.status, JSON.stringify({ c0, c1 }));
ok('server-key requests go through the plugin quota provider (check, record, status)');

await req('POST', '/api/_test_plugin/block', { userId: me.id });
const blocked = await chat(pid, 'PING while blocked');
assert.equal(blocked.status, 'error', JSON.stringify(blocked));
assert.match(blocked.error, /Blocked by test plan/);
ok('the provider can refuse a user; the message reaches the chat');

await req('POST', '/api/_test_plugin/block', { userId: null });
await req('DELETE', `/api/projects/${pid}`);
console.log('ALL PLUGIN TESTS PASSED');
