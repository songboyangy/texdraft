import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LocalAgentId, LocalAgentStatus } from '@texdraft/shared';
import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { cliEnv } from '../agent/cli.js';
import { createToken } from './tokens.js';

/**
 * 一键配置本机 Agent（仅自托管、Agent 与服务端在同一台机器时使用，需 ALLOW_LOCAL_AGENT_SETUP=true）：
 * 自动生成访问令牌，并写入本机 Claude Code / Codex / Gemini CLI 的用户级 MCP 配置，用户无需接触令牌。
 */

const run = promisify(execFile);
const AUTO_TOKEN_NAME = 'Local agents (auto)';
const HOME = os.homedir();
const EXTRA_PATHS = [path.join(HOME, '.npm-global/bin'), path.join(HOME, '.local/bin'), '/usr/local/bin', '/usr/bin'];

const BIN: Record<LocalAgentId, string> = { claude: 'claude', codex: 'codex', gemini: 'gemini' };

function findBinary(name: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(':'), ...EXTRA_PATHS];
  for (const d of dirs) {
    const p = path.join(d, name);
    if (d && existsSync(p)) return p;
  }
  return null;
}


async function exec(bin: string, args: string[]) {
  return run(bin, args, { env: cliEnv(), timeout: 30_000, maxBuffer: 1 << 20 });
}

const mcpUrl = () => `${config.localUrl}/mcp`;

async function isConfigured(agent: LocalAgentId): Promise<boolean> {
  const files: Record<LocalAgentId, string> = {
    claude: path.join(HOME, '.claude.json'),
    codex: path.join(HOME, '.codex/config.toml'),
    gemini: path.join(HOME, '.gemini/settings.json'),
  };
  const text = await fs.readFile(files[agent], 'utf8').catch(() => '');
  if (agent === 'codex') return /\[mcp_servers\.texdraft\]/.test(text) && text.includes(mcpUrl());
  return text.includes('"texdraft"') && text.includes(mcpUrl());
}

export async function localAgentStatus(): Promise<{ enabled: boolean; url: string; agents: LocalAgentStatus[] }> {
  const agents = await Promise.all(
    (Object.keys(BIN) as LocalAgentId[]).map(async (id) => {
      const bin = findBinary(BIN[id]);
      return { id, installed: !!bin, configured: bin ? await isConfigured(id) : false };
    }),
  );
  return { enabled: config.allowLocalAgentSetup, url: mcpUrl(), agents };
}

/** Codex：移除旧条目后在 config.toml 末尾追加（请求头写在配置里，VS Code 启动的 Codex 也能读取） */
async function configureCodex(bin: string, token: string) {
  for (const n of ['texdraft', 'texpilot']) await exec(bin, ['mcp', 'remove', n]).catch(() => {}); // texpilot: name before the rename
  const file = path.join(HOME, '.codex/config.toml');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const prev = await fs.readFile(file, 'utf8').catch(() => '');
  const block = `\n[mcp_servers.texdraft]\nurl = "${mcpUrl()}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
  await fs.writeFile(file, prev.replace(/\s*$/, '\n') + block, { mode: 0o600 });
}

async function configureClaude(bin: string, token: string) {
  for (const n of ['texdraft', 'texpilot']) await exec(bin, ['mcp', 'remove', '-s', 'user', n]).catch(() => {}); // texpilot: name before the rename
  await exec(bin, ['mcp', 'add', '-s', 'user', '--transport', 'http', 'texdraft', mcpUrl(), '--header', `Authorization: Bearer ${token}`]);
}

async function configureGemini(bin: string, token: string) {
  for (const n of ['texdraft', 'texpilot']) await exec(bin, ['mcp', 'remove', '-s', 'user', n]).catch(() => {}); // texpilot: name before the rename
  await exec(bin, ['mcp', 'add', '-s', 'user', '-t', 'http', 'texdraft', mcpUrl(), '-H', `Authorization: Bearer ${token}`]);
}

export async function setupLocalAgents(userId: string) {
  if (!config.allowLocalAgentSetup) throw Object.assign(new Error('Local agent setup is disabled on this server'), { statusCode: 403 });
  // 每个用户只保留一个自动生成的令牌
  await db.delete(schema.apiTokens).where(and(eq(schema.apiTokens.userId, userId), eq(schema.apiTokens.name, AUTO_TOKEN_NAME)));
  const { token } = await createToken(userId, AUTO_TOKEN_NAME, null);

  const results: (LocalAgentStatus & { error?: string })[] = [];
  for (const id of Object.keys(BIN) as LocalAgentId[]) {
    const bin = findBinary(BIN[id]);
    if (!bin) {
      results.push({ id, installed: false, configured: false });
      continue;
    }
    try {
      if (id === 'claude') await configureClaude(bin, token);
      else if (id === 'codex') await configureCodex(bin, token);
      else await configureGemini(bin, token);
      results.push({ id, installed: true, configured: await isConfigured(id) });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      results.push({ id, installed: true, configured: false, error: (e.stderr || e.message || String(err)).slice(0, 300) });
    }
  }
  return { url: mcpUrl(), agents: results };
}
