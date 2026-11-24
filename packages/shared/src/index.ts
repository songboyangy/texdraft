// 前后端共享的类型定义

export type Role = 'owner' | 'editor' | 'viewer';
export type FileKind = 'text' | 'binary';
export type Engine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface User {
  id: string;
  email: string;
  name: string;
  isAdmin?: boolean;
}

export type RegistrationMode = 'open' | 'invite' | 'closed';

export interface AuthConfig {
  registration: RegistrationMode;
  /** 还没有任何账号：第一个注册的人成为管理员 */
  firstUser: boolean;
  /** 公开体验站（PUBLIC_DEMO） */
  demo: boolean;
  /** 源码地址（AGPL），页脚显示 */
  sourceUrl: string | null;
  /** 顶部提示条：'default' 显示内置的体验站说明，其他字符串原样显示；null 不显示 */
  notice: string | null;
  /** 启用注册人机验证时的 Turnstile site key */
  turnstileSiteKey: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: string;
  ownedProjects: number;
  aiTokensToday: number;
  ownAiKey: boolean;
  /** 累计使用服务器 AI 的花费（货币单位） */
  aiSpent: number;
  /** 管理员单独设置的总额度；null = 使用默认值 */
  aiCredit: number | null;
}

export interface AdminAiPolicy {
  sharedKey: 'all' | 'admins' | 'none';
  /** 默认总额度（AI_SHARED_CREDIT）；null = 不限 */
  defaultCredit: number | null;
  dailyTokens: number;
  currency: string;
}

export interface AiPresetInfo {
  id: string;
  name: string;
  provider: 'anthropic' | 'compatible' | 'openai';
  baseUrl: string | null;
  models: string[];
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  keyUrl?: string;
}

