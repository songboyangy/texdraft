import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentEvent, FileChangeSummary } from '@texdraft/shared';
import { asc, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { conflict } from '../lib/http.js';
import { bindRun, unbindRun } from '../mcp/runBinding.js';
import { INSTRUCTIONS } from '../mcp/server.js';
import { createToken, revokeToken } from '../mcp/tokens.js';
import { ChangeTracker, createCheckpoint, discardCheckpoint } from './checkpoint.js';
import { buildContextBlock } from './prompt.js';
import { activeRuns, busyThreads, persist, type RunInput } from './runner.js';
import { summarizeToolInput } from '../tools/registry.js';
import { type BridgeAgent, pickBridge, startBridgeRun } from '../bridge/hub.js';

/**
 * 用本机已登录的 CLI Agent（Claude Code / Codex）执行聊天栏中的请求。
 * CLI 只能使用 TeXdraft 的 MCP 工具（内置文件 / 命令工具全部禁用，工作目录为空的临时目录），
 * 因此所有修改都经由 Yjs 实时同步，并计入本次运行的改动汇总与检查点。
 */

export type CliBackend = 'claude' | 'codex';
export const CLI_BACKENDS: CliBackend[] = ['claude', 'codex'];
/** 聊天可用的 CLI 后端：服务器本机（claude / codex，仅管理员）或用户自己电脑上的桥接（bridge-*） */
export type ChatCliBackend = CliBackend | `bridge-${BridgeAgent}`;
export const isBridgeBackend = (b: string): b is `bridge-${BridgeAgent}` => b === 'bridge-claude' || b === 'bridge-codex';

/**
 * Codex 只允许使用 TeXdraft 的 MCP 工具：关闭 shell、代码执行、浏览器、电脑操作、插件、网页搜索等内置能力，
 * 沙箱只读。否则项目内容里的提示词注入可能让它读取运行机器上的文件（服务器或用户自己的电脑）。
 * 桥接程序（texdraft-bridge.mjs）里有同一份列表。
 */
export const CODEX_DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'js_repl', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser',
  'image_generation', 'apps', 'plugins', 'standalone_web_search', 'view_image', 'multi_agent',
];

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Record<string, unknown>;

const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const HOME = os.homedir();
const EXTRA_PATHS = [path.join(HOME, '.npm-global/bin'), path.join(HOME, '.local/bin'), '/usr/local/bin', '/usr/bin'];

/**
 * 传给 CLI 的环境变量：去掉 TeXdraft 服务端自己的配置与密钥（数据库、会话密钥、AI 服务凭据等），
 * 让 CLI 使用它自己已登录的账号；保留 PATH、HOME、代理等系统变量。
 */
const SERVER_ENV = /^(ANTHROPIC_|OPENAI_|AGENT_|COMPILE_|TECTONIC_|DATABASE_URL$|SESSION_SECRET$|DATA_DIR$|PORT$|HOST$|PUBLIC_URL$|ALLOW_LOCAL_AGENT_SETUP$|SERVE_WEB$|LOG_LEVEL$|NODE_USE_ENV_PROXY$)/;
export function cliEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SERVER_ENV.test(k)) env[k] = v;
  return { ...env, PATH: [...EXTRA_PATHS, process.env.PATH ?? ''].join(':'), NO_COLOR: '1', ...extra };
}

export function findCli(name: string): string | null {
  for (const d of [...(process.env.PATH ?? '').split(':'), ...EXTRA_PATHS]) {
    const p = d && path.join(d, name);
    if (p && existsSync(p)) return p;
  }
  return null;
}

/**
 * 本机可用于聊天的 CLI（需要服务端开启 ALLOW_LOCAL_AGENT_SETUP，且仅限管理员）：
 * CLI 使用服务器所有者已登录的账号与额度，并在服务器上以服务进程用户身份运行，不能开放给普通用户。
 */
export function availableCliBackends(isAdmin: boolean): CliBackend[] {
  if (!config.allowLocalAgentSetup || !isAdmin) return [];
  return CLI_BACKENDS.filter((b) => findCli(b));
}

const CHAT_INSTRUCTIONS = `${INSTRUCTIONS}
You are chatting with the user inside the TeXdraft editor (not a terminal). The current editor context (open file, cursor, selection, file list, last compile) is given at the top of each user message.
Reply in the language the user writes in. Before a series of tool calls, a one-line note of what you are about to do is helpful. Finish with a short summary of what you changed; do not paste whole files.`;

const normalizeTool = (name: string) => name.replace(/^mcp__tex(?:draft|pilot)__/, '').replace(/^tex(?:draft|pilot)[._]/, '') // texpilot: bridges installed before the rename;

