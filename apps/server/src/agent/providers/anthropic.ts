import Anthropic from '@anthropic-ai/sdk';
import type { ToolDef } from '../../tools/types.js';
import { emptyUsage, RetryableTurnError, type ModelConfig, type ModelProvider, type Msg, type TurnRequest, type TurnResult } from './types.js';

/**
 * Claude 官方接口（provider = anthropic）与 Anthropic 兼容接口（provider = compatible，如 DeepSeek）。
 * 官方接口启用 adaptive thinking、effort、前缀缓存与 beta 特性；兼容接口只发送标准字段。
 */

const clients = new Map<string, Anthropic>();
function client(cfg: ModelConfig) {
  const key = `${cfg.baseUrl ?? ''}\n${cfg.apiKey}`;
  let c = clients.get(key);
  if (!c) {
    c = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
    clients.set(key, c);
  }
  return c;
}

function toolParams(tools: ToolDef[], cfg: ModelConfig): Anthropic.Beta.BetaToolUnion[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    // 流式请求 + 客户端工具：参数边生成边下发（write_file 的大段内容不会长时间“卡住”）
    ...(cfg.provider === 'anthropic' && cfg.betaFeatures ? { eager_input_streaming: true } : {}),
  }));
}

/**
 * 去掉无法回传给 Claude 的思考块：来自其他接口（OpenAI 兼容接口的推理过程）的思考块没有签名，
 * 同一对话中途切换接口时保留它们会被拒绝。
 */
function sanitize(messages: Msg[]): Msg[] {
  return messages.map((m) =>
    m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'thinking' && !(b as { signature?: string }).signature)
      ? { ...m, content: m.content.filter((b) => !(b.type === 'thinking' && !(b as { signature?: string }).signature)) }
      : m,
  );
}

export function anthropicProvider(cfg: ModelConfig): ModelProvider {
  return {
    config: cfg,
    async streamTurn(req: TurnRequest): Promise<TurnResult> {
      const c = client(cfg);
      const maxTokens = Math.min(req.maxTokens ?? cfg.maxTokens, cfg.maxTokens);
      const tools = req.tools.length ? toolParams(req.tools, cfg) : undefined;
      const beta = cfg.betaFeatures;
      const messages = sanitize(req.messages);
      const stream =
        cfg.provider === 'compatible'
          ? // 兼容接口：只发标准 Messages 字段，走非 beta 端点（事件格式相同，统一按 beta 类型处理）
            (c.messages.stream(
              { model: cfg.model, max_tokens: maxTokens, system: req.system, ...(tools ? { tools: tools as Anthropic.Tool[] } : {}), messages: messages as Anthropic.MessageParam[] },
              { signal: req.signal },
            ) as unknown as ReturnType<Anthropic['beta']['messages']['stream']>)
          : c.beta.messages.stream(
              {
                model: cfg.model,
                max_tokens: maxTokens,
                system: req.system,
                ...(tools ? { tools } : {}),
                messages,
                // 思考始终开启，用 effort 控制深度；display=updates 让工具调用间的进度播报以文本返回
                thinking: { type: 'adaptive', display: beta ? 'updates' : 'summarized' },
                output_config: { effort: req.effort ?? cfg.effort },
                cache_control: { type: 'ephemeral' },
                ...(beta ? { betas: ['thinking-display-updates-2026-08-18', 'server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
              },
              { signal: req.signal },
            );

      let message: Anthropic.Beta.BetaMessage;
      try {
        for await (const ev of stream) {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
            req.onEvent?.({ type: 'tool_start', id: ev.content_block.id, name: ev.content_block.name });
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta.type === 'text_delta') req.onEvent?.({ type: 'text', text: ev.delta.text });
            else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) req.onEvent?.({ type: 'thinking', text: ev.delta.thinking });
          }
        }
        message = await stream.finalMessage();
      } catch (err) {
        // 工具参数 JSON 完全无法解析（eager_input_streaming 下可能发生）：SDK 以基类 AnthropicError 抛出，可重发；
        // APIError 子类是真正的接口错误
        if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && !(err instanceof Anthropic.APIUserAbortError)) {
          throw new RetryableTurnError(err.message);
        }
        throw err;
      }
      const usage = emptyUsage();
      for (const k of Object.keys(usage) as (keyof typeof usage)[]) {
        const v = (message.usage as unknown as Record<string, unknown>)?.[k];
        if (typeof v === 'number') usage[k] = v;
      }
      return {
        content: message.content as TurnResult['content'],
        stopReason: (message.stop_reason ?? 'end_turn') as TurnResult['stopReason'],
        usage,
        contextTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
      };
    },
    describeError(err, zh) {
      if (err instanceof Anthropic.AuthenticationError) return zh ? 'AI 服务认证失败：请检查 API Key' : 'AI service authentication failed: check the API key';
      if (err instanceof Anthropic.RateLimitError) return zh ? 'AI 服务限流，请稍后再试' : 'AI service is rate limited, please try again later';
      if (err instanceof Anthropic.BadRequestError) return zh ? `AI 请求被拒绝：${err.message}` : `AI request rejected: ${err.message}`;
      if (err instanceof Anthropic.APIConnectionError) return zh ? '无法连接 AI 服务（检查网络 / 代理或接口地址）' : 'Cannot reach the AI service (check network / proxy or the base URL)';
      if (err instanceof Anthropic.APIError) return zh ? `AI 服务错误 ${err.status ?? ''}：${err.message}` : `AI service error ${err.status ?? ''}: ${err.message}`;
      return err instanceof Error ? err.message : String(err);
    },
  };
}
