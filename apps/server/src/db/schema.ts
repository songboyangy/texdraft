import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial, boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import type { CompileDiagnostic, FileChangeSummary } from '@texdraft/shared';

export interface ThreadContextState {
  /** 已从模型视图中清理掉内容的工具结果（tool_use_id） */
  clearedToolUseIds?: string[];
  /** 早期对话的摘要，以及它覆盖到的最后一条消息 id */
  summary?: string;
  summaryUpto?: number;
  /** 最近一次请求实际占用的上下文 token */
  lastContextTokens?: number;
  compactions?: number;
}

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => new Uint8Array(v),
});

const ts = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  /** 被管理员禁用：无法登录，已有会话与访问令牌立即失效 */
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  /** 早于此时刻签发的会话作废（重置 / 修改密码时更新） */
  sessionsValidAfter: timestamp('sessions_valid_after', { withTimezone: true }),
  /** 使用服务器 AI 的总额度（百万分之一货币单位）；null = 使用 AI_SHARED_CREDIT 默认值 */
  aiCreditMicros: bigint('ai_credit_micros', { mode: 'number' }),
  createdAt: ts('created_at'),
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  mainFile: text('main_file').notNull().default('main.tex'),
  engine: text('engine').notNull().default('pdflatex'),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
});

export const projectMembers = pgTable('project_members', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // owner | editor | viewer
}, (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index('members_user_idx').on(t.userId)]);

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  kind: text('kind').notNull(), // text | binary
  blobKey: text('blob_key'),
  size: integer('size').notNull().default(0),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
}, (t) => [uniqueIndex('files_project_path_uq').on(t.projectId, t.path)]);

/** 项目标签：每个用户自己的分类（同一项目可以有多个标签；共享项目各人各自归类，互不影响） */
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: ts('created_at'),
}, (t) => [uniqueIndex('tags_user_name_uq').on(t.userId, t.name)]);

export const projectTags = pgTable('project_tags', {
  tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.tagId, t.projectId] }), index('project_tags_project_idx').on(t.projectId)]);

/**
 * 显式创建的文件夹（可以为空）。项目里的文件夹 = 这里的路径 ∪ 文件路径中隐含的目录；
 * 文件夹被移走或删除时这里的记录随之更新，里面有文件时记录可以保留也可以没有。
 */
export const folders = pgTable('folders', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  createdAt: ts('created_at'),
}, (t) => [primaryKey({ columns: [t.projectId, t.path] })]);

/** 文本文件的 Yjs 文档状态（Hocuspocus 持久化） */
export const docStates = pgTable('doc_states', {
  fileId: uuid('file_id').primaryKey().references(() => files.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: ts('updated_at'),
});

export interface SnapshotFile { path: string; kind: 'text' | 'binary'; content?: string; blobKey?: string | null; size: number }

/** 项目快照：Agent 检查点 / 手动版本 */
export const versions = pgTable('versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // checkpoint | manual
  label: text('label'),
  snapshot: jsonb('snapshot').$type<{ files: SnapshotFile[] }>().notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: ts('created_at'),
});

export const chatThreads = pgTable('chat_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('新对话'),
  /** 对话使用的后端：builtin（TeXdraft 内置 Agent）或本机 CLI（claude / codex） */
  backend: text('backend').notNull().default('builtin'),
  /** CLI 自己的会话 id，用于多轮对话时 resume */
  cliSession: text('cli_session'),
  /** 上下文管理状态（发给模型的视图；chat_messages 中的完整记录不变）：已清理的工具结果、早期对话摘要 */
  context: jsonb('context').$type<ThreadContextState>().notNull().default(sql`'{}'::jsonb`),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
}, (t) => [index('threads_project_user_idx').on(t.projectId, t.userId)]);

/** 原样保存 Claude Messages API 的消息（只追加，不修改） */
export const chatMessages = pgTable('chat_messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  threadId: uuid('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  runId: uuid('run_id'),
  role: text('role').notNull(), // user | assistant
  content: jsonb('content').notNull(),
  createdAt: ts('created_at'),
}, (t) => [index('messages_thread_idx').on(t.threadId, t.id)]);

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  status: text('status').notNull().default('running'), // running | completed | stopped | error
  checkpointId: uuid('checkpoint_id').references(() => versions.id),
  changes: jsonb('changes').$type<FileChangeSummary[]>().notNull().default(sql`'[]'::jsonb`),
  reverted: integer('reverted').notNull().default(0),
  error: text('error'),
  usage: jsonb('usage').$type<Record<string, number>>(),
  createdAt: ts('created_at'),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const compileJobs = pgTable('compile_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status').notNull(), // running | success | failure | timeout | error
  engine: text('engine').notNull(),
  durationMs: integer('duration_ms'),
  pdfKey: text('pdf_key'),
  logKey: text('log_key'),
  synctexKey: text('synctex_key'),
  diagnostics: jsonb('diagnostics').$type<CompileDiagnostic[]>(),
  createdAt: ts('created_at'),
}, (t) => [index('compile_project_idx').on(t.projectId, t.createdAt)]);

