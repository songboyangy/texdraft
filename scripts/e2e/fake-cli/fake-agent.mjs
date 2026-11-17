// 测试用的假 Claude Code / Codex：输出与真实 CLI 相同格式的 JSON 事件，并真的调用 TeXdraft 的 MCP 工具修改文件。
// 用法（由 claude / codex 包装脚本调用）：node fake-agent.mjs <claude|codex> ...真实 CLI 的参数
const [agent, ...args] = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(`fake-${agent} 0.0.1`);
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// 每台“电脑”的会话存储（FAKE_SESSIONS_DIR）；换一个目录就相当于换了一台电脑，之前的会话找不到
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const store = process.env.FAKE_SESSIONS_DIR ?? path.join(os.tmpdir(), 'fake-agent-sessions');
fs.mkdirSync(store, { recursive: true });
const known = (id) => fs.existsSync(path.join(store, id));
const remember = (id) => fs.writeFileSync(path.join(store, id), '');
const prompt = args.at(-1);

// 取出 MCP 地址与令牌，并检查安全参数
let url;
let token;
let session = null;
if (agent === 'claude') {
  const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.texdraft;
  url = cfg.url;
  token = cfg.headers.Authorization.replace(/^Bearer /, '');
  if (args[args.indexOf('--tools') + 1] !== '') throw new Error('built-in tools were not disabled');
  if (args.includes('--resume')) session = args[args.indexOf('--resume') + 1];
} else {
  const cs = args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));
  url = JSON.parse(cs.find((c) => c.startsWith('mcp_servers.texdraft.url=')).split('=').slice(1).join('='));
  token = /Bearer ([^"]+)/.exec(cs.find((c) => c.startsWith('mcp_servers.texdraft.http_headers=')))[1];
  for (const need of ['features.shell_tool=false', 'features.unified_exec=false', 'sandbox_mode="read-only"', 'web_search="disabled"']) {
    if (!cs.includes(need)) {
      out({ type: 'turn.failed', error: { message: `missing lockdown option ${need}` } });
      process.exit(1);
    }
  }
  if (args[1] === 'resume') session = args.at(-2);
}

// 要续接的会话不在这台电脑上：输出与真实 CLI 相同的错误并退出
if (session && !known(session)) {
  if (agent === 'claude') {
    process.stderr.write(`No conversation found with session ID: ${session}\n`);
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: session });
  } else {
    process.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${session} (code -32600)\n`);
  }
  process.exit(1);
}

async function call(name, a) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a } }),
  });
  const res = (await r.json()).result;
  return res.content.map((c) => c.text).join('\n');
}

if (prompt.includes('SLEEP')) {
  out(agent === 'claude' ? { type: 'system', subtype: 'init', session_id: 'fake-sleep' } : { type: 'thread.started', thread_id: 'fake-sleep' });
  setTimeout(() => process.exit(0), 120_000);
} else {
  const sid = session ?? `fake-${agent}-session`;
  const text = await call('read_file', { path: 'main.tex' });
  const titleLine = text.split('\n').map((l) => l.replace(/^\s*\d+\t/, '')).find((l) => l.startsWith('\\title{'));
  const newTitle = `\\title{Edited by fake ${agent}}`;
  const result = await call('str_replace', { path: 'main.tex', old_str: titleLine, new_str: newTitle });
  remember(sid);
  const hadContext = /Recent messages for context|最近的对话记录/.test(prompt);
  const reply = `Changed the title. resume=${session ?? 'none'} context=${hadContext ? 'yes' : 'no'}`;
  if (agent === 'claude') {
    out({ type: 'system', subtype: 'init', session_id: sid });
    out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'mcp__texdraft__str_replace' } } });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__texdraft__str_replace', input: { path: 'main.tex' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: result }] }] } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
    out({ type: 'result', session_id: sid, is_error: false });
  } else {
    out({ type: 'thread.started', thread_id: sid });
    out({ type: 'item.started', item: { id: 'c1', type: 'mcp_tool_call', tool: 'str_replace' } });
    out({ type: 'item.completed', item: { id: 'c1', type: 'mcp_tool_call', tool: 'str_replace', arguments: { path: 'main.tex' }, status: 'completed', result: { content: [{ type: 'text', text: result }] } } });
    out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: reply } });
    out({ type: 'turn.completed' });
  }
}
