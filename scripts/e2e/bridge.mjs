// 本地桥接端到端测试：在“用户电脑”上运行 texdraft-bridge（用假的 claude / codex，它们真的调用 MCP 改文件），
// 网页聊天选择「我的电脑 · …」→ 运行经桥接执行、事件实时回传、改动汇总与检查点、会话续接、停止、断线提示、令牌校验。
// 用法：node scripts/e2e/bridge.mjs（需先启动服务端；a@test.dev 存在，例如 seed.mjs 之后）
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, '../../apps/server/src/bridge/texdraft-bridge.mjs');
const ok = (m) => console.log(`ok - ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: 'password123' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (p, init = {}) => {
  const r = await fetch(BASE + p, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
};
async function chat(pid, body) {
  const res = await fetch(`${BASE}/api/projects/${pid}/agent/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'accept-language': 'en' }, body: JSON.stringify({ context: {}, lang: 'en', ...body }) });
  const events = [];
  let buf = '';
  for await (const c of res.body) {
    buf += new TextDecoder().decode(c);
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (line) {
        const e = JSON.parse(line.slice(6));
        events.push(e);
        body.onEvent?.(e);
      }
    }
  }
  return events;
}
const backends = async () => (await api('/api/agent/backends')).data;
const run = Date.now().toString(36);
function startBridge(token, extra = [], computer = 'pc1') {
  const child = spawn(process.execPath, [BRIDGE, '--server', BASE, '--token', token, ...extra], {
    // computer：每台“电脑”有自己的 CLI 会话存储
    env: { ...process.env, PATH: `${path.join(HERE, 'fake-cli')}${path.delimiter}${process.env.PATH}`, FAKE_SESSIONS_DIR: path.join(os.tmpdir(), `fake-sessions-${run}-${computer}`) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  return { child, output: () => output, exited: new Promise((r) => child.on('close', r)) };
}
async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}

const project = (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `bridge ${Date.now()}` }) })).data;
const files = async () => (await api(`/api/projects/${project.id}/files`)).data;
const mainText = async () => {
  const main = (await files()).find((f) => f.path === 'main.tex');
  return (await fetch(`${BASE}/api/projects/${project.id}/files/${main.id}/raw`, { headers: { cookie } })).text();
};

// ---- 只接受“全部项目”的令牌；项目令牌会被拒绝
const scoped = (await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'bridge scoped', projectId: project.id }) })).data;
const bad = startBridge(scoped.token);
assert.equal(await Promise.race([bad.exited, sleep(10_000).then(() => 'timeout')]), 1, bad.output());
assert.match(bad.output(), /令牌无效|invalid token/);
ok('project-scoped tokens are rejected by the bridge endpoint');

// ---- 连接：网页后端列表出现「我的电脑」
const tok = (await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'bridge e2e' }) })).data;
const bridge = startBridge(tok.token);
assert.ok(await waitFor(async () => (await backends()).backends.includes('bridge-claude')), `bridge did not register: ${bridge.output()}`);
const b0 = await backends();
assert.ok(b0.backends.includes('bridge-codex'));
assert.equal(b0.bridges.length, 1);
assert.deepEqual(b0.bridges[0].agents.map((a) => a.id).sort(), ['claude', 'codex']);
assert.match(bridge.output(), /已连接/);
ok('a running bridge shows up as "my computer" backends with its agents');

// ---- Claude Code（经桥接）：修改文件、事件回传、改动汇总
const ev1 = await chat(project.id, { backend: 'bridge-claude', message: 'Change the title' });
const fin1 = ev1.at(-1);
assert.equal(fin1.type, 'run_finished');
assert.equal(fin1.status, 'completed', JSON.stringify(fin1));
assert.deepEqual(fin1.changes.map((c) => `${c.path}:${c.action}`), ['main.tex:modified']);
assert.ok(ev1.some((e) => e.type === 'tool_start' && e.name === 'str_replace'), 'tool call streamed');
assert.ok(ev1.some((e) => e.type === 'text_delta' && e.text.includes('resume=none')));
assert.match(await mainText(), /\\title\{Edited by fake claude\}/);
const threadId = ev1.find((e) => e.type === 'run_started').threadId;
ok('a chat message runs Claude Code on the bridge; edits, tool calls and the reply reach the web');

// ---- 同一对话续接会话（--resume）
const ev2 = await chat(project.id, { backend: 'bridge-claude', threadId, message: 'Again' });
assert.equal(ev2.at(-1).status, 'completed');
assert.ok(ev2.some((e) => e.type === 'text_delta' && e.text.includes('resume=fake-claude-session')), 'session resumed');
const thread = (await api(`/api/projects/${project.id}/agent/threads/${threadId}`)).data;
assert.ok(thread.items.some((it) => it.kind === 'user' && it.text === 'Again'), 'conversation persisted');
ok('follow-up messages resume the same CLI session; the conversation is saved');

