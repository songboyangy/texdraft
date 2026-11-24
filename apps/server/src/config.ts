import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelConfig } from './agent/providers/types.js';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env ${name}`);
  return v;
}

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const flag = (name: string, fallback = 'false') => ['1', 'true', 'yes'].includes(env(name, fallback).toLowerCase());
const num = (name: string, fallback: number) => {
  const n = Number(env(name, String(fallback)));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
/**
 * PUBLIC_DEMO=true：面向陌生人的公开体验站。打开一组保守的默认值（下面各项都可单独覆盖），
 * 并强制关闭服务器上的 CLI Agent 与自定义模型地址（它们以服务器身份运行 / 发起请求）。
 */
const demo = flag('PUBLIC_DEMO');

const dataDir = path.resolve(repoRoot, env('DATA_DIR', './data'));

/** Placeholder values that must never sign real sessions (old default, .env.example) */
const PLACEHOLDER_SECRETS = new Set(['dev-secret', 'change-me-to-a-long-random-string', 'change-me']);

/**
 * SESSION_SECRET signs session cookies and (unless AI_KEYS_SECRET is set) encrypts stored API keys.
 * Not set → generate a random one on first start and keep it in DATA_DIR/session-secret, so a server
 * started without configuration is still safe and stays logged in across restarts.
 */
function sessionSecret(): string {
  const v = process.env.SESSION_SECRET?.trim();
  if (v) {
    if (PLACEHOLDER_SECRETS.has(v)) {
      throw new Error('SESSION_SECRET is set to a placeholder value. Set it to a long random string (openssl rand -hex 32), or leave it empty to have one generated.');
    }
    return v;
  }
  const file = path.join(dataDir, 'session-secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {
    /* first start */
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, generated + '\n', { mode: 0o600, flag: 'wx' });
  console.warn(`[config] SESSION_SECRET is not set: generated one and saved it to ${file}. Back this file up with your data.`);
  return generated;
}
const secret = sessionSecret();

export const config = {
  port: Number(env('PORT', '8787')),
  /** 服务对外地址（本地 Agent 通过它访问 MCP），默认本机 */
  /** 允许“一键配置本机 Agent”（会写入服务器用户的 Claude Code / Codex / Gemini 配置，仅自托管单用户使用） */
  allowLocalAgentSetup: !demo && flag('ALLOW_LOCAL_AGENT_SETUP'),
  demo: {
    enabled: demo,
    /** 源码地址（AGPL：网络用户可获取源码）；设置后页脚显示链接 */
    sourceUrl: env('SOURCE_URL', ''),
    /** 页面顶部提示条；PUBLIC_DEMO 时默认显示体验站说明，设为 off 关闭 */
    notice: env('DEMO_NOTICE', demo ? 'default' : ''),
    /** Cloudflare Turnstile 人机验证（注册时）；两项都设置才启用 */
    turnstileSiteKey: env('TURNSTILE_SITE_KEY', ''),
    turnstileSecret: env('TURNSTILE_SECRET_KEY', ''),
    /** 新注册用户自动获得一份示例项目（中文短文 + 公式 + 参考文献） */
    sampleProject: flag('SAMPLE_PROJECT', demo ? 'true' : 'false'),
    /** Signed-out visitors to / see the product page (web/dist/landing/) instead of the sign-in form */
    landingPage: flag('LANDING_PAGE', demo ? 'true' : 'false'),
  },
  quota: {
    /** 每人最多拥有的项目数（0 = 不限；管理员不限） */
    maxProjectsPerUser: num('MAX_PROJECTS_PER_USER', demo ? 20 : 0),
    /** 单个项目的文件总大小上限（字节，0 = 不限） */
    maxProjectBytes: num('MAX_PROJECT_BYTES', demo ? 100 * 1024 * 1024 : 0),
    /** 同一 IP 每天最多注册账号数（0 = 不限） */
    registrationsPerIpPerDay: num('REGISTRATIONS_PER_IP_PER_DAY', demo ? 3 : 0),
    /** 同时进行的编译数上限，超出排队（0 = 不限；默认 CPU 核数） */
    compileConcurrency: num('COMPILE_CONCURRENCY', os.availableParallelism()),
    /** 每人每分钟最多发起的编译次数（0 = 不限；管理员不限） */
    compilesPerMinute: num('COMPILES_PER_MINUTE', demo ? 10 : 0),
  },
  publicUrl: env('PUBLIC_URL', `http://127.0.0.1:${env('PORT', '8787')}`),
  /** 旧域名（逗号分隔）：发到这些主机名的请求永久跳转到 PUBLIC_URL 的同一路径，用于换域名 */
  redirectHosts: env('REDIRECT_HOSTS', '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  /** 本机进程（服务器上的 Claude Code / Codex）访问 MCP 用的地址：直连，不绕公网/隧道 */
  localUrl: `http://127.0.0.1:${env('PORT', '8787')}`,
  databaseUrl: env('DATABASE_URL', 'postgres://texdraft@127.0.0.1:5433/texdraft'),
  sessionSecret: secret,
  dataDir,
  citations: {
    /** OpenAlex works without a key; a key or contact email raises its rate limits */
    openalexApiKey: env('OPENALEX_API_KEY', ''),
    openalexEmail: env('OPENALEX_EMAIL', ''),
  },
  compile: {
    runner: env('COMPILE_RUNNER', 'local-tectonic') as 'local-tectonic' | 'local-latexmk' | 'docker',
    timeoutMs: Number(env('COMPILE_TIMEOUT_MS', '90000')),
    dockerImage: env('COMPILE_DOCKER_IMAGE', 'texlive/texlive:latest'),
    /** 本机执行器的沙箱：auto（bubblewrap 优先，其次 uid）| bwrap | uid（root 运行时切换到 COMPILE_UID）| none（不隔离） */
    sandbox: env('COMPILE_SANDBOX', 'auto') as 'auto' | 'bwrap' | 'uid' | 'none',
    /** uid 模式的编译用户（服务以 root 运行时切换到该用户执行编译） */
    uid: process.env.COMPILE_UID ? Number(process.env.COMPILE_UID) : null,
    gid: process.env.COMPILE_GID ? Number(process.env.COMPILE_GID) : process.env.COMPILE_UID ? Number(process.env.COMPILE_UID) : null,
    /** 额外只读挂入沙箱的路径（冒号分隔），例如自定义安装的 TeX Live */
    sandboxExtraRo: env('COMPILE_SANDBOX_RO_PATHS', '').split(':').filter(Boolean),
  },
  agent: {
    maxSteps: Number(env('AGENT_MAX_STEPS', '40')),
    /** 上下文占用超过窗口的这个比例时自动压缩（清理旧工具结果 / 摘要早期对话） */
    compactAt: Math.min(0.95, Math.max(0.3, Number(env('AGENT_COMPACT_AT', '0.75')))),
    /** 服务端默认模型（用户未配置自己的 Key 时使用） */
    model: ((): ModelConfig => {
      /**
       * anthropic：Claude 官方接口，启用 adaptive thinking / effort / beta 特性
       * compatible：Anthropic 兼容接口（如 DeepSeek 的 https://api.deepseek.com/anthropic），只发送标准字段
       * openai：OpenAI Chat Completions 兼容接口（OpenAI、Gemini、通义、Kimi、智谱、OpenRouter、Ollama …）
       */
      const raw = env('AGENT_PROVIDER', 'anthropic');
      const provider = (['anthropic', 'compatible', 'openai'].includes(raw) ? raw : 'anthropic') as ModelConfig['provider'];
      const openai = provider === 'openai';
      const visionEnv = env('AGENT_VISION', 'auto').toLowerCase();
      const baseUrl = process.env.AGENT_BASE_URL || (openai ? process.env.OPENAI_BASE_URL : process.env.ANTHROPIC_BASE_URL) || undefined;
      return {
        provider,
        apiKey: process.env.AGENT_API_KEY || (openai ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) || '',
        baseUrl,
        model: env('AGENT_MODEL', openai ? 'gpt-5' : 'claude-opus-5-5'),
        maxTokens: Number(env('AGENT_MAX_TOKENS', provider === 'anthropic' ? '64000' : '8192')),
        effort: env('AGENT_EFFORT', 'high') as ModelConfig['effort'],
        betaFeatures: provider === 'anthropic' && !['0', 'false', 'no'].includes(env('AGENT_BETA_FEATURES', 'true').toLowerCase()),
        /** 模型能否看图（工具返回的 PDF 页面等）：auto = Claude 官方接口与 OpenAI 官方接口可以，其他兼容接口默认不可以 */
        vision: visionEnv === 'auto' ? provider === 'anthropic' || (openai && !baseUrl) : ['1', 'true', 'yes'].includes(visionEnv),
        contextWindow: Number(env('AGENT_CONTEXT_WINDOW', provider === 'anthropic' ? '200000' : '128000')),
      };
    })(),
  },

  /** 注册模式初始值：open（任何人）| invite（需要邀请码）| closed（仅管理员创建）；管理员可在后台修改 */
  registration: (['open', 'invite', 'closed'].includes(env('REGISTRATION', 'open')) ? env('REGISTRATION', 'open') : 'open') as 'open' | 'invite' | 'closed',
  /** 这些邮箱注册或登录时自动成为管理员（逗号分隔） */
  adminEmails: env('ADMIN_EMAILS', '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  ai: {
    /** 谁能使用服务器配置的 AI Key：all（所有人）| admins（仅管理员）| none（每人必须用自己的 Key） */
    sharedKey: (['all', 'admins', 'none'].includes(env('AI_SHARED_KEY', 'all')) ? env('AI_SHARED_KEY', 'all') : 'all') as 'all' | 'admins' | 'none',
    /** 使用服务器 Key 时每人每天的 token 上限（0 = 不限；管理员不受限） */
    sharedDailyTokens: Math.max(0, Number(env('AI_SHARED_DAILY_TOKENS', '0')) || 0),
    /** 使用服务器 Key 时每人的总额度（货币单位，例如 1 = ¥1；0 = 不限；管理员不受限，可在管理后台按人调整） */
    sharedCredit: Math.max(0, Number(env('AI_SHARED_CREDIT', '0')) || 0),
    /** 服务器模型的单价（每百万 tokens），用于计算额度消耗；默认按 DeepSeek Flash 高峰价 */
    price: {
      input: Math.max(0, Number(env('AI_PRICE_INPUT', '2')) || 0),
      cached: Math.max(0, Number(env('AI_PRICE_CACHED', '0.04')) || 0),
      output: Math.max(0, Number(env('AI_PRICE_OUTPUT', '8')) || 0),
    },
    /** 额度显示用的货币符号 */
    currency: env('AI_CURRENCY', '¥'),
    /** 谁能填写自定义接口地址：admins（默认）| all（仅限公网 https）| none */
    customBaseUrl: (demo ? 'none' : ['all', 'admins', 'none'].includes(env('AI_CUSTOM_BASE_URL', 'admins')) ? env('AI_CUSTOM_BASE_URL', 'admins') : 'admins') as 'all' | 'admins' | 'none',
    /** 加密用户 API Key 的密钥（默认取 SESSION_SECRET） */
    secret: process.env.AI_KEYS_SECRET || secret,
  },
  oauth: {
    /**
     * 允许作为 Client ID Metadata Document（CIMD）抓取的主机。client_id 是 https 地址时服务端会去抓取它，
     * 只放行这些主机以免被用来探测内网（SSRF）。其他客户端走动态注册（DCR）。
     */
    cimdHosts: env('OAUTH_CIMD_HOSTS', 'chatgpt.com,claude.ai').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  },
  /** 启动时加载的服务端插件（逗号分隔的包名或文件路径），见 plugins.ts 与 docs/plugins.md；TEXPILOT_PLUGINS 是改名前的变量名 */
  plugins: env('TEXDRAFT_PLUGINS', env('TEXPILOT_PLUGINS', '')).split(',').map((p) => p.trim()).filter(Boolean),
  limits: {
    maxTextFileBytes: 2 * 1024 * 1024,
    maxUploadBytes: 50 * 1024 * 1024,
  },
};

