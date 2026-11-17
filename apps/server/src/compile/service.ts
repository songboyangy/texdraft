import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CompileDiagnostic, CompileResult, Engine } from '@texdraft/shared';
import { and, desc, eq, lt } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import type { SnapshotFile } from '../db/schema.js';
import { blobStore } from '../lib/blobStore.js';
import { consume } from '../lib/rateLimit.js';
import { Semaphore } from '../lib/semaphore.js';
import { userStatus } from '../lib/userStatus.js';
import { publishProjectEvent } from '../lib/events.js';
import { snapshotProject } from '../projects/service.js';
import { maybeAutoSnapshot } from '../projects/versions.js';
import { explainSilentFailure, parseTectonicStdout, parseTexLog } from './logParser.js';
import { runLatex } from './runner.js';

const KEEP_JOBS = 5;

/** 全局编译并发上限（COMPILE_CONCURRENCY，默认 CPU 核数）：LaTeX 单线程，超过核数只会让所有人一起变慢 */
const compileSlots = new Semaphore(config.quota.compileConcurrency);
export const compileQueueStats = () => ({ running: compileSlots.running, queued: compileSlots.queued });

/**
 * 每人每分钟的编译次数限制（COMPILES_PER_MINUTE；管理员不限）。网页、内置 Agent、MCP 的编译都计入。
 */
export async function checkCompileRate(userId: string, zh = true) {
  const max = config.quota.compilesPerMinute;
  if (max <= 0 || (await userStatus(userId)).isAdmin) return;
  consume(`compile:${userId}`, max, 60_000, () =>
    zh ? `编译太频繁了（每分钟最多 ${max} 次），请稍后再试` : `Too many compiles (at most ${max} per minute). Please wait a moment.`,
  );
}

/**
 * 每个项目同一时间只跑一个编译；编译进行中再来的请求合并为“下一次”编译，
 * 所有等待者拿到同一个结果（避免连续保存触发一串编译）。
 */
const scheduler = new Map<string, { running?: Promise<CompileResult>; next?: Promise<CompileResult> }>();

export function compileProject(projectId: string, triggeredBy: string): Promise<CompileResult> {
  let s = scheduler.get(projectId);
  if (!s) scheduler.set(projectId, (s = {}));
  const state = s;
  const start = (): Promise<CompileResult> => {
    publishProjectEvent(projectId, { type: 'compile_started', by: triggeredBy });
    const p = doCompile(projectId).finally(() => {
      if (state.running === p) state.running = undefined;
      if (!state.running && !state.next) scheduler.delete(projectId);
    });
    state.running = p;
    return p;
  };
  if (!state.running) return start();
  if (!state.next) {
    state.next = state.running.catch(() => undefined).then(() => {
      state.next = undefined;
      return start();
    });
  }
  return state.next;
}

function workDirs(projectId: string) {
  const root = path.join(config.dataDir, 'compile', projectId);
  return { root, src: path.join(root, 'src'), out: path.join(root, 'out'), manifest: path.join(root, 'manifest.json') };
}

/** 把项目快照增量同步到工作目录（按内容哈希） */
async function materialize(projectId: string, files: SnapshotFile[]) {
  const dirs = workDirs(projectId);
  await fs.mkdir(dirs.src, { recursive: true });
  let old: Record<string, string> = {};
  try {
    old = JSON.parse(await fs.readFile(dirs.manifest, 'utf8'));
  } catch {
    /* first run */
  }
  const next: Record<string, string> = {};
  for (const f of files) {
    const target = path.join(dirs.src, f.path);
    const tag = f.kind === 'text'
      ? 'sha1:' + crypto.createHash('sha1').update(f.content ?? '').digest('hex')
      : 'blob:' + f.blobKey;
    next[f.path] = tag;
    if (old[f.path] === tag) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (f.kind === 'text') await fs.writeFile(target, f.content ?? '');
    else if (f.blobKey) await fs.copyFile(await blobStore.localPath(f.blobKey), target);
  }
  for (const p of Object.keys(old)) {
    if (!(p in next)) await fs.unlink(path.join(dirs.src, p)).catch(() => {});
  }
  await fs.writeFile(dirs.manifest, JSON.stringify(next));
  return dirs;
}

