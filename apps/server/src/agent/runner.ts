import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext, AgentEvent, FileChangeSummary } from '@texdraft/shared';
import { and, asc, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { conflict, notFound } from '../lib/http.js';
import { ChangeTracker, createCheckpoint, discardCheckpoint } from './checkpoint.js';
import { SYSTEM_PROMPT, buildContextBlock } from './prompt.js';
import { createProvider, RetryableTurnError, type ModelProvider } from './providers/index.js';
import { resolveModel } from '../ai/settings.js';
import { checkQuota, recordUsage } from '../ai/quota.js';
import { userStatus } from '../lib/userStatus.js';
import { estimateOverhead, estimateTokens, manageContext, modelView, type StoredMsg } from './context.js';
import type { ThreadContextState } from '../db/schema.js';
import { agentTools, executeTool, summarizeToolInput } from '../tools/registry.js';
import type { ToolContext, ToolResult } from '../tools/types.js';

type Msg = Anthropic.Beta.BetaMessageParam;


const AGENT_TOOLS = agentTools();
const READ_ONLY_TOOLS = new Set(AGENT_TOOLS.filter((t) => t.readOnly).map((t) => t.name));
const isReadOnly = (name: string) => READ_ONLY_TOOLS.has(name);

/** 工具结果 → tool_result 内容：模型支持看图时附上图片（如 PDF 页面），否则只给文字 */
function toResultContent(r: ToolResult, vision: boolean): Anthropic.Beta.BetaToolResultBlockParam['content'] {
  const images = r.content.filter((c) => c.type === 'image');
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  if (!images.length) return texts.join('\n');
  if (!vision) return [...texts, `(${images.length} image(s) omitted: the configured model cannot view images; use the extracted text)`].join('\n');
  return r.content.map((c) =>
    c.type === 'text'
      ? { type: 'text' as const, text: c.text }
      : { type: 'image' as const, source: { type: 'base64' as const, media_type: c.mimeType as 'image/png', data: c.data } },
  );
}

/** 正在进行的运行：runId -> 中止控制器 */
export const activeRuns = new Map<string, { abort: AbortController; threadId: string; userId: string }>();
export const busyThreads = new Set<string>();

export function getActiveRunForThread(threadId: string) {
  for (const [runId, r] of activeRuns) if (r.threadId === threadId) return runId;
  return null;
}

export function stopRun(runId: string, userId: string) {
  const r = activeRuns.get(runId);
  if (!r) return false;
  if (r.userId !== userId) throw notFound('Run not found');
  r.abort.abort();
  return true;
}

export async function resolveThread(projectId: string, userId: string, threadId: string | undefined, firstMessage: string, backend = 'builtin') {
  if (threadId) {
    const [t] = await db
      .select()
      .from(schema.chatThreads)
      .where(and(eq(schema.chatThreads.id, threadId), eq(schema.chatThreads.projectId, projectId), eq(schema.chatThreads.userId, userId)));
    if (!t) throw notFound('Thread not found');
    return { id: t.id, backend: t.backend };
  }
  const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 40) || '新对话';
  const [t] = await db.insert(schema.chatThreads).values({ projectId, userId, title, backend }).returning();
  return { id: t.id, backend: t.backend };
}

/** 完整的对话记录（带消息 id，供上下文管理定位） */
export async function loadRows(threadId: string): Promise<StoredMsg[]> {
  const rows = await db
    .select({ id: schema.chatMessages.id, role: schema.chatMessages.role, content: schema.chatMessages.content })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.threadId, threadId))
    .orderBy(asc(schema.chatMessages.id));
  return rows.map((r) => ({ id: r.id, msg: { role: r.role, content: r.content } as Msg }));
}

export async function persist(threadId: string, runId: string, msg: Msg): Promise<number> {
  const [row] = await db
    .insert(schema.chatMessages)
    .values({ threadId, runId, role: msg.role, content: msg.content as object })
    .returning({ id: schema.chatMessages.id });
  return row.id;
}

async function saveContextState(threadId: string, state: ThreadContextState) {
  await db.update(schema.chatThreads).set({ context: state }).where(eq(schema.chatThreads.id, threadId));
}

export interface RunInput {
  /** 界面语言：决定系统插入的提示文字（步数上限、拒答等）用中文还是英文 */
  lang?: 'zh-CN' | 'en';
  projectId: string;
  userId: string;
  threadId: string;
  message: string;
  context: AgentContext;
  emit: (e: AgentEvent) => void;
}

/**
 * 执行一轮对话：用户消息 → (模型 ⇄ 工具)* → 结束。
 * 对话以 Messages API 原始格式只追加地保存，下一轮原样回放（保证 thinking 块与前缀缓存有效）。
 */
