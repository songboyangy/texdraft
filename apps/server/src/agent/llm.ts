import { createProvider, defaultModelConfig, type ModelConfig, type Usage } from './providers/index.js';

/**
 * 单次文本生成（无工具），流式回调增量文本。用于选中文字的润色 / 翻译 / 解释等轻量任务。
 * 走与 Agent 相同的 provider 抽象；Claude 官方接口用低 effort 保证速度。
 */
export async function streamText(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  model?: ModelConfig;
  onUsage?: (u: Usage) => void;
}): Promise<string> {
  const provider = createProvider(opts.model ?? defaultModelConfig());
  const turn = await provider.streamTurn({
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    tools: [],
    maxTokens: opts.maxTokens ?? 4096,
    effort: 'low',
    signal: opts.signal,
    onEvent: (e) => {
      if (e.type === 'text') opts.onDelta(e.text);
    },
  });
  opts.onUsage?.(turn.usage);
  if (turn.stopReason === 'refusal') throw new Error('The model declined this request.');
  return turn.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function describeLlmError(err: unknown, zh: boolean, model?: ModelConfig): string {
  return createProvider(model ?? defaultModelConfig()).describeError(err, zh);
}