function summarize(name: string, input: unknown) {
  const s = summarizeToolInput(name, input);
  if (s) return s;
  const q = (input as { query?: unknown })?.query;
  return typeof q === 'string' ? q : '';
}

/** 把 CLI 事件转换为聊天事件，并按 Messages API 格式积累要保存的消息 */
class Transcript {
  readonly messages: Msg[] = [];
  private assistant: Block[] = [];
  private toolNames = new Map<string, string>();
  session: string | null = null;
  error: string | null = null;
  constructor(private emit: (e: AgentEvent) => void) {}

  /** Agent 已经开始工作（输出了文字或调用了工具）：这之后不再自动重试 */
  active = false;

  text(text: string, stream = true) {
    if (!text) return;
    this.active = true;
    if (stream) this.emit({ type: 'text_delta', text });
  }
  emitProgress(text: string) {
    if (text.trim()) this.emit({ type: 'progress', text });
  }
  pushText(text: string) {
    if (text.trim()) this.assistant.push({ type: 'text', text });
  }
  pushThinking(text: string) {
    if (text.trim()) this.assistant.push({ type: 'thinking', thinking: text, signature: '' });
  }
  toolStart(id: string, rawName: string) {
    this.active = true;
    const name = normalizeTool(rawName);
    if (this.toolNames.has(id)) return;
    this.toolNames.set(id, name);
    this.emit({ type: 'tool_start', id, name });
  }
  toolUse(id: string, rawName: string, input: unknown) {
    const name = normalizeTool(rawName);
    this.toolStart(id, rawName);
    this.emit({ type: 'tool_input', id, name, summary: summarize(name, input) });
    this.assistant.push({ type: 'tool_use', id, name, input: input ?? {} });
  }
  toolResult(id: string, content: string, isError: boolean) {
    const name = this.toolNames.get(id) ?? 'tool';
    this.emit({ type: 'tool_end', id, name, ok: !isError, summary: content.slice(0, 300) });
    this.flushAssistant();
    this.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } as Msg);
  }
  flushAssistant() {
    if (this.assistant.length) this.messages.push({ role: 'assistant', content: this.assistant } as unknown as Msg);
    this.assistant = [];
  }
}

const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n')
      : '';

// ---------------- Claude Code（-p --output-format stream-json） ----------------
function claudeArgs(prompt: string, mcpJson: string, session: string | null) {
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', mcpJson, '--strict-mcp-config',
    '--tools', '', '--allowedTools', 'mcp__texdraft', '--permission-mode', 'dontAsk',
    '--append-system-prompt', CHAT_INSTRUCTIONS,
    ...(session ? ['--resume', session] : []),
    prompt,
  ];
}

function handleClaude(t: Transcript, ev: Record<string, any>) {
  if (ev.type === 'system' && ev.subtype === 'init') t.session = ev.session_id ?? t.session;
  else if (ev.type === 'stream_event') {
    const e = ev.event ?? {};
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') t.toolStart(e.content_block.id, e.content_block.name);
    else if (e.type === 'content_block_delta') {
      if (e.delta?.type === 'text_delta') t.text(e.delta.text);
      else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) t.emitProgress(e.delta.thinking);
    }
  } else if (ev.type === 'assistant') {
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'text') t.pushText(b.text);
      else if (b.type === 'thinking') t.pushThinking(b.thinking ?? '');
      else if (b.type === 'tool_use') t.toolUse(b.id, b.name, b.input);
    }
  } else if (ev.type === 'user') {
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'tool_result') t.toolResult(b.tool_use_id, resultText(b.content), !!b.is_error);
    }
  } else if (ev.type === 'result') {
    t.session = ev.session_id ?? t.session;
    if (ev.is_error) t.error = String(ev.result || ev.subtype || 'Claude Code failed');
  }
}

// ---------------- Codex（exec --json） ----------------
const tomlString = (s: string) => JSON.stringify(s); // JSON 字符串转义与 TOML basic string 兼容

function codexArgs(prompt: string, url: string, token: string, session: string | null) {
  const cfg = [
    `mcp_servers.texdraft.url=${tomlString(url)}`,
    `mcp_servers.texdraft.http_headers={Authorization=${tomlString(`Bearer ${token}`)}}`,
    'mcp_servers.texdraft.default_tools_approval_mode="approve"',
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    // 网页搜索：新版用顶层 web_search（旧的 features.web_search_request 已废弃，会打印警告）
    'web_search="disabled"',
    ...CODEX_DISABLED_FEATURES.map((f) => `features.${f}=false`),
    'suppress_unstable_features_warning=true',
    `developer_instructions=${tomlString(CHAT_INSTRUCTIONS)}`,
  ].flatMap((c) => ['-c', c]);
  return session
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...cfg, session, prompt]
    : ['exec', '--json', '--skip-git-repo-check', ...cfg, prompt];
}

