import type { ChatItem, FileChangeSummary, ThreadSummary } from '@texdraft/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { notFound } from '../lib/http.js';
import { CONTEXT_PREFIX } from './prompt.js';
import { summarizeToolInput } from '../tools/registry.js';

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

export async function listThreads(projectId: string, userId: string): Promise<ThreadSummary[]> {
  const rows = await db
    .select()
    .from(schema.chatThreads)
    .where(and(eq(schema.chatThreads.projectId, projectId), eq(schema.chatThreads.userId, userId)))
    .orderBy(desc(schema.chatThreads.updatedAt))
    .limit(50);
  return rows.map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt.toISOString(), backend: t.backend as ThreadSummary['backend'] }));
}

/** 把原始 Messages API 记录转换成界面展示单元 */
export async function threadItems(projectId: string, userId: string, threadId: string): Promise<ChatItem[]> {
  const [t] = await db
    .select()
    .from(schema.chatThreads)
    .where(and(eq(schema.chatThreads.id, threadId), eq(schema.chatThreads.projectId, projectId), eq(schema.chatThreads.userId, userId)));
  if (!t) throw notFound('Thread not found');

  const msgs = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.threadId, threadId))
    .orderBy(asc(schema.chatMessages.id));
  const runs = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.threadId, threadId));
  const runById = new Map(runs.map((r) => [r.id, r]));

  const items: ChatItem[] = [];
  const toolItems = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();
  const flushRun = (runId: string | null) => {
    const r = runId ? runById.get(runId) : undefined;
    if (r && r.status !== 'running') {
      items.push({
        kind: 'run_summary',
        runId: r.id,
        status: r.status,
        changes: r.changes as FileChangeSummary[],
        reverted: !!r.reverted,
      });
      if (r.error) items.push({ kind: 'assistant', text: `⚠️ ${r.error}` });
    }
  };

  let currentRun: string | null = null;
  for (const m of msgs) {
    if (m.runId !== currentRun) {
      flushRun(currentRun);
      currentRun = m.runId;
    }
    const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as Block[]);
    for (const b of blocks) {
      if (m.role === 'user') {
        if (b.type === 'text' && b.text && !b.text.startsWith(CONTEXT_PREFIX)) items.push({ kind: 'user', text: b.text });
        if (b.type === 'tool_result' && b.tool_use_id) {
          const ti = toolItems.get(b.tool_use_id);
          if (ti) {
            ti.ok = !b.is_error;
            const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            ti.result = text.length > 1500 ? text.slice(0, 1500) + '…' : text;
          }
        }
      } else {
        if (b.type === 'text' && b.text) {
          const last = items[items.length - 1];
          if (last?.kind === 'assistant') last.text += b.text;
          else items.push({ kind: 'assistant', text: b.text });
        } else if (b.type === 'thinking' && b.thinking?.trim()) {
          items.push({ kind: 'progress', text: b.thinking });
        } else if (b.type === 'tool_use' && b.id && b.name) {
          const ti: Extract<ChatItem, { kind: 'tool' }> = {
            kind: 'tool',
            id: b.id,
            name: b.name,
            summary: summarizeToolInput(b.name, b.input),
          };
          toolItems.set(b.id, ti);
          items.push(ti);
        }
      }
    }
  }
  flushRun(currentRun);
  return items;
}