async function doCompile(projectId: string): Promise<CompileResult> {
  const started = Date.now();
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!project) throw new Error('project not found');
  const engine = project.engine as Engine;
  const [job] = await db
    .insert(schema.compileJobs)
    .values({ projectId, status: 'running', engine: config.compile.runner === 'local-tectonic' ? 'xelatex(tectonic)' : engine })
    .returning();

  let status: CompileResult['status'] = 'error';
  let diagnostics: CompileDiagnostic[] = [];
  let pdfKey: string | null = null;
  let synctexKey: string | null = null;
  let logText = '';
  let output = '';

  try {
    const files = await snapshotProject(projectId);
    const paths = files.map((f) => f.path);
    if (!paths.includes(project.mainFile)) {
      diagnostics = [{ level: 'error', message: `Main file "${project.mainFile}" does not exist` }];
    } else {
      const dirs = await materialize(projectId, files);
      const base = project.mainFile.replace(/\.[^./]+$/, '');
      const pdfPath = path.join(dirs.out, `${base}.pdf`);
      const logPath = path.join(dirs.out, `${base}.log`);
      await fs.unlink(pdfPath).catch(() => {});
      await fs.unlink(logPath).catch(() => {});
      const synctexPath = path.join(dirs.out, `${base}.synctex.gz`);
      await fs.unlink(synctexPath).catch(() => {});

      let queued = false;
      const run = await compileSlots.run(
        () => {
          // 排过队的：告诉前端已经开始编译（position 0）
          if (queued) publishProjectEvent(projectId, { type: 'compile_queued', position: 0 });
          return runLatex({
            srcDir: dirs.src,
            outDir: dirs.out,
            mainFile: project.mainFile,
            engine,
            timeoutMs: config.compile.timeoutMs,
          });
        },
        (position) => {
          queued = true;
          publishProjectEvent(projectId, { type: 'compile_queued', position });
        },
      );
      output = run.output;
      logText = await fs.readFile(logPath, 'utf8').catch(() => '');
      diagnostics = logText ? parseTexLog(logText, paths) : [];
      if (config.compile.runner === 'local-tectonic') {
        // tectonic 的 stdout 里有已解析好的 file:line，合并进来（按 message 去重）
        const extra = parseTectonicStdout(output, paths).filter(
          (d) => !diagnostics.some((x) => x.level === d.level && x.message.includes(d.message.replace(/\.$/, ''))),
        );
        diagnostics = [...diagnostics, ...extra];
      }
      if (run.spawnError) diagnostics.unshift({ level: 'error', message: `Compiler not available: ${run.spawnError}` });

      const pdf = await fs.readFile(pdfPath).catch(() => null);
      if (pdf) pdfKey = await blobStore.put(pdf, `compile/${projectId}`);
      const synctex = pdf ? await fs.readFile(synctexPath).catch(() => null) : null;
      if (synctex) synctexKey = await blobStore.put(synctex, `compile/${projectId}`);
      // 没出 PDF、日志里也没有可解析的错误：取日志末尾的说明（如模板要求 pdfTeX）
      if (!pdf && !run.timedOut && !diagnostics.some((d) => d.level === 'error')) {
        const why = explainSilentFailure(logText || output, { tectonicOnly: config.compile.runner === 'local-tectonic' });
        if (why) diagnostics.unshift(why);
      }
      const hasErrors = diagnostics.some((d) => d.level === 'error');
      status = run.timedOut ? 'timeout' : pdf && !hasErrors ? 'success' : 'failure';
      if (run.timedOut) diagnostics.unshift({ level: 'error', message: `Compile timed out after ${config.compile.timeoutMs / 1000}s` });
    }
  } catch (err) {
    status = 'error';
    diagnostics.unshift({ level: 'error', message: `Internal compile error: ${(err as Error).message}` });
  }

  const fullLog = logText || output;
  const logKey = fullLog ? await blobStore.put(Buffer.from(fullLog), `compile/${projectId}`) : null;
  const durationMs = Date.now() - started;
  await db
    .update(schema.compileJobs)
    .set({ status, durationMs, pdfKey, logKey, synctexKey, diagnostics })
    .where(eq(schema.compileJobs.id, job.id));
  void pruneOldJobs(projectId);
  void maybeAutoSnapshot(projectId, null).catch((e) => console.error('[versions] auto snapshot failed', e));

  const result: CompileResult = {
    jobId: job.id,
    ok: !!pdfKey,
    status,
    durationMs,
    pdfUrl: pdfKey ? `/api/projects/${projectId}/compile/${job.id}/pdf` : undefined,
    diagnostics,
    logTail: fullLog.slice(-4000),
  };
  publishProjectEvent(projectId, { type: 'compile_finished', result });
  return result;
}

async function pruneOldJobs(projectId: string) {
  const recent = await db
    .select({ id: schema.compileJobs.id, createdAt: schema.compileJobs.createdAt })
    .from(schema.compileJobs)
    .where(eq(schema.compileJobs.projectId, projectId))
    .orderBy(desc(schema.compileJobs.createdAt))
    .limit(KEEP_JOBS);
  if (recent.length < KEEP_JOBS) return;
  const cutoff = recent[recent.length - 1].createdAt;
  const old = await db
    .select()
    .from(schema.compileJobs)
    .where(and(eq(schema.compileJobs.projectId, projectId), lt(schema.compileJobs.createdAt, cutoff)));
  for (const j of old) {
    if (j.pdfKey) await blobStore.remove(j.pdfKey);
    if (j.logKey) await blobStore.remove(j.logKey);
    if (j.synctexKey) await blobStore.remove(j.synctexKey);
  }
  await db.delete(schema.compileJobs).where(and(eq(schema.compileJobs.projectId, projectId), lt(schema.compileJobs.createdAt, cutoff)));
}

export async function getCompileJob(projectId: string, jobId: string) {
  const [j] = await db
    .select()
    .from(schema.compileJobs)
    .where(and(eq(schema.compileJobs.projectId, projectId), eq(schema.compileJobs.id, jobId)));
  return j ?? null;
}

export async function latestCompile(projectId: string): Promise<CompileResult | null> {
  const [j] = await db
    .select()
    .from(schema.compileJobs)
    .where(eq(schema.compileJobs.projectId, projectId))
    .orderBy(desc(schema.compileJobs.createdAt))
    .limit(1);
  if (!j || j.status === 'running') return null;
  return {
    jobId: j.id,
    ok: !!j.pdfKey,
    status: j.status as CompileResult['status'],
    durationMs: j.durationMs ?? 0,
    pdfUrl: j.pdfKey ? `/api/projects/${projectId}/compile/${j.id}/pdf` : undefined,
    diagnostics: j.diagnostics ?? [],
    logTail: '',
  };
}
