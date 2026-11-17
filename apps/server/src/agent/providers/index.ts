import { config } from '../../config.js';
import { anthropicProvider } from './anthropic.js';
import { openaiProvider } from './openai.js';
import type { ModelConfig, ModelProvider } from './types.js';

export * from './types.js';

/** 服务端默认的模型配置（环境变量） */
export function defaultModelConfig(): ModelConfig {
  return { ...config.agent.model };
}

export function createProvider(cfg: ModelConfig): ModelProvider {
  return cfg.provider === 'openai' ? openaiProvider(cfg) : anthropicProvider(cfg);
}
