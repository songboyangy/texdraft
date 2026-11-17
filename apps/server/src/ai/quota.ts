import { and, eq, sql } from 'drizzle-orm';
import type { Usage } from '../agent/providers/types.js';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { HttpError } from '../lib/http.js';

/**
 * Quota and metering for AI calls. The rest of the server only talks to the active QuotaProvider
 * (via checkQuota / recordUsage / quotaStatus below) and never computes costs or limits itself,
 * so a deployment can swap in its own policy (plans, top-ups, organisation budgets…) from a plugin
 * (see plugins.ts) without touching this repository.
 *
 * The built-in provider implements what a self-hosted server needs: an optional per-user daily
 * token cap (AI_SHARED_DAILY_TOKENS) and an optional total credit priced from AI_PRICE_*
 * (AI_SHARED_CREDIT, adjustable per user in the admin page). Usage with a user's own key is
 * recorded for their statistics but never limited or charged.
 */

/** 'own' = the user's own API key; 'shared' = the server's key */
export type ModelSource = 'own' | 'shared';

export interface QuotaContext {
  userId: string;
  isAdmin: boolean;
  /** language for error messages */
  zh: boolean;
}

/** What the UI shows about the server-key allowance */
export interface QuotaStatus {
  /** daily token cap; 0 = none */
  dailyTokens: number;
  /** total credit in currency units; null = none shown */
  credit: { limit: number; spent: number; currency: string } | null;
}

export interface QuotaProvider {
  readonly name: string;
  /**
   * Called before a request on the server's key (and between agent steps). Throw an HttpError
   * (usually 429) with a user-facing message to refuse; the agent stops and keeps its edits.
   */
  check(ctx: QuotaContext): Promise<void>;
  /** Called after every model response with that response's token usage. */
  record(userId: string, source: ModelSource, usage: Partial<Usage>): Promise<void>;
  /** Allowance shown in the chat panel and account settings (only asked when the shared key is available). */
  status(ctx: Omit<QuotaContext, 'zh'>): Promise<QuotaStatus>;
}

// ---------------------------------------------------------------------------
// Usage statistics (shared by every provider: the ai_usage table)
// ---------------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

export async function usageToday(userId: string, source: ModelSource) {
  const [r] = await db
    .select()
    .from(schema.aiUsage)
    .where(and(eq(schema.aiUsage.userId, userId), eq(schema.aiUsage.day, today()), eq(schema.aiUsage.source, source)));
  return { inputTokens: r?.inputTokens ?? 0, outputTokens: r?.outputTokens ?? 0, requests: r?.requests ?? 0 };
}

/** Adds one response to today's ai_usage row; costMicros is the provider's price for it (0 = free). */
export async function addUsage(userId: string, source: ModelSource, u: Partial<Usage>, costMicros = 0) {
  const uncached = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const cached = u.cache_read_input_tokens ?? 0;
  const input = uncached + cached;
  const output = u.output_tokens ?? 0;
  await db
    .insert(schema.aiUsage)
    .values({ userId, day: today(), source, inputTokens: input, cachedTokens: cached, outputTokens: output, costMicros, requests: 1 })
    .onConflictDoUpdate({
      target: [schema.aiUsage.userId, schema.aiUsage.day, schema.aiUsage.source],
      set: {
        inputTokens: sql`${schema.aiUsage.inputTokens} + ${input}`,
        cachedTokens: sql`${schema.aiUsage.cachedTokens} + ${cached}`,
        costMicros: sql`${schema.aiUsage.costMicros} + ${costMicros}`,
        outputTokens: sql`${schema.aiUsage.outputTokens} + ${output}`,
        requests: sql`${schema.aiUsage.requests} + 1`,
      },
    });
}

// ---------------------------------------------------------------------------
// Built-in provider: daily token cap + total credit
// ---------------------------------------------------------------------------

const MICROS = 1_000_000;

