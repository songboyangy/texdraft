import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDef } from '../../tools/types.js';

/**
 * 模型接口抽象（参考 OpenAI Agents SDK / LangChain 的 provider 适配层）。
 * 对话历史统一以 Anthropic Messages 格式保存（含思考块、图片工具结果）；各 provider 负责与自己的协议互转，
 * 并把流式输出统一成文本 / 思考 / 工具调用事件。
 */

export type Msg = Anthropic.Beta.BetaMessageParam;
export type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

export type ProviderId = 'anthropic' | 'compatible' | 'openai';

export interface ModelConfig {
  /** anthropic：Claude 官方接口；compatible：Anthropic 兼容接口（如 DeepSeek）；openai：OpenAI Chat Completions 兼容接口 */
  provider: ProviderId;
  apiKey: string;
  baseUrl?: string;
  model: string;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Claude 官方接口的 beta 特性（思考进度播报、拒答回退、工具参数流式） */
  betaFeatures: boolean;
  /** 模型能否看图（工具返回的 PDF 页面等） */
  vision: boolean;
  /** 上下文窗口（token），用于上下文管理 */
  contextWindow: number;
}

export type TurnEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id: string; name: string };

export interface TurnRequest {
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  maxTokens?: number;
  effort?: ModelConfig['effort'];
  signal?: AbortSignal;
  onEvent?: (e: TurnEvent) => void;
  /** 同一对话的稳定标识（部分网关要求，例如 OpenCode 的 x-opencode-session） */
  sessionId?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface TurnResult {
  /** 助手消息内容（规范格式：text / thinking / tool_use 块） */
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'stop_sequence';
  usage: Usage;
  /** 本次请求实际占用的上下文 token（输入 + 缓存），用于判断是否需要压缩 */
  contextTokens: number;
}

/** 输出格式问题（如工具参数 JSON 无法解析）：可以原样重发本轮 */
export class RetryableTurnError extends Error {}

/** 接口返回的错误（HTTP 状态码 + 信息），用于给用户可读的提示 */
export class ProviderHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ModelProvider {
  config: ModelConfig;
  streamTurn(req: TurnRequest): Promise<TurnResult>;
  /** 把接口错误转成给用户看的说明 */
  describeError(err: unknown, zh: boolean): string;
}

export const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