export interface AiUsageDay {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface AiSettingsView {
  settings: {
    preset: string;
    provider: string;
    baseUrl: string | null;
    model: string;
    hasKey: boolean;
    keyHint: string | null;
    keyReadable: boolean;
    maxTokens: number | null;
    vision: boolean | null;
    contextWindow: number | null;
  } | null;
  presets: AiPresetInfo[];
  shared: {
    available: boolean;
    provider: string;
    model: string;
    dailyTokens: number;
    /** 服务器 AI 总额度与已用；不限时为 null（管理员始终为 null） */
    credit: { limit: number; spent: number; currency: string } | null;
  };
  customBaseUrlAllowed: boolean;
  usage: { own: AiUsageDay; shared: AiUsageDay };
}

export interface AiSettingsInput {
  preset: string;
  provider?: 'anthropic' | 'compatible' | 'openai';
  baseUrl?: string | null;
  model: string;
  apiKey?: string;
  maxTokens?: number | null;
  vision?: boolean | null;
  contextWindow?: number | null;
}

export interface InviteSummary {
  id: string;
  prefix: string;
  note: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
  status: 'active' | 'used' | 'expired' | 'revoked';
}

export interface ProjectSummary {
  id: string;
  name: string;
  role: Role;
  updatedAt: string;
  /** 当前用户给这个项目打的标签（ProjectTag.id）；只在项目列表中返回 */
  tags?: string[];
}

/** 项目标签：每个用户自己的分类 */
export interface ProjectTag {
  id: string;
  name: string;
  /** 带这个标签、且当前用户仍能访问的项目数 */
  count: number;
}

export interface ProjectDetail extends ProjectSummary {
  mainFile: string;
  engine: Engine;
}

export interface FileEntry {
  id: string;
  path: string;
  kind: FileKind;
  size: number;
  updatedAt: string;
}

// ---------- 编译 ----------

export interface CompileDiagnostic {
  level: 'error' | 'warning' | 'badbox';
  message: string;
  file?: string;
  line?: number;
}

export interface CompileResult {
  jobId: string;
  ok: boolean; // 是否生成了 PDF
  status: 'success' | 'failure' | 'timeout' | 'error';
  durationMs: number;
  pdfUrl?: string;
  diagnostics: CompileDiagnostic[];
  logTail: string;
}

// ---------- 项目事件（SSE 推送给所有在线成员） ----------

export type ProjectEvent =
  | { type: 'files_changed' }
  | { type: 'compile_started'; by: string }
  /** 服务器编译繁忙，本次编译在排队（position 从 1 开始；0 = 排队结束、开始编译） */
  | { type: 'compile_queued'; position: number }
  | { type: 'compile_finished'; result: CompileResult };

// ---------- Agent ----------

export interface AgentContext {
  activePath?: string;
  cursorLine?: number;
  selection?: string;
}

export interface FileChangeSummary {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  patch: string; // unified diff
}

export type AgentEvent =
  | { type: 'run_started'; runId: string; threadId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'progress'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_input'; id: string; name: string; summary: string }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'file_changed'; path: string; action: FileChangeSummary['action'] }
  | { type: 'compile_result'; result: CompileResult }
  | {
      type: 'run_finished';
      runId: string;
      status: 'completed' | 'stopped' | 'error';
      changes: FileChangeSummary[];
      error?: string;
    };

/** 聊天记录在界面上的展示单元（由服务端从原始消息转换而来） */
export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'progress'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; ok?: boolean; result?: string }
  | { kind: 'run_summary'; runId: string; status: string; changes: FileChangeSummary[]; reverted: boolean };

/** 聊天后端：TeXdraft 内置 Agent，或服务器本机已登录的 CLI Agent */
/** builtin = 内置 AI；claude / codex = 服务器上的 CLI（管理员）；bridge-* = 用户自己电脑上的 CLI（经 texdraft-bridge） */
export type ChatBackend = 'builtin' | 'claude' | 'codex' | 'bridge-claude' | 'bridge-codex';

export interface BridgeInfo {
  id: string;
  hostname: string;
  platform: string;
  version: string;
  agents: { id: 'claude' | 'codex'; version: string }[];
  connectedAt: string;
  /** 比服务器提供的桥接程序旧，需要重新下载 */
  outdated: boolean;
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  backend: ChatBackend;
}

// ---------- 编辑器辅助 ----------

/** 自动补全用的项目符号 */
export interface ProjectSymbols {
  labels: { label: string; file: string; line: number; context: string }[];
  citations: { key: string; title?: string; author?: string; type: string }[];
  commands: string[];
  files: string[];
}

export interface PdfRect { x: number; y: number; w: number; h: number }

/** SyncTeX：源码 → PDF */
export interface SynctexForward { page: number; line: number; rects: PdfRect[] }
/** SyncTeX：PDF → 源码 */
export interface SynctexReverse { file: string; line: number }

// ---------- 全项目搜索 ----------

export interface SearchQuery {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  length: number;
  /** 匹配所在行的片段；previewOffset 为匹配在片段中的起始位置 */
  preview: string;
  previewOffset: number;
}

// ---------- 选中文字 AI ----------

export type TransformAction = 'polish' | 'translate' | 'shorten' | 'expand' | 'grammar' | 'explain' | 'custom';

export type TransformEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

// ---------- 文献 ----------

export interface CitationSearchResult {
  source: 'crossref' | 'arxiv' | 'openalex';
  /** Crossref 为 DOI，arXiv 为编号（不含版本），OpenAlex 为作品 ID（W…） */
  id: string;
  /** Times cited (Crossref / OpenAlex); used to rank the original paper above later reprints */
  citedBy?: number;
  /** arXiv id of an OpenAlex record (from its arXiv location or arXiv DOI) */
  arxivId?: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  type?: string;
  url?: string;
  doi?: string;
  category?: string;
}

export interface AddCitationResult {
  key: string;
  bibPath: string;
  added: boolean;
  bibtex?: string;
  needsBibliography: boolean;
}

// ---------- 历史版本 ----------

export type VersionKind = 'checkpoint' | 'manual' | 'auto' | 'restore';

export interface VersionSummary {
  id: string;
  kind: VersionKind;
  label: string | null;
  createdAt: string;
  author: string | null;
  fileCount: number;
  /** checkpoint：对应的那次 AI 运行改了哪些文件（不含 patch） */
  run?: {
    status: string;
    reverted: boolean;
    changes: { path: string; action: 'created' | 'modified' | 'deleted'; additions: number; deletions: number }[];
  } | null;
}

export interface VersionDiff {
  versionId: string;
  createdAt: string;
  files: {
    path: string;
    status: 'added' | 'removed' | 'modified' | 'unchanged';
    binary: boolean;
    additions: number;
    deletions: number;
    /** 版本 → 当前 的 unified diff（文本文件） */
    patch: string;
  }[];
}

// ---------- 访问令牌（MCP / 本地 Agent） ----------

export interface ApiTokenSummary {
  id: string;
  name: string;
  /** 令牌前缀，便于辨认（完整令牌只在创建时返回一次） */
  prefix: string;
  projectId: string | null;
  projectName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export type LocalAgentId = 'claude' | 'codex' | 'gemini';
export interface LocalAgentStatus {
  id: LocalAgentId;
  installed: boolean;
  configured: boolean;
  error?: string;
}
