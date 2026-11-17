import crypto from 'node:crypto';
import type { ToolDef } from '../../tools/types.js';
import {
  emptyUsage,
  ProviderHttpError,
  RetryableTurnError,
  type ContentBlock,
  type ModelConfig,
  type ModelProvider,
  type Msg,
  type TurnRequest,
  type TurnResult,
} from './types.js';

/**
 * OpenAI Chat Completions 兼容接口（provider = openai）：OpenAI、Gemini（OpenAI 兼容端点）、通义千问、Kimi、智谱、
 * OpenRouter、Ollama、vLLM 等。规范格式（Anthropic 消息）与 Chat Completions 互转：
 *  - tool_use ↔ assistant.tool_calls；tool_result → role: tool 消息
 *  - tool_result 中的图片无法放进 tool 消息：作为紧随其后的 user 消息附上（模型支持看图时）
 *  - 思考块不回传；流式的 reasoning_content（DeepSeek / Qwen 等）作为进度显示
 */

type OAMessage =
  | { role: 'system' | 'user'; content: string | OAPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OAToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
type OAPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OAToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

const isBlocks = (c: Msg['content']): c is ContentBlock[] => Array.isArray(c);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text as string).join('\n');
}

function imagesOf(content: unknown): OAPart[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b?.type === 'image' && b.source?.type === 'base64')
    .map((b) => ({ type: 'image_url' as const, image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }));
}

export function toOpenAIMessages(system: string, messages: Msg[], vision: boolean): OAMessage[] {
  const out: OAMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    const blocks: ContentBlock[] = isBlocks(m.content) ? m.content : [{ type: 'text', text: m.content as string }];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const tu = b as { id: string; name: string; input: unknown };
          return { id: tu.id, type: 'function' as const, function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) } };
        });
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user：先是工具结果（必须紧跟在带 tool_calls 的 assistant 之后），再是普通内容
    const toolImages: OAPart[] = [];
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      const tr = b as { tool_use_id: string; content?: unknown; is_error?: boolean };
      const imgs = imagesOf(tr.content);
      toolImages.push(...imgs);
      let text = textOf(tr.content);
      if (imgs.length) text += vision ? `\n(${imgs.length} image(s) attached in the next message)` : `\n(${imgs.length} image(s) omitted: the model cannot view images)`;
      out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: (tr.is_error ? 'ERROR: ' : '') + (text || '(empty)') });
    }
    if (vision && toolImages.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...toolImages] });
    const parts: OAPart[] = [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ type: 'text', text: (b as { text: string }).text });
      else if (b.type === 'image' && vision) parts.push(...imagesOf([b]));
    }
    if (parts.length) out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n\n') : parts });
  }
  return out;
}

const toolParams = (tools: ToolDef[]) =>
  tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

/** 读取 SSE 流中的 data 行 */
async function* sseData(body: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}

export function openaiProvider(cfg: ModelConfig): ModelProvider {
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const official = /(^|\.)openai\.com$/i.test(new URL(base).hostname);
  return {
    config: cfg,
    async streamTurn(req: TurnRequest): Promise<TurnResult> {
      const maxTokens = Math.min(req.maxTokens ?? cfg.maxTokens, cfg.maxTokens);
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: toOpenAIMessages(req.system, req.messages, cfg.vision),
        stream: true,
        stream_options: { include_usage: true },
        // OpenAI 官方的新模型只接受 max_completion_tokens；兼容接口普遍使用 max_tokens
        ...(official ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
        ...(req.tools.length ? { tools: toolParams(req.tools), tool_choice: 'auto' } : {}),
      };
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
          accept: 'text/event-stream',
          // 网关据此识别客户端；OpenCode 还要求每个对话带固定的 x-opencode-session
          'user-agent': 'TeXdraft (+https://github.com/songboyangy/texdraft)',
          ...(req.sessionId && /(^|\.)opencode\.ai$/.test(hostOf(base)) ? { 'x-opencode-session': req.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        let msg = text.slice(0, 500);
        try {
          const j = JSON.parse(text);
          msg = j.error?.message ?? j.message ?? msg;
        } catch {}
        throw new ProviderHttpError(res.status, msg || res.statusText);
      }

      let text = '';
      let reasoning = '';
      let finish: string | null = null;
      const calls = new Map<number, { id: string; name: string; args: string; announced: boolean }>();
      const usage = emptyUsage();
      let contextTokens = 0;
      for await (const data of sseData(res.body)) {
        if (!data || data === '[DONE]') continue;
        let chunk: {
          choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
          error?: { message?: string };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new ProviderHttpError(500, chunk.error.message ?? 'stream error');
        const choice = chunk.choices?.[0];
        const d = choice?.delta;
        if (d?.content) {
          text += d.content;
          req.onEvent?.({ type: 'text', text: d.content });
        }
        const r = d?.reasoning_content ?? d?.reasoning;
        if (r) {
          reasoning += r;
          req.onEvent?.({ type: 'thinking', text: r });
        }
        for (const tc of d?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: '', name: '', args: '', announced: false };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
          if (!cur.announced && cur.name) {
            cur.announced = true;
            if (!cur.id) cur.id = `call_${crypto.randomBytes(8).toString('hex')}`;
            req.onEvent?.({ type: 'tool_start', id: cur.id, name: cur.name });
          }
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) {
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage.input_tokens = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached);
          usage.cache_read_input_tokens = cached;
          usage.output_tokens = chunk.usage.completion_tokens ?? 0;
          contextTokens = (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0);
        }
      }

      const content: ContentBlock[] = [];
      // 推理过程存为无签名的思考块：界面历史里显示为进度；发给 Claude 前会被过滤（没有有效签名）
      if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: '' });
      if (text) content.push({ type: 'text', text });
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        let input: unknown = {};
        if (c.args.trim()) {
          try {
            input = JSON.parse(c.args);
          } catch {
            // 被截断的参数：交给工具校验报错让模型重试；其他情况重发本轮
            if (finish !== 'length') throw new RetryableTurnError(`Could not parse arguments of tool call ${c.name}`);
            input = {};
          }
        }
        content.push({ type: 'tool_use', id: c.id || `call_${crypto.randomBytes(8).toString('hex')}`, name: c.name, input });
      }
      const stopReason: TurnResult['stopReason'] =
        finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : calls.size ? 'tool_use' : 'end_turn';
      return { content, stopReason, usage, contextTokens };
    },
    describeError(err, zh) {
      if (err instanceof ProviderHttpError) {
        if (err.status === 401 || err.status === 403) return zh ? `AI 服务认证失败：请检查 API Key（${err.message}）` : `AI service authentication failed: check the API key (${err.message})`;
        if (err.status === 429) return zh ? `AI 服务限流或额度不足：${err.message}` : `AI service rate limited or out of quota: ${err.message}`;
        if (err.status === 404) return zh ? `接口地址或模型不存在：${err.message}` : `Endpoint or model not found: ${err.message}`;
        return zh ? `AI 服务错误 ${err.status}：${err.message}` : `AI service error ${err.status}: ${err.message}`;
      }
      if (err instanceof TypeError) return zh ? `无法连接 AI 服务（检查网络 / 代理或接口地址）：${err.message}` : `Cannot reach the AI service (check network / proxy or the base URL): ${err.message}`;
      return err instanceof Error ? err.message : String(err);
    },
  };
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
