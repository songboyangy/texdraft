// 内置 Agent 使用统一工具注册表：并行的只读调用、PDF 页面（图片结果）、apply_patch 多处原子修改
// 用法：先启动 mock-anthropic.mjs，服务端以 ANTHROPIC_BASE_URL=http://127.0.0.1:8790 ANTHROPIC_API_KEY=test 启动；
//       需要 seed.mjs 准备的 Demo 项目。MOCK=http://127.0.0.1:8790 可改模拟服务地址。
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:8790';
const ok = (m) => console.log(`ok - ${m}`);

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (p, init = {}) => (await fetch(`${BASE}${p}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })).json();
const pid = (await api('/api/projects')).find((p) => p.name === 'Demo').id;

// 先编译一次，保证 get_pdf_pages 有 PDF 可看
await api(`/api/projects/${pid}/compile`, { method: 'POST', body: '{}' });

const res = await fetch(`${BASE}/api/projects/${pid}/agent/chat`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ message: 'TOOLS check', context: {} }),
});
const events = [];
let buf = '';
const dec = new TextDecoder();
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
    buf = buf.slice(i + 2);
    if (line) events.push(JSON.parse(line.slice(6)));
  }
}
const fin = events.find((e) => e.type === 'run_finished');
assert.equal(fin?.status, 'completed', JSON.stringify(fin));

const ends = events.filter((e) => e.type === 'tool_end');
const byName = Object.fromEntries(ends.map((e) => [e.name, e]));
for (const n of ['get_outline', 'get_project_dependencies', 'grep', 'get_pdf_pages', 'apply_patch']) assert.ok(byName[n]?.ok, `${n}: ${JSON.stringify(byName[n])}`);
ok('built-in agent can use registry tools (outline, dependencies, PDF pages, apply_patch)');

// 只读调用的 tool_input 事件先全部发出，再并行执行
const firstBatch = events.filter((e) => ['tool_input', 'tool_end'].includes(e.type) && e.name !== 'apply_patch').map((e) => e.type);
assert.deepEqual(firstBatch.slice(0, 4), ['tool_input', 'tool_input', 'tool_input', 'tool_input']);
ok('read-only calls are dispatched together');

// 模型实际收到的内容：图片结果（Claude 接口支持看图）与按顺序返回的结果
const reqs = await (await fetch(`${MOCK}/_requests`)).json();
const mine = reqs.filter((r) => JSON.stringify(r.body.messages).includes('TOOLS check'));
let toolNames;
if (process.env.PROVIDER === 'openai') {
  const step1 = mine.find((r) => r.body.messages.some((m) => m.role === 'tool'));
  const toolMsgs = step1.body.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 4);
  const imgMsg = step1.body.messages.at(-1);
  assert.ok(imgMsg.role === 'user' && imgMsg.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')), 'PDF page sent as an image part after the tool messages');
  toolNames = step1.body.tools.map((t) => t.function.name);
} else {
  const step1 = mine.find((r) => r.body.messages.at(-1).content.some?.((b) => b.type === 'tool_result'));
  const pdfResult = step1.body.messages.at(-1).content[3];
  assert.ok(Array.isArray(pdfResult.content) && pdfResult.content.some((c) => c.type === 'image' && c.source.media_type === 'image/png'), 'PDF page is sent to the model as an image');
  toolNames = step1.body.tools.map((t) => t.name);
}
for (const n of ['get_pdf_pages', 'apply_patch', 'search_citations', 'get_citation_context']) assert.ok(toolNames.includes(n), `agent is offered ${n}`);
for (const n of ['list_projects', 'create_project', 'restore_version']) assert.ok(!toolNames.includes(n), `agent is not offered ${n}`);
ok(`model receives the PDF page as an image; ${toolNames.length} tools offered (project-only subset)`);

// apply_patch 的改动计入本次运行（改动汇总 + 可撤销）
const paths = fin.changes.map((c) => c.path).sort();
assert.deepEqual(paths, ['main.tex', 'notes.tex']);
await api(`/api/projects/${pid}/agent/runs/${fin.runId}/revert`, { method: 'POST', body: '{}' });
const files = await api(`/api/projects/${pid}/files`);
assert.ok(!files.some((f) => f.path === 'notes.tex'), 'revert removed the created file');
ok('apply_patch changes are tracked in the run summary and reverted by undo');

console.log('ALL AGENT TOOL TESTS PASSED');
