import dns from 'node:dns/promises';
import net from 'node:net';
import { eq } from 'drizzle-orm';
import type { ModelConfig } from '../agent/providers/types.js';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { HttpError } from '../lib/http.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { AI_PRESETS, presetById } from './presets.js';
import { checkQuota, quotaStatus, usageToday, type ModelSource } from './quota.js';

/**
 * 每个用户使用哪个模型：
 *  1. 用户在「账号设置」里配置了自己的服务与 Key → 用自己的（source = own）
 *  2. 否则按 AI_SHARED_KEY 决定能否使用服务器的 Key（all / admins / none），并受额度约束（见 quota.ts）
 *  3. 都不满足 → 提示去配置自己的 Key
 */

export type { ModelSource };

export class AiNotConfiguredError extends HttpError {
  constructor(zh: boolean) {
    super(400, zh ? '还没有可用的 AI 模型：请在「账号设置 → AI 模型」里填写你自己的 API Key。' : 'No AI model available: add your own API key in Account settings → AI model.');
  }
}

export function sharedAllowed(isAdmin: boolean) {
  const p = config.ai.sharedKey;
  return !!config.agent.model.apiKey && (p === 'all' || (p === 'admins' && isAdmin));
}

/** 解析用户当前使用的模型配置 */
export async function resolveModel(userId: string, isAdmin: boolean, zh: boolean): Promise<{ cfg: ModelConfig; source: ModelSource }> {
  const [s] = await db.select().from(schema.userAiSettings).where(eq(schema.userAiSettings.userId, userId));
  if (s && (s.apiKeyEnc || s.preset === 'custom')) {
    const apiKey = s.apiKeyEnc ? decryptSecret(s.apiKeyEnc) : '';
    if (apiKey === null) {
      throw new HttpError(400, zh ? '保存的 API Key 无法解密（服务器密钥已更换），请在「账号设置」里重新填写。' : 'Your saved API key can no longer be decrypted (the server secret changed). Please enter it again in Account settings.');
    }
    const preset = presetById(s.preset) ?? presetById('custom')!;
    return {
      source: 'own',
      cfg: {
        provider: s.provider as ModelConfig['provider'],
        apiKey: apiKey || 'none',
        baseUrl: s.baseUrl ?? undefined,
        model: s.model,
        maxTokens: s.maxTokens ?? preset.maxTokens,
        effort: config.agent.model.effort,
        betaFeatures: s.provider === 'anthropic' && config.agent.model.betaFeatures,
        vision: s.vision ?? preset.vision,
        contextWindow: s.contextWindow ?? preset.contextWindow,
      },
    };
  }
  if (sharedAllowed(isAdmin)) {
    await checkQuota({ userId, isAdmin, zh });
    return { cfg: { ...config.agent.model }, source: 'shared' };
  }
  throw new AiNotConfiguredError(zh);
}

// ---------------- 读写设置 ----------------

