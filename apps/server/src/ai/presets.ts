import type { ModelConfig } from '../agent/providers/types.js';

/**
 * 模型服务预设：选择后自动填好接口协议与地址，用户只需填 Key 与模型名（模型名可改）。
 * custom：自定义地址（默认只有管理员可用，见 AI_CUSTOM_BASE_URL）。
 */
export interface AiPreset {
  id: string;
  name: string;
  provider: ModelConfig['provider'];
  baseUrl: string | null;
  models: string[];
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  keyUrl?: string;
}

export const AI_PRESETS: AiPreset[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', provider: 'anthropic', baseUrl: null, models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], vision: true, contextWindow: 200000, maxTokens: 64000, keyUrl: 'https://console.anthropic.com/' },
  { id: 'openai', name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', models: [], vision: true, contextWindow: 128000, maxTokens: 16000, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', provider: 'compatible', baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-flash', 'deepseek-v4-pro'], vision: false, contextWindow: 128000, maxTokens: 8192, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'gemini', name: 'Google Gemini', provider: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: [], vision: true, contextWindow: 1000000, maxTokens: 16000, keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'qwen', name: '通义千问 Qwen (DashScope)', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max'], vision: false, contextWindow: 128000, maxTokens: 8192, keyUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'moonshot', name: 'Kimi (Moonshot)', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: [], vision: false, contextWindow: 128000, maxTokens: 8192, keyUrl: 'https://platform.moonshot.cn/' },
  { id: 'zhipu', name: '智谱 GLM', provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [], vision: false, contextWindow: 128000, maxTokens: 8192, keyUrl: 'https://open.bigmodel.cn/' },
  { id: 'openrouter', name: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: [], vision: false, contextWindow: 128000, maxTokens: 8192, keyUrl: 'https://openrouter.ai/keys' },
  { id: 'custom', name: 'Custom', provider: 'openai', baseUrl: null, models: [], vision: false, contextWindow: 128000, maxTokens: 8192 },
];

export const presetById = (id: string) => AI_PRESETS.find((p) => p.id === id);