/** 个人访问令牌（MCP / 本地 Agent 使用）；只保存 SHA-256 哈希 */
export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  /** 令牌前几位，便于在列表中辨认 */
  prefix: text('prefix').notNull(),
  /** 限定到单个项目；为空表示可访问该用户的所有项目 */
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (t) => [index('tokens_user_idx').on(t.userId)]);

/**
 * OAuth 2.1（供 ChatGPT / Claude.ai 等远程 MCP 客户端接入）
 *  - oauth_clients：动态注册（DCR）的客户端，或缓存的 Client ID Metadata Document（CIMD，client_id 是 https 地址）
 *  - oauth_codes：授权码（一次性，10 分钟有效），只存哈希
 *  - oauth_grants：一次授权 = 一条访问令牌记录（api_tokens，可在“连接本地 Agent”里撤销）+ 轮换的访问/刷新令牌哈希
 */
export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  kind: text('kind').notNull(), // dcr | cimd
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  createdAt: ts('created_at'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
});

export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scope: text('scope').notNull(),
  resource: text('resource'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const oauthGrants = pgTable('oauth_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  apiTokenId: uuid('api_token_id').notNull().references(() => apiTokens.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  scope: text('scope').notNull(),
  resource: text('resource'),
  accessHash: text('access_hash').notNull().unique(),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
  refreshHash: text('refresh_hash').notNull().unique(),
  /** 轮换前的刷新令牌：短暂宽限期内仍可用，防止客户端重试时被锁死 */
  prevRefreshHash: text('prev_refresh_hash'),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
  createdAt: ts('created_at'),
}, (t) => [index('oauth_grants_token_idx').on(t.apiTokenId)]);

/** 注册邀请码（只存哈希；链接只在创建时显示一次） */
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeHash: text('code_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  note: text('note').notNull().default(''),
  maxUses: integer('max_uses').notNull().default(1),
  uses: integer('uses').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: ts('created_at'),
});

/** 站点设置（管理员在界面里修改；环境变量只提供初始默认值） */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at'),
});

/** 用户自己的 AI 设置（API Key 以 AES-256-GCM 加密保存，接口只返回末四位） */
export const userAiSettings = pgTable('user_ai_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  /** 预设（anthropic / openai / deepseek …）或 custom */
  preset: text('preset').notNull(),
  provider: text('provider').notNull(), // anthropic | compatible | openai
  baseUrl: text('base_url'),
  model: text('model').notNull(),
  apiKeyEnc: text('api_key_enc'),
  keyHint: text('key_hint'),
  maxTokens: integer('max_tokens'),
  vision: boolean('vision'),
  contextWindow: integer('context_window'),
  updatedAt: ts('updated_at'),
});

/** 每人每天的 AI 用量（own：自己的 Key；shared：服务器的 Key，受每日上限约束） */
export const aiUsage = pgTable('ai_usage', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  day: text('day').notNull(), // YYYY-MM-DD（UTC）
  source: text('source').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  /** inputTokens 中命中缓存的部分 */
  cachedTokens: integer('cached_tokens').notNull().default(0),
  /** 按 AI_PRICE_* 计算的费用（百万分之一货币单位），仅 shared 记录 */
  costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
  requests: integer('requests').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.userId, t.day, t.source] })]);

/**
 * 编辑记录（只记元数据，不记内容）：谁、何时、通过什么方式改了哪个文件、改了多少、大致在哪几行。
 * 浏览器里的连续输入按“人 + 文件”合并成一条；服务端修改（AI、上传、恢复版本等）每次一条。保留 90 天。
 */
export const editLog = pgTable('edit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id').notNull(),
  /** 浏览器编辑者；服务端修改时为空 */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  /** editor = 浏览器实时编辑；server = 服务端写入 */
  source: text('source').notNull(),
  /** 服务端写入的来源，例如 agent:<runId>、upload、restore-version、mcp-apply-patch */
  origin: text('origin'),
  insertedChars: integer('inserted_chars').notNull().default(0),
  deletedChars: integer('deleted_chars').notNull().default(0),
  insertedLines: integer('inserted_lines').notNull().default(0),
  deletedLines: integer('deleted_lines').notNull().default(0),
  /** 修改涉及的行号范围（修改后的文档中，从 1 开始） */
  fromLine: integer('from_line'),
  toLine: integer('to_line'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('edit_log_project_idx').on(t.projectId, t.createdAt), index('edit_log_file_idx').on(t.fileId, t.createdAt)]);
