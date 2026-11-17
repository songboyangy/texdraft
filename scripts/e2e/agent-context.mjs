// 上下文管理：长对话先清理较早的工具结果，再把早期对话压缩成摘要；界面历史保持完整
// 用法：mock-anthropic.mjs 运行中，服务端以 AGENT_CONTEXT_WINDOW=24000 启动（让压缩在测试规模下触发）。
//   PROVIDER=openai 时服务端应使用 OpenAI 兼容接口。
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:8790';
const ok = (m) => console.log(`ok - ${m}`);

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (p, init = {}) => (await fetch(`${BASE}${p}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })).json();

const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'context e2e' }) });
const tok = await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'context e2e', projectId: project.id }) });
await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'big.tex', content: Array.from({ length: 400 }, (_, i) => `% line ${i} ${'x'.repeat(30)}`).join('\n') } } }),
});

async function chat(body) {
  const res = await fetch(`${BASE}/api/projects/${project.id}/agent/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const events = [];
  let buf = '';
  const dec = new TextDecoder();
  for await (const c of res.body) {
    buf += dec.decode(c, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}
const requestsSince = async (n) => (await (await fetch(`${MOCK}/_requests`)).json()).slice(n);
const startCount = (await (await fetch(`${MOCK}/_requests`)).json()).length;

try {
  // ---- 第 1 轮：反复读大文件 → 清理较早的工具结果
  const ev1 = await chat({ message: 'CONTEXT 1: read big.tex several times', context: {} });
  const fin1 = ev1.find((e) => e.type === 'run_finished');
  assert.equal(fin1.status, 'completed', JSON.stringify(fin1));
  assert.ok(ev1.some((e) => e.type === 'progress' && /cleared|清理/.test(e.text)), 'user is told older tool outputs were cleared');
  const r1 = await requestsSince(startCount);
  assert.ok(r1.some((r) => JSON.stringify(r.body).includes('Older tool result cleared')), 'a later request carries the cleared placeholder');
  assert.equal(ev1.filter((e) => e.type === 'tool_end' && e.name === 'read_file').length, 4);
  ok('long tool loop: older tool results are cleared from the model context');

  // ---- 第 2 轮：清理不够（第 1 轮有一大段回答）→ 早期对话写成摘要
  const n2 = (await (await fetch(`${MOCK}/_requests`)).json()).length;
  const ev2 = await chat({ threadId: ev1[0].threadId, message: 'CONTEXT 2: continue', context: {} });
  const fin2 = ev2.find((e) => e.type === 'run_finished');
  assert.equal(fin2.status, 'completed', JSON.stringify(fin2));
  assert.ok(ev2.some((e) => e.type === 'progress' && /summary|摘要/.test(e.text)), 'user is told the conversation was compacted');
  const r2 = await requestsSince(n2);
  const summaryReq = r2.find((r) => JSON.stringify(r.body).includes('You compress the history'));
  assert.ok(summaryReq && JSON.stringify(summaryReq.body).includes('CONTEXT 1'), 'summary request covers the earlier turn');
  assert.ok(!JSON.stringify(summaryReq.body.tools ?? []).includes('read_file'), 'summary request has no tools');
  const after = r2.at(-1);
  const body = JSON.stringify(after.body.messages);
  assert.ok(body.includes('<conversation_summary>') && body.includes('SUMMARY-OK (covers CONTEXT 1)'), 'model gets the summary');
  assert.ok(!body.includes('LONG-ANSWER') && !body.includes('CONTEXT 1: read'), 'earlier turn is no longer sent');
  assert.ok(body.includes('CONTEXT 2: continue'), 'current turn is sent');
  ok('long conversation: earlier turns are replaced by a model-written summary');

  // ---- 界面历史保持完整
  const t = await api(`/api/projects/${project.id}/agent/threads/${ev1[0].threadId}`);
  const users = t.items.filter((i) => i.kind === 'user').map((i) => i.text);
  assert.ok(users.some((x) => x.includes('CONTEXT 1')) && users.some((x) => x.includes('CONTEXT 2')));
  assert.ok(t.items.some((i) => i.kind === 'assistant' && i.text.includes('LONG-ANSWER')));
  ok('the chat history shown to the user is unchanged');

  // ---- 第 3 轮：在摘要基础上继续（摘要保持，不重复压缩）
  const n3 = (await (await fetch(`${MOCK}/_requests`)).json()).length;
  const ev3 = await chat({ threadId: ev1[0].threadId, message: 'CONTEXT 2: once more', context: {} });
  assert.equal(ev3.find((e) => e.type === 'run_finished').status, 'completed');
  const r3 = await requestsSince(n3);
  assert.ok(!r3.some((r) => JSON.stringify(r.body).includes('You compress the history')), 'no second compaction needed');
  assert.ok(JSON.stringify(r3.at(-1).body.messages).includes('SUMMARY-OK'), 'summary is kept for later turns');
  ok('later turns keep using the summary');

  console.log('ALL CONTEXT TESTS PASSED');
} finally {
  if (!process.env.KEEP) await api(`/api/projects/${project.id}`, { method: "DELETE" });
  await api(`/api/tokens/${tok.summary.id}`, { method: 'DELETE' });
}
