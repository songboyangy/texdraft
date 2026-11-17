import type { ThreadContextState } from '../db/schema.js';
import type { ContentBlock, ModelProvider, Msg } from './providers/index.js';

/**
 * 上下文管理（参考 Claude Code 的自动压缩与 Anthropic 的 context editing）：
 * chat_messages 保存完整、只追加的记录；发给模型的是一个“视图”。上下文接近窗口上限时分两级处理：
 *  1. 清理较早的工具结果（文件内容、PDF 页面等占大头），只保留最近几次；一旦清理就一直保持，
 *     这样前缀缓存只在每次清理时失效一次
 *  2. 仍然过长时，把当前这一轮之前的对话交给模型写成结构化摘要，之后只发送摘要 + 最近的对话
 * 切分点只放在“用户发起新一轮”的边界上，保证 tool_use 与 tool_result 始终成对出现。
 */

export interface StoredMsg {
  id: number;
  msg: Msg;
}

export const CLEARED_RESULT = '[Older tool result cleared to keep the conversation within the context window. Run the tool again if you still need it.]';
const KEEP_RECENT_RESULTS = 6;
/** 小结果不值得清理（清理会让缓存失效） */
const MIN_CLEAR_CHARS = 400;
/** 压缩后的目标占用（相对窗口） */
const TARGET_RATIO = 0.5;
const IMAGE_TOKENS = 1600;

const SUMMARY_SYSTEM = `You compress the history of a working session between a user and an AI assistant that edits a LaTeX project through tools.
Write a summary that lets the assistant continue seamlessly without the earlier messages. Use these sections:
1. User goals and preferences (style, language, conventions they asked for)
2. Work done so far: which files were created / changed / deleted and why (exact paths, labels, citation keys, macro names)
3. Current state: compile status, open errors or warnings, anything left half-done
4. Open questions and next steps
Be concise but keep every concrete identifier exact. Do not invent anything. Write in the language the user writes in.`;

const blocksOf = (m: Msg): ContentBlock[] => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content as string }]);

/** 用户发起新一轮的消息（含文本，而不只是工具结果） */
const isTurnStart = (m: Msg) => m.role === 'user' && blocksOf(m).some((b) => b.type === 'text');

/** 系统提示 + 工具定义的固定开销 */
export function estimateOverhead(system: string, tools: unknown): number {
  return Math.ceil((system.length + JSON.stringify(tools).length) / 3.5);
}

/** 粗略估算 token：字符数 / 3.5，图片按固定值 */
export function estimateTokens(msgs: Msg[]): number {
  let chars = 0;
  let images = 0;
  const walk = (v: unknown) => {
    if (typeof v === 'string') chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'image') images++;
      else for (const [k, x] of Object.entries(o)) if (k !== 'signature') walk(x);
    }
  };
  msgs.forEach((m) => walk(m.content));
  return Math.ceil(chars / 3.5) + images * IMAGE_TOKENS;
}

/** 由完整记录 + 状态构造发给模型的消息 */
export function modelView(rows: StoredMsg[], state: ThreadContextState): Msg[] {
  const cleared = new Set(state.clearedToolUseIds ?? []);
  const start = state.summary && state.summaryUpto ? rows.findIndex((r) => r.id > state.summaryUpto!) : 0;
  const kept = start < 0 ? [] : rows.slice(start);
  const out = kept.map(({ msg }) => {
    if (msg.role !== 'user' || !cleared.size || !Array.isArray(msg.content)) return msg;
    if (!msg.content.some((b) => b.type === 'tool_result' && cleared.has((b as { tool_use_id: string }).tool_use_id))) return msg;
    return {
      ...msg,
      content: msg.content.map((b) =>
        b.type === 'tool_result' && cleared.has((b as { tool_use_id: string }).tool_use_id)
          ? { ...(b as object), content: CLEARED_RESULT } as ContentBlock
          : b,
      ),
    };
  });
  if (state.summary && out.length) {
    const first = out[0];
    out[0] = {
      role: first.role,
      content: [
        {
          type: 'text',
          text: `<conversation_summary>\n${state.summary}\n</conversation_summary>\nThe earlier part of this conversation was compacted into the summary above. Continue from it; re-read files if you need their current content.`,
        },
        ...blocksOf(first),
      ],
    } as Msg;
  }
  return out;
}