export async function runAgent(input: RunInput): Promise<void> {
  const { projectId, userId, threadId, emit } = input;
  const zh = input.lang !== 'en';
  if (busyThreads.has(threadId)) throw conflict('This conversation already has a running request');
  busyThreads.add(threadId);

  let runId = '';
  let status: 'completed' | 'stopped' | 'error' = 'completed';
  let errorMessage: string | undefined;
  let tracker: ChangeTracker | null = null;
  let providerForErrors: ModelProvider | null = null;
  /** 运行结束时保存的上下文状态（finally 中访问） */
  const ctxStateRef: { current: ThreadContextState | null } = { current: null };
  let checkpointId: string | null = null;
  const usage: Record<string, number> = {};
  const abort = new AbortController();

  try {
    const checkpoint = await createCheckpoint(projectId, userId, `AI: ${input.message.slice(0, 60)}`);
    checkpointId = checkpoint.id;
    const [run] = await db
      .insert(schema.agentRuns)
      .values({ threadId, projectId, userId, checkpointId: checkpoint.id })
      .returning({ id: schema.agentRuns.id });
    runId = run.id;
    activeRuns.set(runId, { abort, threadId, userId });
    tracker = new ChangeTracker(checkpoint.files);
    emit({ type: 'run_started', runId, threadId });

    const rows = await loadRows(threadId);
    const [threadRow] = await db.select({ context: schema.chatThreads.context }).from(schema.chatThreads).where(eq(schema.chatThreads.id, threadId));
    let ctxState: ThreadContextState = threadRow?.context ?? {};
    ctxStateRef.current = ctxState;
    const userMsg: Msg = {
      role: 'user',
      content: [
        { type: 'text', text: await buildContextBlock(projectId, input.context) },
        { type: 'text', text: input.message },
      ],
    };
    // 上下文占用：最近一次请求的实际值 + 之后新增内容的估算；旧对话没有记录时整段估算
    const overhead = estimateOverhead(SYSTEM_PROMPT, AGENT_TOOLS.map((t) => [t.name, t.description, t.inputSchema]));
    let baseTokens = ctxState.lastContextTokens ?? overhead + estimateTokens(modelView(rows, ctxState));
    let baseIdx = rows.length;
    rows.push({ id: await persist(threadId, runId, userMsg), msg: userMsg });
    let messages = modelView(rows, ctxState);

    const changeTracker = tracker;
    const ctx: ToolContext = {
      userId,
      projectId,
      scoped: true,
      runId,
      touch: (p) => changeTracker.touch(p),
      emit,
      cache: new Map(),
    };
    // 用户自己的模型与 Key 优先，否则按策略使用服务器的（见 ai/settings.ts）
    const isAdmin = (await userStatus(userId)).isAdmin;
    const resolved = await resolveModel(userId, isAdmin, zh);
    const provider: ModelProvider = createProvider(resolved.cfg);
    usage.model_source_own = resolved.source === 'own' ? 1 : 0;
    providerForErrors = provider;
    let jsonRetries = 0;

    for (let step = 0; ; step++) {
      if (abort.signal.aborted) { status = 'stopped'; break; }
      // 上下文接近上限：清理较早的工具结果，必要时把早期对话写成摘要
      const tokens = baseTokens + estimateTokens(rows.slice(baseIdx).map((r) => r.msg));
      const managed = await manageContext({ rows, state: ctxState, tokens, provider, ratio: config.agent.compactAt, overhead, signal: abort.signal, sessionId: `texdraft-${threadId}` });
      if (managed.action !== 'none') {
        ctxState = managed.state;
        ctxStateRef.current = ctxState;
        messages = managed.messages;
        baseTokens = overhead + estimateTokens(messages);
        baseIdx = rows.length;
        await saveContextState(threadId, ctxState);
        emit({
          type: 'progress',
          text: managed.action === 'summarized'
            ? (zh ? '（对话较长，已把早期对话压缩成摘要）' : '(Long conversation: earlier messages were compacted into a summary)')
            : (zh ? '（对话较长，已清理较早的工具输出）' : '(Long conversation: older tool outputs were cleared)'),
        });
      }
      // 使用服务器 Key 时，运行途中额度用完就停下（已完成的修改保留）
      if (step > 0 && resolved.source === 'shared') {
        try {
          await checkQuota({ userId, isAdmin, zh });
        } catch (e) {
          emit({ type: 'text_delta', text: `\n\n（${(e as Error).message}）` });
          break;
        }
      }
      if (step >= config.agent.maxSteps) {
        emit({
          type: 'text_delta',
          text: zh
            ? `\n\n（已达到单次运行的步数上限 ${config.agent.maxSteps}，可以发送“继续”让我接着做。）`
            : `\n\n(Reached the step limit of ${config.agent.maxSteps} for one run. Send “continue” and I will pick up where I left off.)`,
        });
        break;
      }

      let turn;
      try {
        turn = await provider.streamTurn({
          sessionId: `texdraft-${threadId}`,
          system: SYSTEM_PROMPT,
          messages,
          tools: AGENT_TOOLS,
          signal: abort.signal,
          onEvent: (e) => {
            if (e.type === 'text') emit({ type: 'text_delta', text: e.text });
            else if (e.type === 'thinking') emit({ type: 'progress', text: e.text });
            else emit({ type: 'tool_start', id: e.id, name: e.name });
          },
        });
        jsonRetries = 0;
      } catch (err) {
        if (abort.signal.aborted || (err as Error)?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) { status = 'stopped'; break; }
        // 输出格式问题（工具参数 JSON 无法解析）：重发本轮，最多 2 次
        if (err instanceof RetryableTurnError && jsonRetries++ < 2) continue;
        throw err;
      }

      for (const [k, v] of Object.entries(turn.usage)) usage[k] = (usage[k] ?? 0) + v;
      await recordUsage(userId, resolved.source, turn.usage).catch((e) => console.error('[agent] usage', e));
      usage.last_context_tokens = turn.contextTokens;
      if (turn.contextTokens > 0) {
        baseTokens = turn.contextTokens;
        baseIdx = rows.length + 1; // 包含这一条助手消息
        ctxState = { ...ctxState, lastContextTokens: turn.contextTokens };
        ctxStateRef.current = ctxState;
      }
      const message = { content: turn.content, stop_reason: turn.stopReason };

      const assistantMsg: Msg = { role: 'assistant', content: turn.content };
      rows.push({ id: await persist(threadId, runId, assistantMsg), msg: assistantMsg });
      messages.push(assistantMsg);

      if (message.stop_reason === 'pause_turn') continue;
      if (message.stop_reason === 'refusal') {
        emit({ type: 'text_delta', text: zh ? '\n\n（模型拒绝了这个请求。）' : '\n\n(The model declined this request.)' });
        break;
      }

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) {
        if (message.stop_reason === 'max_tokens') emit({ type: 'text_delta', text: zh ? '\n\n（输出达到长度上限被截断。）' : '\n\n(The response was cut off at the length limit.)' });
        break;
      }

      // 达到 max_tokens 时工具参数可能被截断（宽松解析仍会得到“合法”的半截对象）：不执行，让模型重试
      const truncated = message.stop_reason === 'max_tokens';
      for (const tu of toolUses) emit({ type: 'tool_input', id: tu.id, name: tu.name, summary: summarizeToolInput(tu.name, tu.input) });
      const runOne = async (tu: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        let r: ToolResult;
        if (abort.signal.aborted) r = { content: [{ type: 'text', text: 'Cancelled by the user.' }], isError: true };
        else if (truncated) r = { content: [{ type: 'text', text: 'Tool input was truncated (max_tokens). Retry with a smaller edit.' }], isError: true };
        else r = await executeTool(tu.name, tu.input, ctx);
        const textOut = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        emit({ type: 'tool_end', id: tu.id, name: tu.name, ok: !r.isError, summary: textOut.slice(0, 300) });
        return { type: 'tool_result', tool_use_id: tu.id, content: toResultContent(r, provider.config.vision), ...(r.isError ? { is_error: true } : {}) };
      };
      // 连续的只读调用并行执行，写操作按顺序执行（与 Claude Code 的并发策略一致）；结果保持原顺序
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (let k = 0; k < toolUses.length; ) {
        let end = k;
        while (end < toolUses.length && isReadOnly(toolUses[end].name)) end++;
        if (end > k) {
          results.push(...(await Promise.all(toolUses.slice(k, end).map(runOne))));
          k = end;
        } else {
          results.push(await runOne(toolUses[k]));
          k++;
        }
      }
      // 所有 tool_result 放在同一条 user 消息里
      const resultMsg: Msg = { role: 'user', content: results };
      rows.push({ id: await persist(threadId, runId, resultMsg), msg: resultMsg });
      messages.push(resultMsg);
      if (abort.signal.aborted) { status = 'stopped'; break; }
    }
  } catch (err) {
    status = 'error';
    errorMessage = providerForErrors ? providerForErrors.describeError(err, zh) : err instanceof Error ? err.message : String(err);
    console.error('[agent] run failed', err);
  } finally {
    let changes: FileChangeSummary[] = [];
    let summarized = false;
    try {
      if (tracker) changes = await tracker.summarize(projectId);
      summarized = true;
    } catch (e) {
      console.error('[agent] summarize failed', e);
    }
    if (ctxStateRef.current) await saveContextState(threadId, ctxStateRef.current).catch((e) => console.error(e));
    if (runId) {
      await db
        .update(schema.agentRuns)
        .set({ status, changes, error: errorMessage ?? null, usage, finishedAt: new Date() })
        .where(eq(schema.agentRuns.id, runId))
        .catch((e) => console.error(e));
      activeRuns.delete(runId);
      if (summarized && changes.length === 0 && checkpointId) await discardCheckpoint(runId, checkpointId).catch((e) => console.error(e));
    }
    await db.update(schema.chatThreads).set({ updatedAt: new Date() }).where(eq(schema.chatThreads.id, threadId)).catch(() => {});
    busyThreads.delete(threadId);
    emit({ type: 'run_finished', runId, status, changes, error: errorMessage });
  }
}
