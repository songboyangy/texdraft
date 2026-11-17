import type { AgentEvent } from '@texdraft/shared';
import type { z } from 'zod';

/**
 * 统一的工具定义：内置 Agent 与 MCP 服务共用同一份注册表（tools/registry.ts）。
 * 参考 Claude Code / MCP 的做法：每个工具声明自己的读写属性与所需权限，由调用方（Agent 循环、MCP 服务）统一处理
 * 权限校验、检查点、并行执行与结果格式。
 */

/** 工具执行中的“预期内”错误：作为 isError 的结果返回给模型，不记录为服务端异常 */
export class ToolError extends Error {}

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolContext {
  userId: string;
  /** 当前项目；scope 为 global 的工具为 null */
  projectId: string | null;
  /** 凭据只限一个项目（MCP 项目令牌、内置 Agent）：不能新建 / 列出其他项目 */
  scoped: boolean;
  /** 用于 Yjs 事务的 origin 与编译记录 */
  runId: string;
  /** 记录被改动的文件（运行结束时汇总 diff / 撤销） */
  touch(path: string): void;
  /** 推送给聊天界面的事件（文件变化、编译结果）；MCP 直连时为空实现 */
  emit(e: AgentEvent): void;
  /** 会话内缓存（如 search_citations 的结果供 add_citation 按序号取用） */
  cache: Map<string, unknown>;
}

/**
 * read：项目成员即可；edit：需要编辑权限（项目设置、版本）；
 * files：需要编辑权限并会改动文件（MCP 直连时首次调用前自动打检查点）
 */
export type ToolAccess = 'read' | 'edit' | 'files';

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** 参数 JSON Schema（不含 MCP 的 project 参数，由 MCP 层统一添加） */
  inputSchema: Record<string, unknown>;
  /** 可选的严格校验（流式工具参数可能被截断，必须在服务端校验） */
  schema?: z.ZodTypeAny;
  scope: 'project' | 'global';
  access: ToolAccess;
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
  /** 暴露给内置 Agent / MCP */
  agent: boolean;
  mcp: boolean;
  /** MCP tools/list 的附加 _meta（如 ChatGPT 的 openai/fileParams） */
  meta?: Record<string, unknown>;
  /** 给界面看的操作对象（路径、搜索词…）；动作名称由前端按语言显示 */
  summarize?(input: Record<string, unknown>): string;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | string>;
}

export const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