/** 选出可以清理的工具结果：除最近 KEEP_RECENT_RESULTS 个之外、内容较大的 */
function clearCandidates(rows: StoredMsg[], state: ThreadContextState, keep: number) {
  const cleared = new Set(state.clearedToolUseIds ?? []);
  const results: { id: string; size: number; hasImage: boolean }[] = [];
  for (const { msg } of rows) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type !== 'tool_result') continue;
      const tr = b as { tool_use_id: string; content?: unknown };
      if (cleared.has(tr.tool_use_id)) continue;
      const content = tr.content;
      const hasImage = Array.isArray(content) && content.some((c) => (c as { type?: string }).type === 'image');
      results.push({ id: tr.tool_use_id, size: JSON.stringify(content ?? '').length, hasImage });
    }
  }
  return results.slice(0, Math.max(0, results.length - keep)).filter((r) => r.hasImage || r.size >= MIN_CLEAR_CHARS);
}

export interface ManageResult {
  state: ThreadContextState;
  messages: Msg[];
  action: 'none' | 'cleared' | 'summarized';
}

/**
 * 需要时压缩上下文。tokens 为当前视图的上下文占用（最近一次请求的实际值 + 之后新增内容的估算）。
 */
export async function manageContext(opts: {
  rows: StoredMsg[];
  state: ThreadContextState;
  tokens: number;
  provider: ModelProvider;
  ratio: number;
  /** 系统提示与工具定义的固定开销（token 估算） */
  overhead: number;
  signal?: AbortSignal;
  sessionId?: string;
}): Promise<ManageResult> {
  const window = opts.provider.config.contextWindow;
  let state = opts.state;
  let messages = modelView(opts.rows, state);
  if (opts.tokens <= window * opts.ratio) return { state, messages, action: 'none' };
  const target = window * TARGET_RATIO - opts.overhead;

  // 1. 清理较早的工具结果
  let action: ManageResult['action'] = 'none';
  for (const keep of [KEEP_RECENT_RESULTS, 2]) {
    const cands = clearCandidates(opts.rows, state, keep);
    if (!cands.length) continue;
    state = { ...state, clearedToolUseIds: [...(state.clearedToolUseIds ?? []), ...cands.map((c) => c.id)] };
    messages = modelView(opts.rows, state);
    action = 'cleared';
    if (estimateTokens(messages) <= target) return { state, messages, action };
  }

  // 2. 把当前这一轮之前的对话写成摘要
  let lastTurn = -1;
  for (let i = opts.rows.length - 1; i >= 0; i--) if (isTurnStart(opts.rows[i].msg)) { lastTurn = i; break; }
  const firstViewIdx = state.summary && state.summaryUpto ? opts.rows.findIndex((r) => r.id > state.summaryUpto!) : 0;
  if (lastTurn <= firstViewIdx) return { state, messages, action }; // 只有当前这一轮：只能靠清理
  const before = modelView(opts.rows.slice(0, lastTurn), state);
  const instruction = 'Summarize the conversation so far according to the instructions. Output only the summary.';
  const last = before.at(-1);
  const request: Msg[] =
    last?.role === 'user'
      ? [...before.slice(0, -1), { ...last, content: [...blocksOf(last), { type: 'text', text: instruction }] }]
      : [...before, { role: 'user', content: instruction }];
  const turn = await opts.provider.streamTurn({ sessionId: opts.sessionId, system: SUMMARY_SYSTEM, messages: request, tools: [], maxTokens: 4000, effort: 'low', signal: opts.signal });
  const summary = turn.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')
    .trim();
  if (!summary) return { state, messages, action };
  const keptToolIds = new Set(
    opts.rows
      .slice(lastTurn)
      .flatMap(({ msg }) => (Array.isArray(msg.content) ? msg.content : []))
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b as { tool_use_id: string }).tool_use_id),
  );
  state = {
    ...state,
    summary,
    summaryUpto: opts.rows[lastTurn - 1].id,
    // 只保留仍在视图里的已清理结果（摘要之前的已不再发送）
    clearedToolUseIds: (state.clearedToolUseIds ?? []).filter((id) => keptToolIds.has(id)),
    compactions: (state.compactions ?? 0) + 1,
  };
  return { state, messages: modelView(opts.rows, state), action: 'summarized' };
}
