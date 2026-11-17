// MCP 项目 / 文件管理工具端到端测试：新建、复制项目，设置，复制 / 上传文件，全项目替换，大纲，历史版本。
// 用法：node scripts/e2e/mcp-more.mjs（需先启动服务端，并存在 a@test.dev / password123 用户）
//   URL_UPLOAD=0 可跳过需要外网的 URL 上传用例
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ok = (m) => console.log(`ok - ${m}`);

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });
const tok = await (await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'mcp-more e2e' }) })).json();

let id = 0;
async function call(name, args = {}, token = tok.token) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
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

try {
  const list = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/list' }),
  });
  const tools = Object.fromEntries((await list.json()).result.tools.map((t) => [t.name, t]));
  for (const n of ['create_project', 'copy_project', 'get_project', 'update_project', 'copy_file', 'upload_file', 'replace_in_project', 'get_outline', 'list_versions', 'save_version', 'restore_version']) assert.ok(tools[n], `missing tool ${n}`);
  assert.deepEqual(tools.upload_file._meta['openai/fileParams'], ['file']);
  assert.equal(tools.get_outline.annotations.readOnlyHint, true);
  assert.equal(tools.replace_in_project.annotations.destructiveHint, true);
  ok(`tools/list exposes ${Object.keys(tools).length} tools with annotations and fileParams`);

  const c = await must('create_project', { name: 'MCP e2e project' });
  const pid = /id ([0-9a-f-]{36})/.exec(c)[1];
  created.push(pid);
  assert.match(await must('read_file', { project: pid, path: 'main.tex' }), /documentclass/);
  ok('create_project makes a project with a starter main.tex');

  await must('write_file', { project: pid, path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\\label{sec:intro}\nHello Wrold. Wrold again.\n\\subsection{Details}\n\\input{chapters/a}\n\\end{document}\n' });
  await must('write_file', { project: pid, path: 'chapters/a.tex', content: '\\section{Method}\\label{sec:method}\nThe Wrold is round.\n' });
  await must('write_file', { project: pid, path: 'refs.bib', content: '@article{smith2020, title={T}, author={S}, year={2020}}\n' });

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  assert.match(await must('upload_file', { project: pid, path: 'figures/dot.png', content_base64: png.toString('base64') }), /figures\/dot\.png \(binary/);
  assert.match(await must('upload_file', { project: pid, path: 'notes.txt', content_base64: Buffer.from('plain notes').toString('base64') }), /notes\.txt \(text/);
  assert.match(await must('read_file', { project: pid, path: 'notes.txt' }), /plain notes/);
  ok('upload_file (base64): binary image + text file that becomes editable');

  const priv = await call('upload_file', { project: pid, path: 'x.bin', url: 'https://127.0.0.1/secret' });
  assert.ok(priv.isError && /private|local/.test(priv.text), priv.text);
  const http = await call('upload_file', { project: pid, path: 'x.bin', url: 'http://example.com/a.png' });
  assert.ok(http.isError && /https/.test(http.text));
  const two = await call('upload_file', { project: pid, path: 'x.bin', url: 'https://example.com', content_base64: 'AA==' });
  assert.ok(two.isError && /exactly one/.test(two.text));
  ok('upload_file rejects private addresses, plain http and ambiguous sources');

  if (process.env.URL_UPLOAD !== '0') {
    const fromUrl = await must('upload_file', { project: pid, path: 'figures/', url: 'https://www.google.com/favicon.ico' });
    assert.match(fromUrl, /figures\/favicon\.ico/);
    // ChatGPT 附件对象（download_url + file_name）
    const att = await must('upload_file', { project: pid, path: 'figures/', file: { download_url: 'https://www.google.com/favicon.ico', file_id: 'file_123', file_name: 'logo.ico', mime_type: 'image/x-icon' } });
    assert.match(att, /figures\/logo\.ico/);
    ok('upload_file from https URL and from a ChatGPT file attachment (keeps file name for folder targets)');
  }

  await must('copy_file', { project: pid, from: 'figures/dot.png', to: 'figures/dot-copy.png' });
  await must('copy_file', { project: pid, from: 'chapters/a.tex', to: 'chapters/b.tex' });
  assert.match(await must('read_file', { project: pid, path: 'chapters/b.tex' }), /Method/);
  const dup = await call('copy_file', { project: pid, from: 'refs.bib', to: 'chapters/b.tex' });
  assert.ok(dup.isError && /overwrite/.test(dup.text));
  ok('copy_file copies text and binary files and refuses to overwrite by default');

  const rep = await must('replace_in_project', { project: pid, query: 'Wrold', replacement: 'World', whole_word: true });
  assert.match(rep, /Replaced 4 occurrence\(s\) in 3 file\(s\)/);
  assert.match(await must('read_file', { project: pid, path: 'main.tex' }), /Hello World\. World again\./);
  ok('replace_in_project fixes a typo across files');

  const outline = await must('get_outline', { project: pid });
  assert.match(outline, /Intro\s+\(main\.tex:3\)/);
  assert.match(outline, /Method\s+\(chapters\/a\.tex:1\)/);
  assert.match(outline, /sec:intro/);
  assert.match(outline, /smith2020/);
  ok('get_outline lists sections, labels and BibTeX keys');

  await must('update_project', { project: pid, name: 'MCP e2e renamed', engine: 'xelatex' });
  const info = await must('get_project', { project: pid });
  assert.match(info, /MCP e2e renamed/);
  assert.match(info, /Engine: xelatex/);
  const badEngine = await call('update_project', { project: pid, engine: 'tex' });
  assert.ok(badEngine.isError);
  ok('update_project / get_project (rename, engine)');

  const saved = await must('save_version', { project: pid, label: 'before cleanup' });
  const vid = /version ([0-9a-f-]{36})/.exec(saved)[1];
  await must('delete_file', { project: pid, path: 'chapters/b.tex' });
  await must('str_replace', { project: pid, path: 'main.tex', old_str: 'Hello World.', new_str: 'Bye.' });
  const versions = await must('list_versions', { project: pid });
  assert.match(versions, /before cleanup/);
  assert.match(versions, /MCP: mcp-more e2e/); // 首次修改前的检查点
  const restored = await must('restore_version', { project: pid, version_id: vid });
  assert.match(restored, /Restored 2 file\(s\)/);
  assert.match(await must('read_file', { project: pid, path: 'main.tex' }), /Hello World\./);
  assert.match(await must('read_file', { project: pid, path: 'chapters/b.tex' }), /Method/);
  ok('save_version / list_versions / restore_version (restores edits and deleted files)');

  const cp = await must('copy_project', { project: pid, name: 'MCP e2e copy' });
  const copyId = /id ([0-9a-f-]{36})/.exec(cp)[1];
  created.push(copyId);
  const srcFiles = (await (await api(`/api/projects/${pid}/files`)).json()).map((f) => f.path).sort();
  const copyFiles = (await (await api(`/api/projects/${copyId}/files`)).json()).map((f) => f.path).sort();
  assert.deepEqual(copyFiles, srcFiles);
  assert.match(await must('get_project', { project: copyId }), /Engine: xelatex/);
  assert.match(await must('read_file', { project: copyId, path: 'main.tex' }), /Hello World\./);
  // 复制后的二进制文件独立：在副本里覆盖不影响原项目
  await must('upload_file', { project: copyId, path: 'figures/dot.png', content_base64: Buffer.from('changed').toString('base64') });
  const origPng = await (await api(`/api/projects/${pid}/files`)).json();
  assert.equal(origPng.find((f) => f.path === 'figures/dot.png').size, png.length);
  ok(`copy_project duplicates all ${copyFiles.length} files and settings; binaries are independent copies`);

  const scoped = await (await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'scoped e2e', projectId: pid }) })).json();
  const denied = await call('create_project', { name: 'nope' }, scoped.token);
  assert.ok(denied.isError && /bound to a single project/.test(denied.text));
  await api(`/api/tokens/${scoped.summary.id}`, { method: 'DELETE' });
  ok('project-scoped tokens cannot create projects');

  console.log('ALL MCP PROJECT TOOL TESTS PASSED');
} finally {
  for (const p of created) await api(`/api/projects/${p}`, { method: 'DELETE' });
  await api(`/api/tokens/${tok.summary.id}`, { method: 'DELETE' });
}