// ---- Codex（经桥接）：带有关闭 shell 等安全参数
const ev3 = await chat(project.id, { backend: 'bridge-codex', message: 'Change the title' });
assert.equal(ev3.at(-1).status, 'completed', JSON.stringify(ev3.at(-1)));
assert.match(await mainText(), /\\title\{Edited by fake codex\}/);
ok('Codex runs on the bridge with its shell and other built-in tools disabled');

// ---- 停止：取消会结束本机进程
let runId = null;
const stopping = chat(project.id, {
  backend: 'bridge-claude',
  message: 'SLEEP please',
  onEvent: (e) => {
    if (e.type === 'run_started') runId = e.runId;
  },
});
assert.ok(await waitFor(() => !!runId), 'run started');
await sleep(500);
assert.equal((await api(`/api/projects/${project.id}/agent/runs/${runId}/stop`, { method: 'POST', body: '{}' })).data.stopped, true);
const ev4 = await stopping;
assert.equal(ev4.at(-1).status, 'stopped');
assert.match(bridge.output(), /已停止/);
ok('stopping a run kills the agent on the user\'s computer');

// ---- 换了一台电脑：之前的会话找不到 → 自动开新会话，并带上网页上保存的最近对话
bridge.child.kill('SIGINT');
await bridge.exited;
const laptop = startBridge(tok.token, [], 'pc2');
assert.ok(await waitFor(async () => (await backends()).backends.includes('bridge-claude')), `second computer did not register: ${laptop.output()}`);
for (const agent of ['claude', 'codex']) {
  const first = await chat(project.id, { backend: `bridge-${agent}`, message: `First message for ${agent}` });
  assert.equal(first.at(-1).status, 'completed', JSON.stringify(first.at(-1)));
  const tid = first.find((e) => e.type === 'run_started').threadId;
  // 第三台“电脑”上没有这个会话
  laptop.child.kill('SIGINT');
  await laptop.exited;
  const other = startBridge(tok.token, [], `pc3-${agent}`);
  assert.ok(await waitFor(async () => (await backends()).backends.includes(`bridge-${agent}`)), 'third computer registered');
  const ev = await chat(project.id, { backend: `bridge-${agent}`, threadId: tid, message: 'Continue please' });
  assert.equal(ev.at(-1).status, 'completed', `${agent}: ${JSON.stringify(ev.at(-1))}`);
  assert.ok(ev.some((e) => e.type === 'progress' && /not available on this computer/.test(e.text)), `${agent}: user is told a new session was started`);
  assert.ok(ev.some((e) => e.type === 'text_delta' && e.text.includes('resume=none context=yes')), `${agent}: fresh session got the recent conversation as context`);
  // 新会话被记下：再发一条会续接新的会话
  const again = await chat(project.id, { backend: `bridge-${agent}`, threadId: tid, message: 'And again' });
  assert.ok(again.some((e) => e.type === 'text_delta' && /resume=fake-/.test(e.text) && e.text.includes('context=no')), `${agent}: the new session is resumed next time`);
  other.child.kill('SIGINT');
  await other.exited;
  if (agent === 'claude') {
    // 下一轮 codex 用的“当前电脑”
    Object.assign(laptop, startBridge(tok.token, [], 'pc2'));
    assert.ok(await waitFor(async () => (await backends()).backends.includes('bridge-codex')));
  }
}
ok('on another computer, a missing CLI session is replaced by a new one that gets the recent conversation');
const bridgeFinal = startBridge(tok.token, [], 'pc2');
assert.ok(await waitFor(async () => (await backends()).backends.includes('bridge-claude')));

// ---- 断开：后端消失，发送时给出提示
bridgeFinal.child.kill('SIGINT');
await bridgeFinal.exited;
assert.ok(await waitFor(async () => !(await backends()).backends.some((b) => b.startsWith('bridge-'))), 'bridge backends removed');
const ev5 = await chat(project.id, { backend: 'bridge-claude', message: 'Anyone there?' });
assert.equal(ev5.at(-1).status, 'error');
assert.match(ev5.at(-1).error, /not connected/);
ok('when the computer disconnects, the backend disappears and sending explains how to reconnect');

await api(`/api/tokens/${tok.summary.id}`, { method: 'DELETE' });
await api(`/api/tokens/${scoped.summary.id}`, { method: 'DELETE' });
await api(`/api/projects/${project.id}`, { method: 'DELETE' });
console.log('ALL BRIDGE TESTS PASSED');
process.exit(0);
