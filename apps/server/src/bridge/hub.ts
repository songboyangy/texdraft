import crypto from 'node:crypto';
import fs from 'node:fs';
import type { WebSocket } from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { userStatus } from '../lib/userStatus.js';
import { authenticateToken } from '../mcp/tokens.js';

/**
 * 本地桥接：用户在自己电脑上运行 texdraft-bridge，它主动连到 /mcp/bridge（内网电脑也能连），
 * 网页聊天栏选择「我的电脑 · Codex / Claude Code」时，服务端把这次运行交给它执行，
 * 它把 CLI 的 JSON 事件逐行回传，服务端按与本机 CLI 相同的方式解析、展示和保存。
 *
 * 协议（JSON 文本帧）：
 *   bridge → server  { type: 'auth', token }                     连接后 10 秒内必须发送（用户的 API 令牌）
 *   server → bridge  { type: 'hello', user }
 *   bridge → server  { type: 'register', hostname, platform, version, agents: [{ id, version }] }
 *   server → bridge  { type: 'run', runId, agent, prompt, instructions, mcpUrl, mcpToken, session, threadId }
 *   bridge → server  { type: 'line', runId, line } | { type: 'stderr', runId, text } | { type: 'exit', runId, code, error? }
 *   server → bridge  { type: 'cancel', runId }
 * 桥接程序只会运行 codex / claude，命令行参数由它自己按模板组装；服务端只提供结构化参数。
 */

export type BridgeAgent = 'claude' | 'codex';
export const BRIDGE_AGENTS: BridgeAgent[] = ['claude', 'codex'];

interface RunHandlers {
  onLine: (line: string) => void;
  onStderr: (text: string) => void;
  onExit: (code: number | null, error?: string) => void;
}

export interface BridgeConn {
  id: string;
  userId: string;
  tokenId: string;
  hostname: string;
  platform: string;
  version: string;
  agents: { id: BridgeAgent; version: string }[];
  connectedAt: Date;
  socket: WebSocket;
  runs: Map<string, RunHandlers>;
}

const byUser = new Map<string, BridgeConn[]>();

/** 当前发布的桥接程序版本（读自 texdraft-bridge.mjs）；用户电脑上的旧版本在对话框里提示更新 */
export const LATEST_BRIDGE_VERSION = (() => {
  try {
    return /const VERSION = '([^']+)'/.exec(fs.readFileSync(new URL('./texdraft-bridge.mjs', import.meta.url), 'utf8'))?.[1] ?? '';
  } catch {
    return '';
  }
})();
const older = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};

const send = (c: BridgeConn | { socket: WebSocket }, msg: unknown) => {
  if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
};

/** 当前用户在线的桥接（以及它们提供的 Agent） */
export function listBridges(userId: string) {
  return (byUser.get(userId) ?? []).map((c) => ({
    id: c.id,
    hostname: c.hostname,
    platform: c.platform,
    version: c.version,
    agents: c.agents,
    connectedAt: c.connectedAt.toISOString(),
    outdated: !!LATEST_BRIDGE_VERSION && older(c.version, LATEST_BRIDGE_VERSION),
  }));
}

/** 用户可用的桥接 Agent（任意一台在线电脑提供即可） */
export function bridgeAgents(userId: string): BridgeAgent[] {
  const set = new Set<BridgeAgent>();
  for (const c of byUser.get(userId) ?? []) for (const a of c.agents) set.add(a.id);
  return BRIDGE_AGENTS.filter((a) => set.has(a));
}

/** 选一台提供该 Agent 的在线电脑（最近连接的优先）；同时确认桥接令牌仍然有效 */
export async function pickBridge(userId: string, agent: BridgeAgent): Promise<BridgeConn | null> {
  const list = (byUser.get(userId) ?? []).filter((c) => c.agents.some((a) => a.id === agent));
  for (const c of [...list].reverse()) {
    const [row] = await db.select({ id: schema.apiTokens.id }).from(schema.apiTokens).where(eq(schema.apiTokens.id, c.tokenId));
    if (row && !(await userStatus(userId)).disabled) return c;
    c.socket.close(4401, 'token revoked');
  }
  return null;
}

