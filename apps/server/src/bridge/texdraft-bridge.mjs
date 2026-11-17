#!/usr/bin/env node
// TeXdraft 本地桥接：让网页聊天栏使用你电脑上的 Codex / Claude Code。
//
//   curl -fsSL https://<你的 TeXdraft>/mcp/bridge.mjs -o texdraft-bridge.mjs
//   node texdraft-bridge.mjs --server https://<你的 TeXdraft> --token tp_xxx
//
// 它主动连接 TeXdraft（电脑在内网、没有公网 IP 也可以），网页里选择「我的电脑 · Codex / Claude Code」发消息时，
// 在本机运行对应的 CLI，并把过程实时回传到网页。用的是你自己的 Codex / Claude 账号与额度。
//
// 安全：只会运行 codex / claude 两个命令，命令行参数由本程序按固定模板组装（服务器只提供提示词、会话等结构化参数）；
// Agent 只被允许使用 TeXdraft 的 MCP 工具（Claude Code 关闭全部内置工具；Codex 关闭 shell、代码执行、浏览器等能力），
// 不能读写你电脑上的文件。MCP 地址必须与 --server 同源。
// 需要 Node.js 22 或更高版本（内置 WebSocket），无其他依赖。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '1.0.1';
const AGENTS = { codex: 'Codex', claude: 'Claude Code' };
// 与服务端 agent/cli.ts 中的 CODEX_DISABLED_FEATURES 保持一致
const CODEX_DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'js_repl', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser',
  'image_generation', 'apps', 'plugins', 'standalone_web_search', 'view_image', 'multi_agent',
];

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`texdraft-bridge ${VERSION}
用法: node texdraft-bridge.mjs --server <TeXdraft 地址> --token <tp_ 开头的令牌> [--agents codex,claude]
也可以用环境变量 TEXDRAFT_SERVER / TEXDRAFT_TOKEN。令牌在 TeXdraft 编辑器「⋯ → 连接 ChatGPT / AI Agent」里生成。`);
  process.exit(0);
}
const server = (opt('server') ?? process.env.TEXDRAFT_SERVER ?? process.env.TEXPILOT_SERVER ?? '').replace(/\/+$/, '');
const token = opt('token') ?? process.env.TEXDRAFT_TOKEN ?? process.env.TEXPILOT_TOKEN ?? '';
const only = (opt('agents') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const die = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};
if (typeof WebSocket === 'undefined') die(`需要 Node.js 22 或更高版本（当前 ${process.version}）。`);
if (!/^https?:\/\//.test(server)) die('请用 --server 指定 TeXdraft 地址，例如 --server https://tex.example.com');
if (!/^tp_[A-Za-z0-9_-]{20,}$/.test(token)) die('请用 --token 指定令牌（tp_ 开头，在 TeXdraft「⋯ → 连接 ChatGPT / AI Agent」里生成）');
const serverOrigin = new URL(server).origin;

// ---------------- 查找本机 Agent ----------------
const isWin = process.platform === 'win32';
function which(name) {
  const exts = isWin ? ['.cmd', '.exe', ''] : [''];
  const extra = [path.join(os.homedir(), '.npm-global/bin'), path.join(os.homedir(), '.local/bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), ...extra]) {
    for (const ext of exts) {
      const p = dir && path.join(dir, name + ext);
      if (p && fs.existsSync(p)) return p;
    }
  }
  return null;
}
const agents = {};
for (const id of Object.keys(AGENTS)) {
  if (only.length && !only.includes(id)) continue;
  const bin = which(id);
  if (!bin) continue;
  let version = '';
  try {
    version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, shell: isWin }).trim().split('\n')[0].slice(0, 60);
  } catch {
    /* 版本获取失败不影响使用 */
  }
  agents[id] = { bin, version };
}
if (!Object.keys(agents).length) die('没有找到 codex 或 claude 命令。请先安装并登录 Codex CLI 或 Claude Code。');

// ---------------- 运行 ----------------
const tomlString = (s) => JSON.stringify(s);
function buildArgs(m) {
  if (m.agent === 'claude') {
    const mcp = JSON.stringify({ mcpServers: { texdraft: { type: 'http', url: m.mcpUrl, headers: { Authorization: `Bearer ${m.mcpToken}` } } } });
    return [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', mcp, '--strict-mcp-config',
      '--tools', '', '--allowedTools', 'mcp__texdraft', '--permission-mode', 'dontAsk',
      '--append-system-prompt', m.instructions,
      ...(m.session ? ['--resume', m.session] : []),
      m.prompt,
    ];
  }
  const cfg = [
    `mcp_servers.texdraft.url=${tomlString(m.mcpUrl)}`,
    `mcp_servers.texdraft.http_headers={Authorization=${tomlString(`Bearer ${m.mcpToken}`)}}`,
    'mcp_servers.texdraft.default_tools_approval_mode="approve"',
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    // 网页搜索：新版用顶层 web_search（旧的 features.web_search_request 已废弃，会打印警告）
    'web_search="disabled"',
    ...CODEX_DISABLED_FEATURES.map((f) => `features.${f}=false`),
    'suppress_unstable_features_warning=true',
    `developer_instructions=${tomlString(m.instructions)}`,
  ].flatMap((c) => ['-c', c]);
  return m.session
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...cfg, m.session, m.prompt]
    : ['exec', '--json', '--skip-git-repo-check', ...cfg, m.prompt];
}