function handleCodex(t: Transcript, ev: Record<string, any>, state: { texted: boolean }) {
  if (ev.type === 'thread.started') t.session = ev.thread_id ?? t.session;
  else if (ev.type === 'item.started' && ev.item?.type === 'mcp_tool_call') {
    t.toolStart(ev.item.id, ev.item.tool);
  } else if (ev.type === 'item.completed') {
    const it = ev.item ?? {};
    if (it.type === 'agent_message') {
      t.text((state.texted ? '\n\n' : '') + (it.text ?? ''));
      state.texted = true;
      t.pushText(it.text ?? '');
    } else if (it.type === 'reasoning') {
      t.emitProgress(it.text ?? '');
      t.pushThinking(it.text ?? '');
    } else if (it.type === 'mcp_tool_call') {
      state.texted = false;
      t.toolUse(it.id, it.tool, it.arguments);
      const failed = it.status === 'failed' || !!it.error;
      t.toolResult(it.id, failed ? String(it.error?.message ?? 'Tool call failed') : resultText(it.result?.content), failed);
    } else if (it.type === 'error' && !/Under-development features|is deprecated/.test(it.message ?? '')) {
      t.emitProgress(String(it.message ?? ''));
    }
  } else if (ev.type === 'turn.failed' || ev.type === 'error') {
    t.error = String(ev.error?.message ?? ev.message ?? 'Codex failed');
  }
}

// ---------------- 会话续接 ----------------
/** CLI 找不到要续接的会话时的输出（Codex 0.162：thread/resume … no rollout found；Claude Code：No conversation found with session ID） */
const SESSION_MISSING_RE = /no rollout found|thread\/resume failed|No conversation found with session ID|session (?:id )?not found|could not find (?:a )?(?:session|conversation)/i;

/**
 * 网页上保存的这段对话（本次运行之前的部分），整理成给新会话看的背景：
 * 只取用户的话与 Agent 的文字回复，最近 12 条，每条最多 1500 字、总共最多 12000 字。
 */
async function recentConversation(threadId: string, currentRunId: string, zh: boolean): Promise<string> {
  const rows = await db
    .select({ runId: schema.chatMessages.runId, role: schema.chatMessages.role, content: schema.chatMessages.content })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.threadId, threadId))
    .orderBy(asc(schema.chatMessages.id));
  const lines: string[] = [];
  for (const r of rows) {
    if (r.runId === currentRunId) continue;
    const blocks = Array.isArray(r.content) ? (r.content as Block[]) : [{ type: 'text', text: String(r.content ?? '') }];
    const texts = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '').trim()).filter(Boolean);
    if (!texts.length) continue;
    // 用户消息的第一块是编辑器上下文，只取最后一块（用户真正写的内容）
    const text = (r.role === 'user' ? texts.at(-1)! : texts.join('\n')).slice(0, 1500);
    lines.push(`${r.role === 'user' ? (zh ? '用户' : 'User') : 'Assistant'}: ${text}`);
  }
  if (!lines.length) return '';
  let picked = lines.slice(-12);
  while (picked.join('\n\n').length > 12000 && picked.length > 1) picked = picked.slice(1);
  return zh
    ? `[这段对话之前在另一个会话里进行过，那个会话在这台电脑上已经找不到。下面是最近的对话记录，供你了解背景：]\n\n${picked.join('\n\n')}\n\n[以上是之前的对话。下面是用户的新消息。]\n\n`
    : `[This conversation continued from an earlier session that is not available on this computer. Recent messages for context:]\n\n${picked.join('\n\n')}\n\n[End of earlier messages. The user's new message follows.]\n\n`;
}

