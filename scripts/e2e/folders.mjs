// 文件夹与项目重命名端到端测试：REST 接口（新建空文件夹、重命名 / 移动、删除）、MCP 工具（create_folder / move_folder /
// delete_folder / list_files / update_project 改名）、zip 导出导入保留空文件夹、copy_project 复制空文件夹。
// 用法：node scripts/e2e/folders.mjs（需先启动服务端，并存在 a@test.dev / password123 用户）
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ok = (m) => console.log(`ok - ${m}`);

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), cookie, ...(init.headers ?? {}) } });
const json = async (p, init) => {
  const r = await api(p, init);
  const body = await r.json();
  return { status: r.status, body };
};
const tok = (await json('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'folders e2e' }) })).body;

let rpc = 0;
async function call(name, args = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = (await r.json()).result;
  return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
}
const must = async (name, args) => {
  const r = await call(name, args);
  assert.ok(!r.isError, `${name} failed: ${r.text}`);
  return r.text;
};
const created = [];
const files = async (pid) => (await json(`/api/projects/${pid}/files`)).body.map((f) => f.path).sort();
const folders = async (pid) => (await json(`/api/projects/${pid}/folders`)).body;

try {
  // ---------------- REST ----------------
  const p = (await json('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Folders e2e' }) })).body;
  created.push(p.id);
  const P = `/api/projects/${p.id}`;

  let r = await json(`${P}/folders`, { method: 'POST', body: JSON.stringify({ path: 'sections/' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { path: 'sections', created: true });
  r = await json(`${P}/folders`, { method: 'POST', body: JSON.stringify({ path: 'sections' }) });
  assert.equal(r.body.created, false, 'creating an existing folder is a no-op');
  assert.deepEqual(await folders(p.id), ['sections']);
  ok('create an empty folder (idempotent, trailing slash allowed)');

  r = await json(`${P}/folders`, { method: 'POST', body: JSON.stringify({ path: 'main.tex/x' }) });
  assert.equal(r.status, 409, 'a file cannot be used as a folder');
  r = await json(`${P}/folders`, { method: 'POST', body: JSON.stringify({ path: '../escape' }) });
  assert.equal(r.status, 400, 'paths cannot escape the project');
  r = await json(`${P}/files`, { method: 'POST', body: JSON.stringify({ path: 'sections', content: '' }) });
  assert.equal(r.status, 409, 'a file cannot take the path of an empty folder');
  ok('folder / file path conflicts are rejected');

  await json(`${P}/files`, { method: 'POST', body: JSON.stringify({ path: 'sections/intro.tex', content: 'Intro' }) });
  await json(`${P}/files`, { method: 'POST', body: JSON.stringify({ path: 'sections/deep/a.tex', content: 'A' }) });
  await json(`${P}/folders`, { method: 'POST', body: JSON.stringify({ path: 'sections/empty' }) });
  await api(P, { method: 'PATCH', body: JSON.stringify({ mainFile: 'sections/intro.tex' }) });

  r = await json(`${P}/folders`, { method: 'PATCH', body: JSON.stringify({ from: 'sections', to: 'sections/inner' }) });
  assert.equal(r.status, 400, 'cannot move a folder into itself');
  await json(`${P}/folders`, { method: 'POST', body: JSON.stringify({ path: 'taken' }) });
  r = await json(`${P}/folders`, { method: 'PATCH', body: JSON.stringify({ from: 'sections', to: 'taken' }) });
  assert.equal(r.status, 409, 'cannot move onto an existing folder');

  r = await json(`${P}/folders`, { method: 'PATCH', body: JSON.stringify({ from: 'sections', to: 'chapters/main' }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 2);
  assert.deepEqual(await files(p.id), ['chapters/main/deep/a.tex', 'chapters/main/intro.tex', 'main.tex']);
  assert.deepEqual(await folders(p.id), ['chapters/main', 'chapters/main/empty', 'taken']);
  assert.equal((await json(P)).body.mainFile, 'chapters/main/intro.tex', 'main file follows the move');
  const intro = (await json(`${P}/files`)).body.find((f) => f.path === 'chapters/main/intro.tex');
  assert.equal(await (await api(`${P}/files/${intro.id}/raw`)).text(), 'Intro', 'file content survives the move');
  ok('rename / move a folder with its files, empty subfolders and the main file');

  // ---------------- zip 导出导入保留空文件夹 ----------------
  const zip = await (await api(`${P}/download`)).arrayBuffer();
  const fd = new FormData();
  fd.append('file', new Blob([zip], { type: 'application/zip' }), 'folders.zip');
  const imp = (await json('/api/projects/import', { method: 'POST', body: fd })).body;
  created.push(imp.id);
  assert.deepEqual((await folders(imp.id)).sort(), ['chapters/main/empty', 'taken']);
  ok('zip export / import keeps empty folders');

  r = await json(`${P}/folders?path=${encodeURIComponent('chapters')}`, { method: 'DELETE' });
  assert.equal(r.body.deleted, 2);
  assert.deepEqual(await files(p.id), ['main.tex']);
  assert.deepEqual(await folders(p.id), ['taken']);
  assert.equal((await json(P)).body.mainFile, 'main.tex', 'main file falls back to main.tex when its folder is deleted');
  r = await json(`${P}/folders?path=nope`, { method: 'DELETE' });
  assert.equal(r.status, 404);
  ok('delete a folder with everything in it; unknown folder is 404');

  // ---------------- MCP ----------------
  const list = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/list' }),
  });
  const tools = Object.fromEntries((await list.json()).result.tools.map((t) => [t.name, t]));
  for (const n of ['create_folder', 'move_folder', 'delete_folder']) assert.ok(tools[n], `missing tool ${n}`);
  assert.equal(tools.delete_folder.annotations.destructiveHint, true);
  assert.equal(tools.create_folder.annotations.idempotentHint, true);
  ok('MCP exposes create_folder / move_folder / delete_folder with annotations');

  const project = p.id;
  assert.match(await must('create_folder', { project, path: 'figures/plots' }), /Created folder figures\/plots\//);
  assert.match(await must('create_folder', { project, path: 'figures' }), /already exists/);
  assert.match(await must('list_files', { project }), /figures\/plots\/\tfolder \(empty\)/);
  await must('write_file', { project, path: 'figures/plots/p.tex', content: 'plot' });
  assert.match(await must('move_folder', { project, from: 'figures', to: 'img' }), /Moved folder figures\/ to img\/ \(1 file\)/);
  assert.deepEqual(await files(p.id), ['img/plots/p.tex', 'main.tex']);
  assert.ok((await call('move_folder', { project, from: 'missing', to: 'x' })).isError, 'moving a missing folder is an error');
  assert.match(await must('delete_folder', { project, path: 'img' }), /Deleted folder img\/ \(1 file\)/);
  assert.deepEqual(await files(p.id), ['main.tex']);
  ok('MCP create_folder / list_files / move_folder / delete_folder');

  assert.match(await must('update_project', { project, name: 'Renamed via MCP' }), /Name: Renamed via MCP/);
  assert.equal((await json(P)).body.name, 'Renamed via MCP');
  r = await json(P, { method: 'PATCH', body: JSON.stringify({ name: '  Renamed via REST  ' }) });
  assert.equal((await json(P)).body.name, 'Renamed via REST');
  ok('rename the project over MCP (update_project) and REST');

  const copy = await must('copy_project', { project, name: 'Folders copy' });
  const copyId = /id ([0-9a-f-]{36})/.exec(copy)[1];
  created.push(copyId);
  assert.deepEqual(await folders(copyId), ['taken']);
  ok('copy_project copies empty folders');

  console.log('ALL FOLDER TESTS PASSED');
} finally {
  for (const id of created) await api(`/api/projects/${id}`, { method: 'DELETE' });
  await api(`/api/tokens/${tok.summary.id}`, { method: 'DELETE' });
}