const running = new Map();
const time = () => new Date().toTimeString().slice(0, 5);
let ws = null;
const send = (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

function startRun(m) {
  const fail = (error) => send({ type: 'exit', runId: m.runId, code: null, error });
  const agent = agents[m.agent];
  if (!agent) return fail(`${AGENTS[m.agent] ?? m.agent} is not installed on this computer`);
  let mcpOrigin = '';
  try {
    mcpOrigin = new URL(m.mcpUrl).origin;
  } catch {
    /* 下面拒绝 */
  }
  if (mcpOrigin !== serverOrigin) return fail('MCP URL does not match the TeXdraft server this bridge is connected to');
  if (typeof m.prompt !== 'string' || typeof m.mcpToken !== 'string' || typeof m.instructions !== 'string') return fail('invalid run request');

  // 每个对话一个空的临时工作目录（Agent 不需要也不能访问你的文件）
  const workdir = path.join(os.tmpdir(), 'texdraft-bridge', String(m.threadId ?? 'run').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'run');
  fs.mkdirSync(workdir, { recursive: true });
  const firstLine = m.prompt.split('\n').filter((l) => l.trim()).pop() ?? '';
  console.log(`[${time()}] ▶ ${AGENTS[m.agent]}  ${firstLine.slice(0, 70)}${firstLine.length > 70 ? '…' : ''}`);

  const child = spawn(agent.bin, buildArgs(m), { cwd: workdir, detached: !isWin, stdio: ['ignore', 'pipe', 'pipe'], shell: isWin, env: process.env });
  running.set(m.runId, child);
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) send({ type: 'line', runId: m.runId, line });
    }
  });
  child.stderr.on('data', (c) => send({ type: 'stderr', runId: m.runId, text: c.toString('utf8') }));
  child.on('error', (err) => {
    running.delete(m.runId);
    fail(String(err.message ?? err));
  });
  child.on('close', (code) => {
    if (buf.trim()) send({ type: 'line', runId: m.runId, line: buf });
    running.delete(m.runId);
    console.log(`[${time()}] ${code === 0 ? '✓ 完成' : `✗ 结束（退出码 ${code}）`}`);
    send({ type: 'exit', runId: m.runId, code });
  });
}

function cancelRun(runId) {
  const child = running.get(runId);
  if (!child) return;
  console.log(`[${time()}] ■ 已停止`);
  try {
    if (!isWin) process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch {
    child.kill();
  }
}

// ---------------- 连接（断线自动重连） ----------------
let retry = 0;
let announced = false;
function connect() {
  ws = new WebSocket(serverOrigin.replace(/^http/, 'ws') + new URL(server).pathname.replace(/\/+$/, '') + '/mcp/bridge');
  ws.onopen = () => {
    retry = 0;
    send({ type: 'auth', token });
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.type === 'hello') {
      send({ type: 'register', hostname: os.hostname(), platform: `${process.platform}-${process.arch}`, version: VERSION, agents: Object.entries(agents).map(([id, a]) => ({ id, version: a.version })) });
      if (!announced) {
        announced = true;
        console.log(`✓ 已连接到 ${serverOrigin}，账号：${m.user?.name ?? ''} ${m.user?.email ? `<${m.user.email}>` : ''}`);
        console.log(`  可用的 Agent：${Object.entries(agents).map(([id, a]) => `${AGENTS[id]}${a.version ? ` (${a.version})` : ''}`).join('、')}`);
        console.log('  在网页 AI 面板的输入框左下角选择「我的电脑 · …」即可使用。保持这个窗口运行；按 Ctrl+C 退出。');
      } else console.log(`[${time()}] ✓ 已重新连接`);
    } else if (m.type === 'run') startRun(m);
    else if (m.type === 'cancel') cancelRun(m.runId);
  };
  ws.onclose = (ev) => {
    for (const id of running.keys()) cancelRun(id);
    if (ev.code === 4401) die(`令牌无效或已被吊销（${ev.reason || 'unauthorized'}）。请在 TeXdraft 里重新生成令牌。`);
    const delay = [1, 2, 5, 10, 30][Math.min(retry++, 4)];
    console.log(`[${time()}] 连接断开，${delay} 秒后重连…`);
    setTimeout(connect, delay * 1000);
  };
  ws.onerror = () => {};
}

process.on('SIGINT', () => {
  for (const id of running.keys()) cancelRun(id);
  console.log('\n已退出。');
  process.exit(0);
});
console.log(`texdraft-bridge ${VERSION}：正在连接 ${serverOrigin} …`);
connect();