export interface AiSettingsInput {
  preset: string;
  provider?: ModelConfig['provider'];
  baseUrl?: string | null;
  model: string;
  /** 不传 = 保留已保存的 Key；空字符串 = 清除 */
  apiKey?: string;
  maxTokens?: number | null;
  vision?: boolean | null;
  contextWindow?: number | null;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/** 自定义接口地址：按 AI_CUSTOM_BASE_URL 决定谁能用；非管理员只能用公网 https 地址（防止探测内网） */
async function checkCustomBaseUrl(raw: string, isAdmin: boolean, zh: boolean) {
  const policy = config.ai.customBaseUrl;
  if (policy === 'none' || (policy === 'admins' && !isAdmin)) {
    throw new HttpError(403, zh ? '自定义接口地址只对管理员开放，请选择一个预设服务。' : 'Custom endpoints are limited to administrators; choose a preset provider.');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, zh ? '接口地址无效' : 'Invalid base URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, zh ? '接口地址必须是 http(s)' : 'The base URL must be http(s)');
  if (isAdmin) return;
  if (u.protocol !== 'https:') throw new HttpError(400, zh ? '接口地址必须使用 https' : 'The base URL must use https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new HttpError(400, zh ? '接口地址不能指向内网或本机' : 'The base URL must not point to a private or local address');
}

export async function saveSettings(userId: string, isAdmin: boolean, input: AiSettingsInput, zh: boolean) {
  const preset = presetById(input.preset);
  if (!preset) throw new HttpError(400, 'Unknown preset');
  const model = input.model.trim();
  if (!model || model.length > 200) throw new HttpError(400, zh ? '请填写模型名' : 'Enter a model name');
  let provider = preset.provider;
  let baseUrl: string | null = preset.baseUrl;
  if (preset.id === 'custom') {
    provider = input.provider && ['anthropic', 'compatible', 'openai'].includes(input.provider) ? input.provider : 'openai';
    baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '') || null;
    if (!baseUrl && provider !== 'anthropic') throw new HttpError(400, zh ? '请填写接口地址' : 'Enter the base URL');
    if (baseUrl) await checkCustomBaseUrl(baseUrl, isAdmin, zh);
  }
  const [existing] = await db.select().from(schema.userAiSettings).where(eq(schema.userAiSettings.userId, userId));
  let apiKeyEnc = existing?.apiKeyEnc ?? null;
  let keyHint = existing?.keyHint ?? null;
  if (input.apiKey !== undefined) {
    const k = input.apiKey.trim();
    if (k.length > 500) throw new HttpError(400, 'API key too long');
    apiKeyEnc = k ? encryptSecret(k) : null;
    keyHint = k ? k.slice(-4) : null;
  }
  if (!apiKeyEnc && preset.id !== 'custom') throw new HttpError(400, zh ? '请填写 API Key' : 'Enter an API key');
  const clamp = (v: number | null | undefined, lo: number, hi: number) => (v == null ? null : Math.min(hi, Math.max(lo, Math.floor(v))));
  const row = {
    preset: preset.id,
    provider,
    baseUrl,
    model,
    apiKeyEnc,
    keyHint,
    maxTokens: clamp(input.maxTokens, 256, 200000),
    vision: input.vision ?? null,
    contextWindow: clamp(input.contextWindow, 8000, 2000000),
    updatedAt: new Date(),
  };
  await db.insert(schema.userAiSettings).values({ userId, ...row }).onConflictDoUpdate({ target: schema.userAiSettings.userId, set: row });
}

export async function deleteSettings(userId: string) {
  await db.delete(schema.userAiSettings).where(eq(schema.userAiSettings.userId, userId));
}

/** 给前端看的设置（不含 Key 本身） */
export async function publicSettings(userId: string, isAdmin: boolean) {
  const shared = sharedAllowed(isAdmin);
  const [s] = await db.select().from(schema.userAiSettings).where(eq(schema.userAiSettings.userId, userId));
  return {
    settings: s
      ? {
          preset: s.preset,
          provider: s.provider,
          baseUrl: s.baseUrl,
          model: s.model,
          hasKey: !!s.apiKeyEnc,
          keyHint: s.keyHint,
          keyReadable: !s.apiKeyEnc || decryptSecret(s.apiKeyEnc) !== null,
          maxTokens: s.maxTokens,
          vision: s.vision,
          contextWindow: s.contextWindow,
        }
      : null,
    presets: AI_PRESETS.map(({ id, name, provider, baseUrl, models, vision, contextWindow, maxTokens, keyUrl }) => ({ id, name, provider, baseUrl, models, vision, contextWindow, maxTokens, keyUrl })),
    shared: {
      available: shared,
      provider: config.agent.model.provider,
      model: config.agent.model.model,
      ...(shared ? await quotaStatus({ userId, isAdmin }) : { dailyTokens: 0, credit: null }),
    },
    customBaseUrlAllowed: config.ai.customBaseUrl === 'all' || (config.ai.customBaseUrl === 'admins' && isAdmin),
    usage: { own: await usageToday(userId, 'own'), shared: await usageToday(userId, 'shared') },
  };
}

/** 把表单里的设置（可能未保存）组装成模型配置，用于“测试连接”；apiKey 未填时用已保存的 */
export async function configForTest(userId: string, isAdmin: boolean, input: AiSettingsInput, zh: boolean): Promise<ModelConfig> {
  const preset = presetById(input.preset);
  if (!preset) throw new HttpError(400, 'Unknown preset');
  let provider = preset.provider;
  let baseUrl = preset.baseUrl ?? undefined;
  if (preset.id === 'custom') {
    provider = input.provider ?? 'openai';
    baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '') || undefined;
    if (baseUrl) await checkCustomBaseUrl(baseUrl, isAdmin, zh);
  }
  let apiKey = input.apiKey?.trim();
  if (!apiKey) {
    const [s] = await db.select().from(schema.userAiSettings).where(eq(schema.userAiSettings.userId, userId));
    apiKey = s?.apiKeyEnc ? decryptSecret(s.apiKeyEnc) ?? '' : '';
  }
  if (!apiKey && preset.id !== 'custom') throw new HttpError(400, zh ? '请填写 API Key' : 'Enter an API key');
  return {
    provider,
    apiKey: apiKey || 'none',
    baseUrl,
    model: input.model.trim(),
    maxTokens: 64,
    effort: 'low',
    betaFeatures: false,
    vision: false,
    contextWindow: preset.contextWindow,
  };
}
