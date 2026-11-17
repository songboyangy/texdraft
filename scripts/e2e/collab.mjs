// 协作链路端到端测试：模拟浏览器的 Hocuspocus 连接
// 用法：node scripts/e2e/collab.mjs（需先启动服务端，并存在 a@test.dev 用户的 Demo 项目）
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// 依赖从各自的 workspace 包解析（脚本本身不在任何包内）
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const load = (req, name) => import(pathToFileURL(req.resolve(name)).href);
const { HocuspocusProvider } = await load(webRequire, '@hocuspocus/provider');
const Y = await load(webRequire, 'yjs');
const { default: WS } = await import('ws');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok -', m); };

const cookie = await login();
const api = (path, init = {}) => fetch(BASE + path, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
const projects = await (await api('/api/projects')).json();
const pid = projects.find((p) => p.name === 'Demo').id;
const files = await (await api(`/api/projects/${pid}/files`)).json();
const main = files.find((f) => f.path === 'main.tex');

function connect(cookieHeader) {
  const ydoc = new Y.Doc();
  class CookieWS extends WS { constructor(url, protocols) { super(url, protocols, { headers: { cookie: cookieHeader } }); } }
  const provider = new HocuspocusProvider({ url: BASE.replace('http', 'ws') + '/collab', name: main.id, document: ydoc, WebSocketPolyfill: CookieWS });
  const synced = new Promise((r, j) => { provider.on('synced', r); setTimeout(() => j(new Error('sync timeout')), 8000); });
  return { ydoc, provider, synced };
}

// 1) 未登录连接应被拒绝
{
  const c = connect('');
  const res = await c.synced.then(() => 'synced', () => 'rejected');
  c.provider.destroy();
  assert(res === 'rejected', 'unauthenticated websocket is rejected');
}

// 2) 两个客户端同步与互相可见
const a = connect(cookie);
const b = connect(cookie);
await Promise.all([a.synced, b.synced]);
const ta = a.ydoc.getText('content');
const tb = b.ydoc.getText('content');
assert(ta.toString().startsWith('\\documentclass'), 'client A synced document content');
ta.insert(ta.length, '\n% edited by client A\n');
await new Promise((r) => setTimeout(r, 500));
assert(tb.toString().includes('% edited by client A'), 'client B received A\'s edit live');

// 3) 服务端读取的是活动文档（API 读到最新内容）
const raw = await (await api(`/api/projects/${pid}/files/${main.id}/raw`)).text();
assert(raw.includes('% edited by client A'), 'REST API reads the live collaborative document');

// 4) 服务端写入（上传覆盖 = transactText）实时推送给在线客户端
const fd = new FormData();
fd.append('file', new Blob([raw.replace('Untitled Paper', 'Server Side Title')]), 'main.tex');
await api(`/api/projects/${pid}/upload`, { method: 'POST', body: fd });
await new Promise((r) => setTimeout(r, 500));
assert(ta.toString().includes('Server Side Title') && tb.toString().includes('Server Side Title'), 'server-side write pushed to online clients');
assert(ta.toString().includes('% edited by client A'), 'minimal diff kept the rest of the document');

a.provider.destroy(); b.provider.destroy();
// 5) 断开后持久化（防抖 1s 后写库），重新连接仍能读到
await new Promise((r) => setTimeout(r, 2500));
const c = connect(cookie);
await c.synced;
assert(c.ydoc.getText('content').toString().includes('Server Side Title'), 'document persisted and reloaded');
c.provider.destroy();
console.log('ALL COLLAB TESTS PASSED');
process.exit(0);
