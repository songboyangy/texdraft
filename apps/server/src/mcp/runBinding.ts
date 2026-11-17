import type { AgentEvent } from '@texdraft/shared';

/**
 * 聊天栏中由本机 CLI（Claude Code / Codex）执行的运行，会为其生成一个临时访问令牌。
 * MCP 收到该令牌的工具调用时，把修改记到这次运行上（改动汇总、实时事件），
 * 并且不再单独打检查点（运行开始时已经打过）。
 */
export interface RunBinding {
  runId: string;
  tracker: { touch(path: string): void };
  emit: (e: AgentEvent) => void;
}

const bindings = new Map<string, RunBinding>();

export const bindRun = (tokenId: string, b: RunBinding) => void bindings.set(tokenId, b);
export const unbindRun = (tokenId: string) => void bindings.delete(tokenId);
export const getRunBinding = (tokenId: string) => bindings.get(tokenId);
