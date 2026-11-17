// 论文工具端到端测试：get_pdf_pages / get_compile_diagnostics / apply_patch / get_project_dependencies / get_citation_context / get_file_diff
// 用法：node scripts/e2e/mcp-paper.mjs（需先启动服务端，并存在 a@test.dev / password123 用户；会真实编译）
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ok = (m) => console.log(`ok - ${m}`);

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });
const tok = await (await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'mcp-paper e2e' }) })).json();

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = (await r.json()).result;
  return { content: res.content, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!res.isError };
}
const must = async (name, args) => {
  const r = await call(name, args);
  assert.ok(!r.isError, `${name} failed: ${r.text}`);
  return r;
};

let pid;
try {
  pid = /id ([0-9a-f-]{36})/.exec((await must('create_project', { name: 'MCP paper e2e' })).text)[1];
  const P = { project: pid };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  // ---- apply_patch：edits 形式，一次建好多个文件
  await must('write_file', { ...P, path: 'main.tex', content: '\\documentclass{article}\n\\usepackage{graphicx}\n\\graphicspath{{figures/}}\n\\begin{document}\n\\title{Patch Test}\\maketitle\n\\input{chapters/intro}\n\\includegraphics[width=2cm]{dot}\n\\includegraphics{nofig}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n' });
  await must('upload_file', { ...P, path: 'figures/dot.png', content_base64: png });
  const created = await must('apply_patch', {
    ...P,
    edits: [
      { path: 'chapters/intro.tex', old_str: '', new_str: '\\section{Introduction}\\label{sec:intro}\nPrior work \\cite{smith2020} is strong. Others disagree \\citep[p.~3]{smith2020,ghost2021}.\n\\badcommand\n' },
      { path: 'refs.bib', old_str: '', new_str: '@article{smith2020, title={Deep Things}, author={Smith, A.}, journal={J}, year={2020}}\n@article{jones2019, title={Unused Paper}, author={Jones, B.}, journal={J}, year={2019}}\n' },
      { path: 'unused.tex', old_str: '', new_str: '% not referenced\n' },
    ],
  });
  assert.match(created.text, /created chapters\/intro\.tex/);
  ok('apply_patch (edits) creates several files in one call');

  // 原子性：一处匹配不上 → 全部不改
  const before = (await must('read_file', { ...P, path: 'main.tex' })).text;
  const bad = await call('apply_patch', {
    ...P,
    edits: [
      { path: 'main.tex', old_str: 'Patch Test', new_str: 'CHANGED' },
      { path: 'refs.bib', old_str: 'this text does not exist', new_str: 'x' },
    ],
  });
  assert.ok(bad.isError && /Nothing was changed/.test(bad.text) && /refs\.bib/.test(bad.text), bad.text);
  assert.equal((await must('read_file', { ...P, path: 'main.tex' })).text, before);
  const ambiguous = await call('apply_patch', { ...P, edits: [{ path: 'refs.bib', old_str: '@article', new_str: '@misc' }] });
  assert.ok(ambiguous.isError && /matches 2 times/.test(ambiguous.text));
  ok('apply_patch is all-or-nothing (failed edit leaves every file untouched; ambiguous match rejected)');

  const dry = await must('apply_patch', { ...P, edits: [{ path: 'main.tex', old_str: 'Patch Test', new_str: 'Dry Run' }], dry_run: true });
  assert.match(dry.text, /Dry run OK/);
  assert.equal((await must('read_file', { ...P, path: 'main.tex' })).text, before);
  ok('apply_patch dry_run validates without changing anything');

  // ---- 编译诊断（\badcommand 是错误）
  const diag = await must('get_compile_diagnostics', { ...P, recompile: true, level: 'error' });
  assert.match(diag.text, /Undefined control sequence/);
  assert.match(diag.text, /chapters\/intro\.tex:3/);
  assert.match(diag.text, />\s+3 \| \\badcommand/);
  assert.match(diag.text, /hint: A command is misspelled/);
  ok('get_compile_diagnostics: file:line, source excerpt with marker and hint');

  // ---- apply_patch：统一 diff，同时修改、新建、删除
  const patch = `--- a/chapters/intro.tex
+++ b/chapters/intro.tex
@@ -1,3 +1,3 @@
 \\section{Introduction}\\label{sec:intro}
 Prior work \\cite{smith2020} is strong. Others disagree \\citep[p.~3]{smith2020,ghost2021}.
-\\badcommand
+See Section~\\ref{sec:method}.
--- /dev/null
+++ b/chapters/method.tex
@@ -0,0 +1,2 @@
+\\section{Method}\\label{sec:method}
+Our method.
--- a/unused.tex
+++ /dev/null
@@ -1 +0,0 @@
-% not referenced
`;
  const applied = await must('apply_patch', { ...P, patch });
  assert.match(applied.text, /modified chapters\/intro\.tex \(\+1 −1\)/);
  assert.match(applied.text, /created chapters\/method\.tex/);
  assert.match(applied.text, /deleted unused\.tex/);
  await must('apply_patch', { ...P, edits: [{ path: 'main.tex', old_str: '\\input{chapters/intro}\n', new_str: '\\input{chapters/intro}\n\\input{chapters/method}\n' }] });
  const stale = await call('apply_patch', { ...P, patch });
  assert.ok(stale.isError && /does not match the current file/.test(stale.text));
  ok('apply_patch (unified diff) modifies, creates and deletes; a stale diff is rejected');

  // ---- 依赖
  const deps = (await must('get_project_dependencies', P)).text;
  assert.match(deps, /^  chapters\/intro\.tex$/m);
  assert.match(deps, /^  chapters\/method\.tex$/m);
  assert.match(deps, /\[figure\] figures\/dot\.png/);
  assert.match(deps, /\[bibliography\] refs\.bib/);
  assert.match(deps, /nofig \(figure at main\.tex:9\)/);
  ok('get_project_dependencies: tree, graphicspath, bibliography, missing figure with file:line');

  // ---- 引用上下文
  const cites = (await must('get_citation_context', P)).text;
  assert.match(cites, /smith2020 — Deep Things \/ Smith, A\./);
  assert.match(cites, /chapters\/intro\.tex:2 \\cite: .*Prior work 【\\cite\{smith2020\}】 is strong/);
  assert.match(cites, /ghost2021 — MISSING/);
  assert.match(cites, /never cited \(1\): jones2019/);
  const one = (await must('get_citation_context', { ...P, key: 'smith2020' })).text;
  assert.match(one, /Citation "smith2020": 2 use\(s\)/);
  ok('get_citation_context: entries, locations with sentence context, missing and uncited keys');

  // ---- PDF 页面（先去掉不存在的图并编译）
  await must('apply_patch', { ...P, edits: [{ path: 'main.tex', old_str: '\\includegraphics{nofig}\n', new_str: '' }] });
  const diag2 = await must('get_compile_diagnostics', { ...P, recompile: true });
  assert.match(diag2.text, /PDF generated/);
  const pages = await must('get_pdf_pages', { ...P, pages: '1' });
  const img = pages.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  assert.equal(Buffer.from(img.data, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.match(pages.text, /Patch Test/);
  assert.match(pages.text, /Introduction/);
  const badPage = await call('get_pdf_pages', { ...P, pages: '99' });
  assert.ok(badPage.isError);
  ok(`get_pdf_pages renders page 1 as PNG (${Buffer.from(img.data, 'base64').length} bytes) with extracted text`);

  // ---- 中文 PDF：CID 字体需要 cMap 才能渲染和提取文字
  await must('update_project', { ...P, engine: 'xelatex' });
  await must('write_file', { ...P, path: 'zh.tex', content: '\\documentclass[UTF8,fontset=fandol]{ctexart}\n\\begin{document}\n\\section{中文标题}\n这是一段中文正文。\n\\end{document}\n' });
  await must('update_project', { ...P, main_file: 'zh.tex' });
  const zd = await must('get_compile_diagnostics', { ...P, recompile: true, level: 'error' });
  assert.match(zd.text, /PDF generated/, zd.text);
  const zp = await must('get_pdf_pages', { ...P, pages: '1' });
  assert.match(zp.text, /中文标题/);
  assert.match(zp.text, /这是一段中文正文/);
  globalThis.__zhPng = zp.content.find((c) => c.type === 'image').data;
  if (process.env.SAVE_ZH_PNG) (await import('node:fs')).writeFileSync(process.env.SAVE_ZH_PNG, Buffer.from(globalThis.__zhPng, 'base64'));
  await must('update_project', { ...P, main_file: 'main.tex', engine: 'pdflatex' });
  ok('get_pdf_pages renders and extracts Chinese text (CID fonts via cMaps)');

  // ---- 差异
  const v = /version ([0-9a-f-]{36})/.exec((await must('save_version', { ...P, label: 'review base' })).text)[1];
  await must('apply_patch', { ...P, edits: [{ path: 'chapters/method.tex', old_str: 'Our method.', new_str: 'Our improved method.' }] });
  const diff = (await must('get_file_diff', P)).text;
  assert.match(diff, /manual "review base"/);
  assert.match(diff, /modified chapters\/method\.tex \(\+1 −1\)/);
  assert.match(diff, /^-Our method\.$/m);
  assert.match(diff, /^\+Our improved method\.$/m);
  const scoped = (await must('get_file_diff', { ...P, version_id: v, path: 'main.tex' })).text;
  assert.match(scoped, /No differences/);
  ok('get_file_diff shows the unified diff since the latest version, filterable by file');

  console.log('ALL MCP PAPER TOOL TESTS PASSED');
} finally {
  if (pid) await api(`/api/projects/${pid}`, { method: 'DELETE' });
  await api(`/api/tokens/${tok.summary.id}`, { method: 'DELETE' });
}
