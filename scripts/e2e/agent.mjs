// Agent 端到端测试（配合 mock-anthropic.mjs）：
// 流式事件、工具执行、Yjs 实时写入、对话持久化、改动摘要、撤销、停止。
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:8790';
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok -', m); };

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (path, init = {}) => {
  const res = await fetch(BASE + path, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};
const readFile = async (pid, path) => {
  const files = await api(`/api/projects/${pid}/files`);
  const f = files.find((x) => x.path === path);
  if (!f) return null;
  return (await fetch(`${BASE}/api/projects/${pid}/files/${f.id}/raw`, { headers: { cookie } })).text();
};

async function chat(pid, body, onEvent = () => {}) {
  const res = await fetch(`${BASE}/api/projects/${pid}/agent/chat`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat failed ${res.status}: ${await res.text()}`);
  const events = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (line) { const e = JSON.parse(line.slice(6)); events.push(e); onEvent(e); }
    }
  }
  return events;
}

const pid = (await api('/api/projects')).find((p) => p.name === 'Demo').id;
const before = await readFile(pid, 'main.tex');
assert(before.includes('\\title{Server Side Title}'), 'precondition: main.tex has the expected title');

// ---------------- 1. 完整一轮 ----------------
const events = await chat(pid, { message: '改一下标题，并加一个方法章节', context: { activePath: 'main.tex', cursorLine: 3 } });
const types = events.map((e) => e.type);
assert(types[0] === 'run_started' && types.at(-1) === 'run_finished', 'stream starts with run_started and ends with run_finished');
assert(events.some((e) => e.type === 'progress' && e.text.includes('主文件')), 'progress (thinking updates) streamed');
assert(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('').includes('完成'), 'assistant text streamed');
const ends = events.filter((e) => e.type === 'tool_end');
assert(ends.length === 5, `5 tool calls executed (got ${ends.length})`);
assert(ends.filter((e) => !e.ok).length === 1 && ends.find((e) => !e.ok).summary.includes('not found'), 'bad str_replace returned as tool error');
assert(events.some((e) => e.type === 'compile_result'), 'agent compiled the project');
const fin = events.at(-1);
assert(fin.status === 'completed', 'run completed');
assert(fin.changes.length === 2 && fin.changes.map((c) => c.path).sort().join() === 'main.tex,sections/method.tex', 'change summary lists both files');
const mainChange = fin.changes.find((c) => c.path === 'main.tex');
assert(mainChange.patch.includes('+\\title{A Mocked Agent Title}') && mainChange.additions === 1 && mainChange.deletions === 1, 'diff for main.tex is correct');

const after = await readFile(pid, 'main.tex');
assert(after.includes('\\title{A Mocked Agent Title}'), 'main.tex really edited');
assert((await readFile(pid, 'sections/method.tex'))?.includes('\\section{Method}'), 'new file created');

// 请求参数检查
const reqs = await (await fetch(`${MOCK}/_requests`)).json();
const r0 = reqs[reqs.length - 4];
const r2 = reqs[reqs.length - 2];
if (process.env.PROVIDER === 'openai') {
  // OpenAI Chat Completions：工具为 function 定义，工具结果为 role: tool 消息，带 Bearer 认证
  assert(r0.url.startsWith('/v1/chat/completions') && r0.headers.authorization === 'Bearer test', 'OpenAI endpoint with bearer auth');
  assert(r0.body.stream === true && r0.body.stream_options?.include_usage === true, 'streaming with usage');
  assert(r0.body.tools.every((t) => t.type === 'function' && t.function.name && t.function.parameters), 'tools sent as functions');
  assert(r0.body.messages[0].role === 'system' && r0.body.messages[1].content.includes('<editor_context>') && r0.body.messages[1].content.includes('cursor at line 3'), 'system prompt and editor context');
  const tail = r2.body.messages.slice(-3);
  assert(tail.every((m) => m.role === 'tool' && m.tool_call_id), 'parallel tool results returned as tool messages');
  assert(tail.some((m) => m.content.startsWith('ERROR: ')), 'tool error marked');
  const asst = r2.body.messages.filter((m) => m.role === 'assistant');
  assert(asst.at(-1).tool_calls.length === 3 && !asst.some((m) => 'reasoning_content' in m), 'tool calls echoed back, reasoning not sent');
} else {
  assert(r0.body.model === 'claude-opus-5-5', 'model is claude-opus-5-5');
  assert(r0.headers['anthropic-beta']?.includes('thinking-display-updates-2026-08-18') && r0.headers['anthropic-beta'].includes('server-side-fallback-2026-07-01'), 'beta headers sent');
  assert(r0.body.fallbacks === 'default' && r0.body.thinking?.display === 'updates' && r0.body.cache_control?.type === 'ephemeral', 'fallbacks/thinking/cache params sent');
  assert(r0.body.tools.every((t) => t.eager_input_streaming === true), 'eager_input_streaming on every tool');
  assert(r0.body.messages[0].content[0].text.startsWith('<editor_context>') && r0.body.messages[0].content[0].text.includes('cursor at line 3'), 'editor context attached');
  const lastUser = r2.body.messages.at(-1);
  assert(lastUser.role === 'user' && lastUser.content.length === 3 && lastUser.content.every((b) => b.type === 'tool_result'), 'parallel tool results returned in one user message');
  assert(r2.body.messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'thinking' && b.signature)), 'thinking blocks echoed back unchanged');
}

// ---------------- 2. 历史对话 ----------------
const threadId = events[0].threadId;
const t = await api(`/api/projects/${pid}/agent/threads/${threadId}`);
const kinds = t.items.map((i) => i.kind);
assert(kinds[0] === 'user' && kinds.includes('progress') && kinds.includes('tool') && kinds.at(-1) === 'run_summary', 'thread history renders user/progress/tool/summary');
assert(!t.items.some((i) => i.kind === 'user' && i.text.startsWith('<editor_context>')), 'editor context hidden from history');

// ---------------- 3. 撤销 ----------------
await api(`/api/projects/${pid}/agent/runs/${fin.runId}/revert`, { method: 'POST', body: '{}' });
assert((await readFile(pid, 'main.tex')) === before, 'revert restored main.tex exactly');
assert((await readFile(pid, 'sections/method.tex')) === null, 'revert deleted the created file');
const t2 = await api(`/api/projects/${pid}/agent/threads/${threadId}`);
assert(t2.items.at(-1).reverted === true, 'run marked as reverted');

// ---------------- 4. 同一对话第二轮（历史回放） ----------------
const ev2 = await chat(pid, { threadId, message: '再来一次', context: {} });
assert(ev2.at(-1).status === 'completed', 'second turn in same thread completed');
await api(`/api/projects/${pid}/agent/runs/${ev2.at(-1).runId}/revert`, { method: 'POST', body: '{}' });

// ---------------- 5. 停止 ----------------
let runId;
const ev3 = await chat(pid, { message: 'SLOW task' }, (e) => {
  if (e.type === 'run_started') {
    runId = e.runId;
    setTimeout(() => api(`/api/projects/${pid}/agent/runs/${runId}/stop`, { method: 'POST', body: '{}' }), 2500);
  }
});
assert(ev3.at(-1).status === 'stopped', 'run can be stopped by the user');

console.log('ALL AGENT TESTS PASSED');
