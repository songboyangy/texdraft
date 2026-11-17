// 聊天栏使用本机 CLI Agent 的端到端测试（真实调用 Claude Code / Codex，会消耗少量订阅额度）
// 用法：node scripts/e2e/cli-chat.mjs claude|codex
const BACKEND = process.argv[2] ?? 'claude';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok -', m); };

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (path, init = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};
const pid = (await api('/api/projects')).find((p) => p.name === 'Demo').id;
const mainId = (await api(`/api/projects/${pid}/files`)).find((f) => f.path === 'main.tex').id;
const readMain = async () => (await fetch(`${BASE}/api/projects/${pid}/files/${mainId}/raw`, { headers: { cookie } })).text();

async function chat(body) {
  const res = await fetch(`${BASE}/api/projects/${pid}/agent/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const events = [];
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

const backends = (await api('/api/agent/backends')).backends;
assert(backends.includes(BACKEND), `${BACKEND} listed as an available backend (${backends.join(', ')})`);

const before = await readMain();
const title = /\\title\{([^}]*)\}/.exec(before)[1];
const newTitle = `CLI Test Title ${BACKEND}`;
const t0 = Date.now();
const ev = await chat({
  backend: BACKEND,
  lang: 'en',
  message: `In main.tex change the \\title{...} argument from "${title}" to "${newTitle}". Use str_replace. Do not compile. Reply with one short sentence.`,
  context: { activePath: 'main.tex' },
});
console.log(`   (turn 1 took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
const types = ev.map((e) => e.type);
const fin = ev.at(-1);
assert(types[0] === 'run_started' && fin.type === 'run_finished', 'stream starts with run_started and ends with run_finished');
assert(fin.status === 'completed', `run completed (${fin.status}${fin.error ? ': ' + fin.error : ''})`);
assert(ev.some((e) => e.type === 'tool_end' && e.name === 'str_replace' && e.ok), 'CLI called the texdraft str_replace tool');
assert(ev.filter((e) => e.type === 'text_delta').length > 0, 'assistant text streamed');
assert((await readMain()).includes(`\\title{${newTitle}}`), 'main.tex edited through MCP');
assert(fin.changes.length === 1 && fin.changes[0].path === 'main.tex', 'change summary attributes the edit to this run');

const thread = ev[0].threadId;
const list = await api(`/api/projects/${pid}/agent/threads`);
assert(list.find((t) => t.id === thread)?.backend === BACKEND, 'thread remembers its backend');
const items = (await api(`/api/projects/${pid}/agent/threads/${thread}`)).items;
assert(items.some((i) => i.kind === 'tool' && i.name === 'str_replace' && i.ok) && items.at(-1).kind === 'run_summary', 'history shows tool steps and the run summary');

// 第二轮：验证会话接续（CLI resume）
const ev2 = await chat({ threadId: thread, lang: 'en', message: 'What exact title did you just set? Answer with the title only, no tools.', context: {} });
const answer = ev2.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
assert(ev2.at(-1).status === 'completed' && answer.includes(newTitle), `second turn resumes the CLI session ("${answer.trim().slice(0, 60)}")`);

// 撤销
await api(`/api/projects/${pid}/agent/runs/${fin.runId}/revert`, { method: 'POST', body: '{}' });
assert((await readMain()) === before, 'revert restores main.tex');
const tokens = await api('/api/tokens');
assert(!tokens.some((t) => t.name.startsWith('Chat run')), 'temporary run tokens are revoked after the run');
console.log(`ALL CLI CHAT TESTS PASSED (${BACKEND})`);
