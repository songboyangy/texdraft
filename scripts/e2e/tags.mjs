// 项目标签端到端测试：REST（新建 / 重名 / 改名 / 删除标签，给项目打标签，项目列表返回标签与数量）、
// 标签按用户隔离（共享项目的查看者可以给它打自己的标签，不影响所有者）、MCP（tag_project、list_projects 显示与按标签筛选）。
// 用法：node scripts/e2e/tags.mjs（需先启动服务端、开放注册，并存在 a@test.dev / password123 用户）
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const ok = (m) => console.log(`ok - ${m}`);

async function session(email, register = false) {
  if (register) {
    await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email.split('@')[0], password: 'password123' }) });
  }
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
  assert.equal(r.status, 200, `login ${email}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, p, body) => {
    const res = await fetch(`${BASE}${p}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

const a = await session('a@test.dev');
const b = await session(`tags-${Date.now()}@test.dev`, true);
const tok = (await a('POST', '/api/tokens', { name: 'tags e2e' })).body;
let rpc = 0;
async function mcp(name, args = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = (await r.json()).result;
  return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
}

const projects = [];
const tagIds = [];
try {
  const p1 = (await a('POST', '/api/projects', { name: 'Tags e2e one' })).body;
  const p2 = (await a('POST', '/api/projects', { name: 'Tags e2e two' })).body;
  projects.push(p1.id, p2.id);

  // ---------------- 标签的增删改 ----------------
  let r = await a('POST', '/api/tags', { name: '  NeurIPS   2026 ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'NeurIPS 2026', 'whitespace is normalised');
  const neurips = r.body.id;
  tagIds.push(neurips);
  assert.equal((await a('POST', '/api/tags', { name: 'neurips 2026' })).status, 409, 'names are unique per user, case-insensitively');
  assert.equal((await a('POST', '/api/tags', { name: '   ' })).status, 400);
  const course = (await a('POST', '/api/tags', { name: 'Course' })).body.id;
  tagIds.push(course);
  ok('create tags (normalised, unique per user, non-empty)');

  assert.equal((await a('PUT', `/api/tags/${neurips}/projects/${p1.id}`)).status, 200);
  assert.equal((await a('PUT', `/api/tags/${neurips}/projects/${p1.id}`)).status, 200, 'tagging twice is harmless');
  await a('PUT', `/api/tags/${neurips}/projects/${p2.id}`);
  await a('PUT', `/api/tags/${course}/projects/${p2.id}`);
  let list = (await a('GET', '/api/projects')).body;
  assert.deepEqual(list.find((p) => p.id === p1.id).tags, [neurips]);
  assert.deepEqual(list.find((p) => p.id === p2.id).tags.sort(), [course, neurips].sort());
  let tags = (await a('GET', '/api/tags')).body;
  assert.equal(tags.find((t) => t.id === neurips).count, 2);
  assert.equal(tags.find((t) => t.id === course).count, 1);
  ok('tag projects; the project list returns each project\'s tags and tags return counts');

  await a('DELETE', `/api/tags/${neurips}/projects/${p2.id}`);
  assert.equal((await a('PATCH', `/api/tags/${course}`, { name: 'NEURIPS 2026' })).status, 409, 'rename cannot collide');
  assert.equal((await a('PATCH', `/api/tags/${course}`, { name: 'Coursework' })).status, 200);
  tags = (await a('GET', '/api/tags')).body;
  assert.deepEqual(tags.map((t) => `${t.name}:${t.count}`), ['Coursework:1', 'NeurIPS 2026:1']);
  ok('untag a project and rename a tag');

  // ---------------- 按用户隔离 ----------------
  const bTag = (await b('POST', '/api/tags', { name: 'Shared with me' })).body.id;
  assert.equal((await b('PUT', `/api/tags/${bTag}/projects/${p1.id}`)).status, 404, 'cannot tag a project you cannot see');
  assert.equal((await a('PUT', `/api/tags/${bTag}/projects/${p1.id}`)).status, 404, "cannot use someone else's tag");
  assert.equal((await a('DELETE', `/api/tags/${bTag}`)).status, 404, "cannot delete someone else's tag");
  assert.equal((await a('DELETE', '/api/tags/not-a-uuid')).status, 404);
  const bMe = (await b('GET', '/api/auth/me')).body;
  r = await a('POST', `/api/projects/${p1.id}/members`, { email: bMe.email ?? bMe.user?.email, role: 'viewer' });
  assert.equal(r.status, 200, `share: ${JSON.stringify(r.body)}`);
  assert.equal((await b('PUT', `/api/tags/${bTag}/projects/${p1.id}`)).status, 200, 'a viewer can tag a shared project');
  assert.deepEqual((await b('GET', '/api/projects')).body.find((p) => p.id === p1.id).tags, [bTag]);
  assert.deepEqual((await a('GET', '/api/projects')).body.find((p) => p.id === p1.id).tags, [neurips], "the owner does not see the viewer's tags");
  assert.ok(!(await a('GET', '/api/tags')).body.some((t) => t.id === bTag));
  ok('tags are personal: viewers tag shared projects without affecting the owner');

  // ---------------- MCP ----------------
  r = await mcp('tag_project', { project: p2.id, add: ['Thesis', 'coursework'], remove: [] });
  assert.ok(!r.isError, r.text);
  assert.equal(r.text, 'Tags now: Coursework, Thesis.', 'existing tag matched case-insensitively, new tag created');
  tags = (await a('GET', '/api/tags')).body;
  const thesis = tags.find((t) => t.name === 'Thesis');
  assert.ok(thesis);
  tagIds.push(thesis.id);
  r = await mcp('list_projects', {});
  assert.match(r.text, new RegExp(`${p2.id}\\tTags e2e two\\towner\\tupdated [^\\t]+\\ttags: Coursework, Thesis`));
  r = await mcp('list_projects', { tag: 'neurips 2026' });
  assert.ok(r.text.includes(p1.id) && !r.text.includes(p2.id), 'filter by tag');
  r = await mcp('tag_project', { project: p2.id, remove: ['Thesis', 'Coursework'] });
  assert.equal(r.text, 'The project has no tags now.');
  assert.ok((await mcp('tag_project', { project: p2.id })).isError, 'nothing to change is an error');
  ok('MCP tag_project and list_projects (shows tags, filters by tag)');

  // ---------------- 删除标签不影响项目 ----------------
  assert.equal((await a('DELETE', `/api/tags/${neurips}`)).status, 200);
  list = (await a('GET', '/api/projects')).body;
  assert.deepEqual(list.find((p) => p.id === p1.id).tags, []);
  assert.ok(list.some((p) => p.id === p1.id), 'the project still exists');
  ok('deleting a tag keeps its projects');

  console.log('ALL TAG TESTS PASSED');
} finally {
  for (const id of projects) await a('DELETE', `/api/projects/${id}`);
  for (const id of tagIds) await a('DELETE', `/api/tags/${id}`);
  await a('DELETE', `/api/tokens/${tok.summary.id}`);
}
