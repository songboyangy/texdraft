// 编辑记录端到端测试：浏览器（Hocuspocus 连接）里的连续输入合并成一条、删除第 1 行能被定位到；
// 服务端写入（上传）单独记录来源；只记元数据；非成员看不到。
// 用法：node scripts/e2e/edit-log.mjs（需先启动服务端；a@test.dev 存在，例如 seed.mjs 之后）
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const load = (req, name) => import(pathToFileURL(req.resolve(name)).href);
const { HocuspocusProvider } = await load(webRequire, '@hocuspocus/provider');
const Y = await load(webRequire, 'yjs');
const { default: WS } = await import('ws');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ok = (m) => console.log(`ok - ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json();
const api = async (path, init = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: { cookie, ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
};

const project = (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `edit log ${Date.now()}` }) })).data;
const main = (await api(`/api/projects/${project.id}/files`)).data.find((f) => f.path === 'main.tex');
const log = async () => (await api(`/api/projects/${project.id}/edit-log`)).data;

// ---- 浏览器编辑：删除第 1 行，再在别处连续输入几次，停顿后合并成一条记录
const ydoc = new Y.Doc();
class CookieWS extends WS { constructor(url, protocols) { super(url, protocols, { headers: { cookie } }); } }
const provider = new HocuspocusProvider({ url: BASE.replace('http', 'ws') + '/collab', name: main.id, document: ydoc, WebSocketPolyfill: CookieWS });
await new Promise((r, j) => { provider.on('synced', r); setTimeout(() => j(new Error('sync timeout')), 8000); });
const text = ydoc.getText('content');
const firstLine = text.toString().split('\n')[0];
assert.match(firstLine, /^\\documentclass/);
text.delete(0, firstLine.length + 1); // 删掉第 1 行（含换行）
// 浏览器同时上报 CodeMirror 的操作类型（这里模拟“删除整行”）
assert.equal((await api(`/api/projects/${project.id}/edit-log/hint`, { method: 'POST', body: JSON.stringify({ fileId: main.id, event: 'delete.line' }) })).status, 200);
assert.equal((await api(`/api/projects/${project.id}/edit-log/hint`, { method: 'POST', body: JSON.stringify({ fileId: main.id, event: 'not a valid event!' }) })).status, 200);
for (const ch of 'abc') {
  text.insert(text.length, ch);
  await sleep(150);
}
await sleep(500);
assert.deepEqual(await log(), [], 'nothing is written while the user is still typing');
await sleep(5_500); // 停顿超过 5 秒后写入
const rows = await log();
assert.equal(rows.length, 1, JSON.stringify(rows));
const r = rows[0];
assert.equal(r.source, 'editor');
assert.equal(r.userId, me.id);
assert.equal(r.userName, me.name);
assert.equal(r.path, 'main.tex');
assert.equal(r.deletedChars, firstLine.length + 1);
assert.equal(r.deletedLines, 1);
assert.equal(r.insertedChars, 3);
assert.equal(r.fromLine, 1, 'the deletion is located at line 1');
assert.equal(r.origin, 'delete.line', 'the reported editor operation is stored (invalid ones ignored)');
assert.ok(!JSON.stringify(r).includes('documentclass'), 'no document content is stored');
provider.destroy();
ok('browser edits are merged per user and pinpoint a deleted first line');

// ---- 服务端写入：上传覆盖文本文件，单独一条，标记来源
const fd = new FormData();
fd.append('file', new Blob(['\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n']), 'main.tex');
assert.equal((await api(`/api/projects/${project.id}/upload`, { method: 'POST', body: fd })).status, 200);
await sleep(500);
const after = await log();
assert.equal(after.length, 2, JSON.stringify(after));
assert.equal(after[0].source, 'server');
assert.equal(after[0].origin, 'upload');
assert.equal(after[0].userId, null);
ok('server-side writes are logged separately with their origin');

// ---- 非成员看不到
const other = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `log-${Date.now()}@e2e.test`, name: 'x', password: 'password123' }) });
const otherCookie = other.headers.get('set-cookie')?.split(';')[0];
if (otherCookie) {
  const s = await fetch(`${BASE}/api/projects/${project.id}/edit-log`, { headers: { cookie: otherCookie } });
  assert.ok([403, 404].includes(s.status), `non-member got ${s.status}`);
  ok('non-members cannot read the edit log');
}

await api(`/api/projects/${project.id}`, { method: 'DELETE' });
console.log('ALL EDIT LOG TESTS PASSED');
process.exit(0);
