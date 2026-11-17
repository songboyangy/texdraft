// MCP 端到端测试：用官方 MCP 客户端模拟本地 Agent（Claude Code / Codex 等）操作 TeXdraft 项目。
// 用法：node scripts/e2e/mcp.mjs   （需服务端已启动，存在 a@test.dev / password123 的 Demo 项目）
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const req = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const load = (name) => import(pathToFileURL(req.resolve(name)).href);
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await load('@modelcontextprotocol/sdk/client/streamableHttp.js');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok -', m); };

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (path, init = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};
const project = (await api('/api/projects')).find((p) => p.name === 'Demo');

// 1. 无令牌 / 错误令牌被拒绝
for (const auth of [undefined, 'Bearer tp_wrongwrongwrongwrongwrongwrong']) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert(r.status === 401, `request ${auth ? 'with a wrong token' : 'without a token'} is rejected (401)`);
}

// 2. 创建限定到 Demo 项目的令牌
const { token, summary } = await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'e2e test', projectId: project.id }) });
assert(token.startsWith('tp_') && summary.projectName === 'Demo', 'project-scoped token created');

const connect = async (tok) => {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }));
  return client;
};
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content.map((c) => c.text).join('\n') };
};

const client = await connect(token);
assert(/TeXdraft/.test(client.getInstructions() ?? ''), 'server instructions delivered');
const tools = (await client.listTools()).tools.map((t) => t.name);
assert(['list_projects', 'read_file', 'str_replace', 'compile', 'search_citations', 'add_citation'].every((n) => tools.includes(n)), `tools listed: ${tools.join(', ')}`);

const projects = await call(client, 'list_projects');
assert(projects.text.includes('Demo') && projects.text.split('\n').length === 1, 'scoped token only sees its project');

const main = await call(client, 'read_file', { path: 'main.tex' });
assert(!main.error && /\\documentclass/.test(main.text), 'read_file works without passing "project" (token is scoped)');

// 3. 写入：自动打检查点，修改实时生效
const before = (await api(`/api/projects/${project.id}/versions`)).length;
const edit = await call(client, 'str_replace', { path: 'main.tex', old_str: '\\begin{abstract}', new_str: '\\begin{abstract}\n% edited via MCP' });
assert(!edit.error && edit.text.includes('Replaced 1'), 'str_replace edits the project');
await call(client, 'str_replace', { path: 'main.tex', old_str: '% edited via MCP', new_str: '% edited via MCP (2)' });
const versions = await api(`/api/projects/${project.id}/versions`);
assert(versions.length === before + 1 && versions[0].label === 'MCP: e2e test', 'one checkpoint created before the first MCP edit (not per edit)');

const files = await api(`/api/projects/${project.id}/files`);
const mainId = files.find((f) => f.path === 'main.tex').id;
const raw = await (await fetch(`${BASE}/api/projects/${project.id}/files/${mainId}/raw`, { headers: { cookie } })).text();
assert(raw.includes('% edited via MCP (2)'), 'edit visible through the live document');

const bad = await call(client, 'str_replace', { path: 'main.tex', old_str: 'NOT_PRESENT_ANYWHERE', new_str: 'x' });
assert(bad.error && /not found/.test(bad.text), 'tool errors are returned as isError results');

const wrongProject = await call(client, 'list_files', { project: 'Some Other Project' });
assert(wrongProject.error && /bound to project/.test(wrongProject.text), 'scoped token cannot target another project');

// 4. 编译
const compiled = await call(client, 'compile');
assert(/status: (success|failure)/.test(compiled.text), 'compile returns structured diagnostics');

// 5. 恢复检查点，撤销 MCP 修改
await api(`/api/projects/${project.id}/versions/${versions[0].id}/restore`, { method: 'POST', body: '{}' });
const restored = await (await fetch(`${BASE}/api/projects/${project.id}/files/${mainId}/raw`, { headers: { cookie } })).text();
assert(!restored.includes('edited via MCP'), 'MCP edits can be undone from History');

// 6. 吊销令牌后立即失效
await api(`/api/tokens/${summary.id}`, { method: 'DELETE' });
let revoked = false;
try {
  await connect(token).then((c) => c.listTools());
} catch {
  revoked = true;
}
assert(revoked, 'revoked token stops working immediately');
console.log('ALL MCP TESTS PASSED');
process.exit(0);