// ---------------- 运行 ----------------
export async function runCliAgent(input: RunInput & { backend: ChatCliBackend }): Promise<void> {
  const { projectId, userId, threadId, emit } = input;
  const remote = isBridgeBackend(input.backend);
  const backend: CliBackend = remote ? (input.backend.slice('bridge-'.length) as CliBackend) : (input.backend as CliBackend);
  const zhPre = input.lang !== 'en';
  // 服务器本机：需要 ALLOW_LOCAL_AGENT_SETUP 且装了 CLI；桥接：需要用户有一台在线电脑提供该 Agent
  const bin = remote ? null : findCli(backend);
  const bridge = remote ? await pickBridge(userId, backend) : null;
  if (remote && !bridge) {
    throw conflict(zhPre
      ? `你的电脑没有连接到 TeXdraft（或没有安装 ${backend === 'claude' ? 'Claude Code' : 'Codex'}）。请在电脑上运行 texdraft-bridge，见「⋯ → 连接 ChatGPT / AI Agent」。`
      : `Your computer is not connected (or ${backend === 'claude' ? 'Claude Code' : 'Codex'} is not installed on it). Run texdraft-bridge on your computer; see ⋯ → Connect ChatGPT / an AI agent.`);
  }
  if (!remote && (!config.allowLocalAgentSetup || !bin)) throw conflict(`${backend} is not available on this server`);
  if (busyThreads.has(threadId)) throw conflict('This conversation already has a running request');
  busyThreads.add(threadId);
  const zh = input.lang !== 'en';

  let runId = '';
  let status: 'completed' | 'stopped' | 'error' = 'completed';
  let errorMessage: string | undefined;
  let tracker: ChangeTracker | null = null;
  let checkpointId: string | null = null;
  let tokenId: string | null = null;
  const abort = new AbortController();
  const transcript = new Transcript(emit);

  try {
    const agentLabel = `${backend === 'claude' ? 'Claude Code' : 'Codex'}${bridge ? ` @ ${bridge.hostname}` : ''}`;
    const checkpoint = await createCheckpoint(projectId, userId, `${agentLabel}: ${input.message.slice(0, 60)}`);
    checkpointId = checkpoint.id;
    const [run] = await db.insert(schema.agentRuns).values({ threadId, projectId, userId, checkpointId: checkpoint.id }).returning({ id: schema.agentRuns.id });
    runId = run.id;
    activeRuns.set(runId, { abort, threadId, userId });
    tracker = new ChangeTracker(checkpoint.files);
    emit({ type: 'run_started', runId, threadId });

    const [thread] = await db.select().from(schema.chatThreads).where(eq(schema.chatThreads.id, threadId));
    const session = thread?.cliSession ?? null;

    // 本次运行专用、限定到当前项目的临时令牌
    const { token, summary } = await createToken(userId, `Chat run (${agentLabel})`, projectId);
    tokenId = summary.id;
    bindRun(tokenId, { runId, tracker, emit });

    const contextBlock = await buildContextBlock(projectId, input.context);
    await persist(threadId, runId, { role: 'user', content: [{ type: 'text', text: contextBlock }, { type: 'text', text: input.message }] });
    const prompt = `${contextBlock}\n\n${input.message}`;

    const codexState = { texted: false };
    let stderr = '';
    let plainOut = '';
    const onLine = (raw: string) => {
      const line = raw.trim();
      if (!line.startsWith('{')) {
        if (line && plainOut.length < 5000) plainOut += line + '\n';
        return;
      }
      try {
        const ev = JSON.parse(line);
        if (backend === 'claude') handleClaude(transcript, ev);
        else handleCodex(transcript, ev, codexState);
      } catch (e) {
        console.error('[cli] bad event line', line.slice(0, 200), e);
      }
    };
    const onStderr = (text: string) => {
      if (stderr.length < 20000) stderr += text;
    };

    /** 启动一次 Agent：sess 为要续接的 CLI 会话（null = 新会话） */
    const execute = async (sess: string | null, text: string): Promise<{ kill: () => void; exited: Promise<number | null> }> => {
      if (bridge) {
        // 用户自己的电脑：桥接程序按模板组装命令并运行，事件逐行回传
        let resolveExit!: (c: number | null) => void;
        const exited = new Promise<number | null>((r) => (resolveExit = r));
        const run = startBridgeRun(
          bridge,
          { runId, agent: backend, prompt: text, instructions: CHAT_INSTRUCTIONS, mcpUrl: `${config.publicUrl.replace(/\/$/, '')}/mcp`, mcpToken: token, session: sess, threadId },
          {
            onLine,
            onStderr,
            onExit: (code, error) => {
              if (error) errorMessage ??= error;
              resolveExit(code);
            },
          },
        );
        return { kill: run.cancel, exited };
      } else {
        const url = `${config.localUrl}/mcp`;
        const workdir = path.join(config.dataDir, 'agent-workspaces', threadId);
        await fs.mkdir(workdir, { recursive: true });
        const args =
          backend === 'claude'
            ? claudeArgs(text, JSON.stringify({ mcpServers: { texdraft: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }), sess)
            : codexArgs(text, url, token, sess);

        const noProxy = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
        const child = spawn(bin!, args, {
          cwd: workdir,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: cliEnv({ NO_PROXY: noProxy, no_proxy: noProxy }),
        });
        const kill = () => {
          try {
            process.kill(-child.pid!, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        };
        let buf = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let idx: number;
          while ((idx = buf.indexOf('\n')) !== -1) {
            onLine(buf.slice(0, idx));
            buf = buf.slice(idx + 1);
          }
        });
        child.stderr.on('data', (c: Buffer) => onStderr(c.toString('utf8')));
        const exited = new Promise<number | null>((resolve) => {
          child.on('error', (err) => {
            onStderr(String(err));
            resolve(-1);
          });
          child.on('close', (c) => resolve(c));
        });
        return { kill, exited };
      }
    };

    let current = await execute(session, prompt);
    abort.signal.addEventListener('abort', () => current.kill());
    const timer = setTimeout(() => {
      errorMessage = zh ? '运行超时（20 分钟）' : 'Run timed out (20 minutes)';
      current.kill();
    }, RUN_TIMEOUT_MS);
    let code = await current.exited;

    // 要续接的会话在这台电脑上找不到（换了电脑、清理过 ~/.codex 或 ~/.claude）：开一个新会话重试一次，
    // 并把网页上保存的最近几轮对话作为背景交给它。只在 Agent 还没开始工作时这样做。
    const missing = `${stderr}\n${plainOut}\n${transcript.error ?? ''}\n${errorMessage ?? ''}`;
    if (session && code !== 0 && !abort.signal.aborted && !transcript.active && SESSION_MISSING_RE.test(missing)) {
      emit({
        type: 'progress',
        text: zh
          ? '（之前的会话在这台电脑上找不到，已开始新会话，并附上了最近的对话作为背景）'
          : '(The earlier session is not available on this computer; started a new one with the recent conversation as context)',
      });
      transcript.error = null;
      transcript.session = null;
      stderr = '';
      plainOut = '';
      errorMessage = undefined;
      current = await execute(null, (await recentConversation(threadId, runId, zh)) + prompt);
      code = await current.exited;
    }
    clearTimeout(timer);
    transcript.flushAssistant();

    if (abort.signal.aborted) status = 'stopped';
    else if (errorMessage || transcript.error || (code !== 0 && code !== null)) {
      status = 'error';
      errorMessage ??= transcript.error ?? `${backend} exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`;
      // 常见原因：本机 CLI 配置的模型当前账号不能用（例如 ChatGPT 账号登录的 Codex 不支持某些模型）
      if (/model_not_found|model is not supported|not supported when using Codex|invalid model/i.test(errorMessage)) {
        const where = bridge ? (zh ? '你电脑上' : 'on your computer') : (zh ? '服务器上' : 'on the server');
        errorMessage += zh
          ? `\n\n这是${where}的 ${backend === 'claude' ? 'Claude Code' : 'Codex'} 配置的模型不可用：请检查 ${backend === 'claude' ? '~/.claude/settings.json 里的 model' : '~/.codex/config.toml 里的 model'}（删掉这一行即使用默认模型），或升级到最新版本；先在终端里直接运行一次确认能用。`
          : `\n\nThe model configured for ${backend === 'claude' ? 'Claude Code' : 'Codex'} ${where} is not available: check the model setting in ${backend === 'claude' ? '~/.claude/settings.json' : '~/.codex/config.toml'} (remove it to use the default) or update to the latest version, and try it once in a terminal first.`;
      }
    }
    for (const m of transcript.messages) await persist(threadId, runId, m);
    if (transcript.session) await db.update(schema.chatThreads).set({ cliSession: transcript.session }).where(eq(schema.chatThreads.id, threadId));
  } catch (err) {
    status = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[cli] run failed', err);
  } finally {
    if (tokenId) {
      unbindRun(tokenId);
      await revokeToken(userId, tokenId).catch(() => {});
    }
    let changes: FileChangeSummary[] = [];
    let summarized = false;
    try {
      if (tracker) changes = await tracker.summarize(projectId);
      summarized = true;
    } catch (e) {
      console.error('[cli] summarize failed', e);
    }
    if (runId) {
      await db
        .update(schema.agentRuns)
        .set({ status, changes, error: errorMessage ?? null, finishedAt: new Date() })
        .where(eq(schema.agentRuns.id, runId))
        .catch((e) => console.error(e));
      activeRuns.delete(runId);
      if (summarized && changes.length === 0 && checkpointId) await discardCheckpoint(runId, checkpointId).catch((e) => console.error(e));
    }
    await db.update(schema.chatThreads).set({ updatedAt: new Date() }).where(eq(schema.chatThreads.id, threadId)).catch(() => {});
    busyThreads.delete(threadId);
    emit({ type: 'run_finished', runId, status, changes, error: errorMessage });
  }
}
