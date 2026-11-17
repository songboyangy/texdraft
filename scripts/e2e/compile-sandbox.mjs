// 编译沙箱端到端测试：LaTeX 文档不能读取项目以外的文件（服务端 .env、其他目录），正常编译（含中文）不受影响
// 用法：node scripts/e2e/compile-sandbox.mjs（需先启动服务端，并存在 a@test.dev / password123 用户）
// 测试只检查“能否读到”，不会把 .env 的内容打印出来。
// 在 docker 中测试时：ENV_PROBE=/proc/1/environ CANARY_PATH=/data/blobs/canary.tex CANARY_WRITE=0（诱饵文件由外部写入容器）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const DATA = process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : path.join(ROOT, 'data');
const ok = (m) => console.log(`ok - ${m}`);

const CANARY = 'CANARYXYZZY';
// 默认：项目编译目录的上一级 data/compile/canary.tex
const canaryPath = process.env.CANARY_PATH ?? path.join(DATA, 'compile', 'canary.tex');
const writeCanary = process.env.CANARY_WRITE !== '0';
if (writeCanary) fs.writeFileSync(canaryPath, `${CANARY}\n`);

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });
const tok = await (await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'sandbox e2e' }) })).json();
let rpc = 0;
const call = async (name, args) => {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = (await r.json()).result;
  return { text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!res.isError };
};

let pid;
try {
  pid = /id ([0-9a-f-]{36})/.exec((await call('create_project', { name: 'sandbox e2e' })).text)[1];
  const envFile = process.env.ENV_PROBE ?? path.join(ROOT, '.env');
  if (!process.env.ENV_PROBE) assert.ok(fs.existsSync(envFile), 'test expects the server .env to exist');
  // 每个探测都输出 LEAK-x 或 SAFE-x 标记；\input 失败时 continue-on-errors 仍会生成 PDF
  const tex = String.raw`\documentclass{article}
\begin{document}
Probe A: \IfFileExists{${envFile}}{LEAK-A}{SAFE-A}.

Probe B: \IfFileExists{${canaryPath}}{LEAK-B}{SAFE-B}.

Probe C: \IfFileExists{../../canary.tex}{LEAK-C}{SAFE-C}.

Probe D: \IfFileExists{/etc/shadow}{LEAK-D}{SAFE-D}.

Probe E: \IfFileExists{${process.env.HOME}/.ssh/known_hosts}{LEAK-E}{SAFE-E}.

Probe F: \IfFileExists{${canaryPath}}{\input{${canaryPath}}}{SAFE-F}

Normal text survives: SANDBOX-OK.
\end{document}
`;
  await call('write_file', { project: pid, path: 'main.tex', content: tex });
  const diag = await call('get_compile_diagnostics', { project: pid, recompile: true, level: 'error' });
  assert.match(diag.text, /PDF generated/, diag.text);
  const pages = await call('get_pdf_pages', { project: pid, pages: '1' });
  const t = pages.text;
  assert.match(t, /SANDBOX-OK/);
  for (const x of ['A', 'B', 'C', 'D', 'E', 'F']) {
    assert.ok(!t.includes(`LEAK-${x}`), `probe ${x} could see a file outside the project`);
    assert.ok(t.includes(`SAFE-${x}`), `probe ${x} did not render`);
  }
  assert.ok(!t.includes(CANARY), '\\input of a file outside the project leaked its content');
  ok(`files outside the project are invisible (${envFile}, ${canaryPath} via absolute and ../ paths, ~/.ssh, /etc/shadow)`);

  // 正常文档（中文 + 常用宏包 + 子目录 \input）照常编译；ctex 需要 xelatex（tectonic 固定为 XeTeX）
  await call('update_project', { project: pid, engine: 'xelatex' });
  await call('write_file', { project: pid, path: 'main.tex', content: String.raw`\documentclass[UTF8,fontset=fandol]{ctexart}
\usepackage{amsmath,graphicx,booktabs}
\begin{document}
\section{中文标题}
\input{chapters/a}
$\sum_{i=1}^n x_i$
\end{document}
` });
  await call('write_file', { project: pid, path: 'chapters/a.tex', content: '子目录内容 Sub-file OK.\n' });
  const d2 = await call('get_compile_diagnostics', { project: pid, recompile: true, level: 'error' });
  assert.match(d2.text, /PDF generated/, d2.text);
  assert.match(d2.text, /0 error\(s\)/, d2.text);
  const p2 = await call('get_pdf_pages', { project: pid, pages: '1' });
  assert.match(p2.text, /Sub-file OK/);
  assert.match(p2.text, /中文标题/);
  ok('normal compile inside the sandbox works (ctex Chinese fonts, sub-directory \\input, math)');

  console.log('ALL SANDBOX TESTS PASSED');
} finally {
  if (writeCanary) fs.rmSync(canaryPath, { force: true });
  if (pid) await api(`/api/projects/${pid}`, { method: 'DELETE' });
  await api(`/api/tokens/${tok.summary.id}`, { method: 'DELETE' });
}