/** 按服务器单价计算一次调用的费用（百万分之一货币单位）。单价是每百万 tokens，所以 tokens × 单价 正好是 micros */
export function costMicros(input: number, cached: number, output: number) {
  const p = config.ai.price;
  return Math.ceil(input * p.input + cached * p.cached + output * p.output);
}

/** 某用户使用服务器 AI 的总额度（micros）；null = 不限。管理员单独设置的值优先（0 = 不提供免费额度） */
async function creditLimitMicros(userId: string): Promise<number | null> {
  const [u] = await db.select({ c: schema.users.aiCreditMicros }).from(schema.users).where(eq(schema.users.id, userId));
  if (u?.c != null) return u.c;
  return config.ai.sharedCredit > 0 ? Math.round(config.ai.sharedCredit * MICROS) : null;
}

/** 某用户累计在服务器 AI 上花费的额度（micros） */
async function creditSpentMicros(userId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<string>`coalesce(sum(${schema.aiUsage.costMicros}), 0)` })
    .from(schema.aiUsage)
    .where(and(eq(schema.aiUsage.userId, userId), eq(schema.aiUsage.source, 'shared')));
  return Number(r?.s ?? 0);
}

const money = (micros: number) => `${config.ai.currency}${(micros / MICROS).toFixed(2)}`;

export const builtinQuota: QuotaProvider = {
  name: 'builtin',

  /** 非管理员使用服务器 AI 前检查总额度与每日上限，超出时抛出带说明的错误 */
  async check({ userId, isAdmin, zh }) {
    if (isAdmin) return;
    const limit = await creditLimitMicros(userId);
    if (limit !== null) {
      const spent = await creditSpentMicros(userId);
      if (spent >= limit) {
        throw new HttpError(429, zh
          ? `服务器提供的免费 AI 额度（${money(limit)}）已用完。请在「账号设置 → AI 模型」里填写你自己的 API Key 继续使用。`
          : `You have used up the free server AI credit (${money(limit)}). Add your own API key in Account settings → AI model to keep going.`);
      }
    }
    const daily = config.ai.sharedDailyTokens;
    if (daily > 0) {
      const used = await usageToday(userId, 'shared');
      if (used.inputTokens + used.outputTokens >= daily) {
        throw new HttpError(429, zh
          ? `今天使用服务器 AI 的额度（${daily.toLocaleString()} tokens）已用完。可以明天再试，或在「账号设置」里填写你自己的 API Key。`
          : `You have used today's server AI allowance (${daily.toLocaleString()} tokens). Try again tomorrow or add your own API key in Account settings.`);
      }
    }
  },

  async record(userId, source, u) {
    // 只有服务器的 Key 计费；自带 Key 的费用由用户自己的账号承担
    const uncached = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const cost = source === 'shared' ? costMicros(uncached, u.cache_read_input_tokens ?? 0, u.output_tokens ?? 0) : 0;
    await addUsage(userId, source, u, cost);
  },

  // 管理员不受额度限制
  async status({ userId, isAdmin }) {
    if (isAdmin) return { dailyTokens: 0, credit: null };
    const limit = await creditLimitMicros(userId);
    return {
      dailyTokens: config.ai.sharedDailyTokens,
      credit: limit === null ? null : { limit: limit / MICROS, spent: (await creditSpentMicros(userId)) / MICROS, currency: config.ai.currency },
    };
  },
};

// ---------------------------------------------------------------------------
// Active provider
// ---------------------------------------------------------------------------

let active: QuotaProvider = builtinQuota;

/** Replaces the quota provider (called by a plugin at startup). */
export function setQuotaProvider(p: QuotaProvider) {
  active = p;
}

export const quotaProviderName = () => active.name;
export const checkQuota = (ctx: QuotaContext) => active.check(ctx);
export const recordUsage = (userId: string, source: ModelSource, u: Partial<Usage>) => active.record(userId, source, u);
export const quotaStatus = (ctx: Omit<QuotaContext, 'zh'>) => active.status(ctx);