/** 在桥接上启动一次运行 */
export function startBridgeRun(
  conn: BridgeConn,
  params: { runId: string; agent: BridgeAgent; prompt: string; instructions: string; mcpUrl: string; mcpToken: string; session: string | null; threadId: string },
  handlers: RunHandlers,
) {
  conn.runs.set(params.runId, handlers);
  send(conn, { type: 'run', ...params });
  return {
    cancel: () => send(conn, { type: 'cancel', runId: params.runId }),
  };
}

function remove(conn: BridgeConn, reason: string) {
  const list = byUser.get(conn.userId)?.filter((c) => c !== conn) ?? [];
  if (list.length) byUser.set(conn.userId, list);
  else byUser.delete(conn.userId);
  // 断开时正在进行的运行：以错误结束
  for (const [runId, h] of conn.runs) {
    h.onExit(null, reason);
    conn.runs.delete(runId);
  }
}

const AGENT_RE = /^(claude|codex)$/;
const clip = (v: unknown, n: number) => String(v ?? '').slice(0, n);

/** 处理一条新的 /mcp/bridge WebSocket 连接 */
export function handleBridgeSocket(socket: WebSocket) {
  let conn: BridgeConn | null = null;
  let authed: { userId: string; tokenId: string } | null = null;
  const authTimer = setTimeout(() => socket.close(4401, 'auth timeout'), 10_000);
  // 心跳：60 秒没有回应就断开（Cloudflare 等代理也需要定期流量保持连接）
  let alive = true;
  socket.on('pong', () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return socket.terminate();
    alive = false;
    socket.ping();
  }, 30_000);

  socket.on('message', async (raw: Buffer | string) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!authed) {
      if (msg.type !== 'auth' || typeof msg.token !== 'string') return socket.close(4401, 'auth required');
      const auth = await authenticateToken(`Bearer ${msg.token}`);
      // 桥接令牌必须是“全部项目”的普通令牌（运行时另发限定到项目的临时令牌）
      if (!auth || auth.projectId) return socket.close(4401, 'invalid token');
      authed = { userId: auth.userId, tokenId: auth.tokenId };
      clearTimeout(authTimer);
      const [u] = await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, auth.userId));
      send({ socket }, { type: 'hello', user: { name: u?.name, email: u?.email } });
      return;
    }
    if (msg.type === 'register') {
      const agents = (Array.isArray(msg.agents) ? msg.agents : [])
        .filter((a): a is { id: string; version?: string } => !!a && typeof a === 'object' && AGENT_RE.test(String((a as { id?: unknown }).id)))
        .map((a) => ({ id: a.id as BridgeAgent, version: clip(a.version, 60) }));
      if (conn) remove(conn, 'bridge re-registered');
      conn = {
        id: crypto.randomUUID(),
        userId: authed.userId,
        tokenId: authed.tokenId,
        hostname: clip(msg.hostname, 80) || 'computer',
        platform: clip(msg.platform, 40),
        version: clip(msg.version, 20),
        agents,
        connectedAt: new Date(),
        socket,
        runs: new Map(),
      };
      byUser.set(authed.userId, [...(byUser.get(authed.userId) ?? []), conn]);
      return;
    }
    if (!conn) return;
    const runId = typeof msg.runId === 'string' ? msg.runId : '';
    const h = conn.runs.get(runId);
    if (!h) return;
    if (msg.type === 'line' && typeof msg.line === 'string') h.onLine(msg.line.slice(0, 2_000_000));
    else if (msg.type === 'stderr' && typeof msg.text === 'string') h.onStderr(msg.text.slice(0, 20_000));
    else if (msg.type === 'exit') {
      conn.runs.delete(runId);
      h.onExit(typeof msg.code === 'number' ? msg.code : null, typeof msg.error === 'string' ? msg.error.slice(0, 500) : undefined);
    }
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    clearInterval(ping);
    if (conn) remove(conn, 'Your computer disconnected from TeXdraft (texdraft-bridge stopped or lost its connection).');
  });
  socket.on('error', () => {});
}
