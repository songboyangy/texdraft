import type { FileChangeSummary } from '@texdraft/shared';
import { createTwoFilesPatch } from 'diff';
import { and, eq, sql } from 'drizzle-orm';
import { readText } from '../collab/hocuspocus.js';
import { db, schema } from '../db/client.js';
import type { SnapshotFile } from '../db/schema.js';
import { conflict, notFound } from '../lib/http.js';
import { findFile } from '../projects/service.js';
import { createVersion, restoreFiles } from '../projects/versions.js';

/** Agent 运行前给整个项目打检查点 */
export function createCheckpoint(projectId: string, userId: string, label: string) {
  return createVersion(projectId, userId, 'checkpoint', label);
}

/**
 * 运行结束后没有改动任何文件（例如只是聊天），检查点就没有意义：解除关联并删除，
 * 避免历史版本里堆满与当前内容完全相同的快照。
 */
export async function discardCheckpoint(runId: string, checkpointId: string) {
  await db.update(schema.agentRuns).set({ checkpointId: null }).where(eq(schema.agentRuns.id, runId));
  await db.execute(sql`
    DELETE FROM versions v WHERE v.id = ${checkpointId} AND v.kind = 'checkpoint'
      AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.checkpoint_id = v.id)`);
}

/** 服务重启时被中断的运行：没来得及汇总改动（changes 为空但可能改过文件），其检查点必须保留 */
export const INTERRUPTED_RUN_ERROR = '服务重启，运行被中断';

/** 启动时清理：已结束且没有改动文件的运行所留下的检查点（MCP 检查点不关联运行，不受影响） */
export async function pruneEmptyCheckpoints() {
  // 分两条语句：同一语句里的数据修改型 CTE 看不到自己的 UPDATE，NOT EXISTS 会误判仍被引用
  return db.transaction(async (tx) => {
    const unlinked = await tx.execute<{ checkpoint_id: string }>(sql`
      UPDATE agent_runs r SET checkpoint_id = NULL
      FROM (SELECT id, checkpoint_id FROM agent_runs
            WHERE checkpoint_id IS NOT NULL AND status <> 'running' AND changes = '[]'::jsonb
              AND error IS DISTINCT FROM ${INTERRUPTED_RUN_ERROR}
            FOR UPDATE) old
      WHERE r.id = old.id
      RETURNING old.checkpoint_id`);
    const ids = unlinked.map((r) => r.checkpoint_id);
    if (!ids.length) return 0;
    const deleted = await tx.execute(sql`
      DELETE FROM versions v
      WHERE v.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) AND v.kind = 'checkpoint'
        AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.checkpoint_id = v.id)
      RETURNING v.id`);
    return deleted.length;
  });
}

/**
 * 跟踪本次运行改动过的文件；结束时与检查点对比生成 diff 摘要。
 */
export class ChangeTracker {
  private baseline: Map<string, SnapshotFile>;
  private touched = new Set<string>();

  constructor(files: SnapshotFile[]) {
    this.baseline = new Map(files.map((f) => [f.path, f]));
  }

  touch(path: string) {
    this.touched.add(path);
  }

  async summarize(projectId: string): Promise<FileChangeSummary[]> {
    const out: FileChangeSummary[] = [];
    for (const path of [...this.touched].sort()) {
      const base = this.baseline.get(path);
      const cur = await findFile(projectId, path);
      if (!base && !cur) continue;
      const baseText = base?.kind === 'text' ? base.content ?? '' : base ? '[binary]' : '';
      const curText = cur ? (cur.kind === 'text' ? await readText(cur.id) : '[binary]') : '';
      if (base && cur && baseText === curText) continue;
      const action: FileChangeSummary['action'] = !base ? 'created' : !cur ? 'deleted' : 'modified';
      const patch = createTwoFilesPatch(path, path, baseText, curText, '', '', { context: 3 });
      let additions = 0;
      let deletions = 0;
      for (const l of patch.split('\n').slice(2)) {
        if (l.startsWith('+') && !l.startsWith('+++')) additions++;
        else if (l.startsWith('-') && !l.startsWith('---')) deletions++;
      }
      out.push({ path, action, additions, deletions, patch: patch.length > 60_000 ? patch.slice(0, 60_000) + '\n…' : patch });
    }
    return out;
  }
}

/**
 * 撤销一次 Agent 运行：把它改动过的文件恢复到检查点状态。
 * 注意：会同时覆盖运行结束后其他人对这些文件的修改（界面上会提示）。
 */
export async function revertRun(projectId: string, runId: string) {
  const [run] = await db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.projectId, projectId)));
  if (!run) throw notFound('Run not found');
  if (run.status === 'running') throw conflict('Run is still in progress');
  if (run.reverted) return;
  if (!run.checkpointId) throw conflict('Run has no checkpoint');
  const [cp] = await db.select().from(schema.versions).where(eq(schema.versions.id, run.checkpointId));
  if (!cp) throw notFound('Checkpoint not found');
  const baseline = new Map(cp.snapshot.files.map((f) => [f.path, f]));
  await restoreFiles(projectId, baseline, run.changes.map((c) => c.path), `revert:${runId}`);
  await db.update(schema.agentRuns).set({ reverted: 1 }).where(eq(schema.agentRuns.id, runId));
}
