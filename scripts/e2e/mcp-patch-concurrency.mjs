// apply_patch 与协作者并发编辑：协作者离线时改了中间一行，AI 同时用 apply_patch 改首尾两行，重连后两边的修改都应保留
// 用法：node scripts/e2e/mcp-patch-concurrency.mjs（需先启动服务端，并存在 a@test.dev / password123 用户）
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const load = (name) => import(pathToFileURL(webRequire.resolve(name)).href);
const { HocuspocusProvider } = await load('@hocuspocus/provider');
const Y = await load('yjs');
const { default: WS } = await import('ws');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });
const tok = await (await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'patch concurrency e2e' }) })).json();
let rpc = 0;
const call = async (name, args) => {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = (await r.json()).result;
  assert.ok(!res.isError, res.content[0].text);
  return res.content[0].text;
};

let pid;
let provider;
try {
  pid = /id ([0-9a-f-]{36})/.exec(await call('create_project', { name: 'patch concurrency e2e' }))[1];
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  await call('write_file', { project: pid, path: 'doc.tex', content: lines.join('\n') + '\n' });
  const files = await (await api(`/api/projects/${pid}/files`)).json();
  const doc = files.find((f) => f.path === 'doc.tex');

  const ydoc = new Y.Doc();
  class CookieWS extends WS { constructor(url, protocols) { super(url, protocols, { headers: { cookie } }); } }
  provider = new HocuspocusProvider({ url: BASE.replace('http', 'ws') + '/collab', name: doc.id, document: ydoc, WebSocketPolyfill: CookieWS });
  await new Promise((r, j) => { provider.on('synced', r); setTimeout(() => j(new Error('sync timeout')), 8000); });
  const ytext = ydoc.getText('content');

  // 协作者断网，在第 10 行末尾追加内容（服务端暂时不知道）
  provider.disconnect();
  const at = ytext.toString().indexOf('line 10') + 'line 10'.length;
  ytext.insert(at, ' (edited offline by collaborator)');

  // 与此同时 AI 修改第 1 行和第 20 行
  await call('apply_patch', { project: pid, edits: [{ path: 'doc.tex', old_str: 'line 1\n', new_str: 'LINE ONE (AI)\n' }, { path: 'doc.tex', old_str: 'line 20\n', new_str: 'LINE TWENTY (AI)\n' }] });

  // 协作者恢复连接并同步
  await provider.connect();
  await new Promise((r) => setTimeout(r, 1500));
  const merged = await call('read_file', { project: pid, path: 'doc.tex' });
  assert.match(merged, /LINE ONE \(AI\)/);
  assert.match(merged, /LINE TWENTY \(AI\)/);
  assert.match(merged, /line 10 \(edited offline by collaborator\)/);
  assert.equal(ytext.toString(), (await (await api(`/api/projects/${pid}/files/${doc.id}/raw`)).text()));
  console.log('ok - apply_patch keeps a collaborator\'s concurrent edit between the patched lines; both sides converge');
  console.log('ALL PATCH CONCURRENCY TESTS PASSED');
} finally {
  provider?.destroy();
  if (pid) await api(`/api/projects/${pid}`, { method: 'DELETE' });
  await api(`/api/tokens/${tok.summary.id}`, { method: 'DELETE' });
}
