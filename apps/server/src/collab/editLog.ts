import { eq, lt } from 'drizzle-orm';
import type * as Y from 'yjs';
import { db, schema } from '../db/client.js';

/**
 * 编辑记录：观察每个已加载文档的 Y.Text，记下谁（或哪个服务端来源）改了多少、大致在哪几行。只记元数据，不记内容。
 *
 * Hocuspocus 的事务来源：
 *  - 浏览器：{ source: 'connection', connection }，connection.context.userId 是编辑者
 *  - 服务端（transactText → 直连）：{ source: 'local', context: { origin } }，例如 agent:<runId>、upload
 * 浏览器里的连续输入按“人 + 文件”合并：停止编辑 IDLE_MS 后或最长 WINDOW_MS 写一条；服务端修改每个事务一条。
 */

const IDLE_MS = 5_000;
const WINDOW_MS = 60_000;
const RETENTION_DAYS = 90;

interface Pending {
  projectId: string;
  fileId: string;
  userId: string | null;
  source: 'editor' | 'server';
  origin: string | null;
  insertedChars: number;
  deletedChars: number;
  insertedLines: number;
  deletedLines: number;
  fromLine: number;
  toLine: number;
  startedAt: Date;
  timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

/**
 * 浏览器报告的操作类型（CodeMirror 的 userEvent，例如 delete.line、delete.cut、undo、input.ai）。
 * 只在删除跨行时由前端上报；合并到这个人在这个文件的下一条（或正在合并的）编辑记录里，写入 origin。
 */
const hints = new Map<string, Set<string>>();
const HINT_RE = /^[a-z][a-z.\-]{0,40}$/;
export function addEditHint(fileId: string, userId: string, event: string) {
  if (!HINT_RE.test(event)) return;
  const key = `${fileId}|u:${userId}`;
  const set = hints.get(key) ?? new Set<string>();
  if (set.size < 8) set.add(event);
  hints.set(key, set);
  setTimeout(() => {
    if (hints.get(key) === set) hints.delete(key);
  }, 60_000).unref();
  const p = pending.get(key);
  if (p) p.origin = [...set].join(',');
}
const attached = new WeakSet<Y.Doc>();
const countNl = (s: string) => {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
};

function write(p: Pending) {
  clearTimeout(p.timer);
  const { timer: _t, ...row } = p;
  db.insert(schema.editLog)
    .values(row)
    .then(
      () => {},
      (err) => {
        // 文件 / 项目已删除（外键失败）时忽略
        if (!String(err).includes('foreign key')) console.error('[edit-log] write failed', err);
      },
    );
}

function flush(key: string) {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  hints.delete(key);
  write(p);
}

/** 文档卸载时把这个文件还没写入的记录全部写掉 */
export function flushFile(fileId: string) {
  for (const [key, p] of pending) if (p.fileId === fileId) flush(key);
}

type Origin = { source?: string; connection?: { context?: { userId?: string } }; context?: { origin?: string } } | null | undefined;

/** 给刚加载的文档挂上观察者（每个 Y.Doc 只挂一次） */
export function attachEditLog(fileId: string, document: Y.Doc, ytext: Y.Text) {
  if (attached.has(document)) return;
  attached.add(document);
  let projectId: string | null = null;
  const ready = db
    .select({ projectId: schema.files.projectId })
    .from(schema.files)
    .where(eq(schema.files.id, fileId))
    .limit(1)
    .then((r) => (projectId = r[0]?.projectId ?? null))
    .catch(() => null);

  // 上一版文本：删除的内容在远端更新里拿不到（已被 GC），用它计算删除了几行
  let prev = ytext.toString();
  ytext.observe((event, tr) => {
    const origin = tr.origin as Origin;
    const fromBrowser = origin?.source === 'connection';
    const userId = fromBrowser ? origin?.connection?.context?.userId ?? null : null;
    const serverOrigin = fromBrowser ? null : origin?.context?.origin ?? (origin?.source ? String(origin.source) : 'unknown');

    // 统计本次修改：插入 / 删除的字符与换行数，以及修改后文档中涉及的行号范围
    let pos = 0;
    let oldPos = 0;
    let first = -1;
    let last = -1;
    let insertedChars = 0;
    let deletedChars = 0;
    let insertedLines = 0;
    let deletedLines = 0;
    for (const op of event.changes.delta) {
      if (op.retain) {
        pos += op.retain;
        oldPos += op.retain;
      } else if (op.insert !== undefined) {
        const s = typeof op.insert === 'string' ? op.insert : '';
        if (first < 0) first = pos;
        insertedChars += s.length;
        insertedLines += countNl(s);
        pos += s.length;
        last = pos;
      } else if (op.delete) {
        if (first < 0) first = pos;
        deletedChars += op.delete;
        deletedLines += countNl(prev.slice(oldPos, oldPos + op.delete));
        oldPos += op.delete;
        last = Math.max(last, pos);
      }
    }
    const text = ytext.toString();
    prev = text;
    if (first < 0) return;
    const lineAt = (i: number) => countNl(text.slice(0, Math.min(i, text.length))) + 1;
    const fromLine = lineAt(first);
    const toLine = lineAt(last);

    const record = () => {
      if (!projectId) return;
      const actor = fromBrowser ? `u:${userId ?? '?'}` : `s:${serverOrigin}`;
      const key = `${fileId}|${actor}`;
      let p = pending.get(key);
      if (p && Date.now() - p.startedAt.getTime() > WINDOW_MS) {
        flush(key);
        p = undefined;
      }
      if (!p) {
        p = {
          projectId, fileId, userId, source: fromBrowser ? 'editor' : 'server', origin: serverOrigin,
          insertedChars: 0, deletedChars: 0, insertedLines: 0, deletedLines: 0, fromLine, toLine, startedAt: new Date(),
        };
        pending.set(key, p);
      }
      if (fromBrowser) {
        const h = hints.get(key);
        if (h?.size) p.origin = [...h].join(',');
      }
      p.insertedChars += insertedChars;
      p.deletedChars += deletedChars;
      p.insertedLines += insertedLines;
      p.deletedLines += deletedLines;
      p.fromLine = Math.min(p.fromLine, fromLine);
      p.toLine = Math.max(p.toLine, toLine);
      clearTimeout(p.timer);
      // 服务端写入是一次性的操作：马上写；浏览器输入等停顿后合并写
      if (!fromBrowser) flush(key);
      else p.timer = setTimeout(() => flush(key), IDLE_MS);
    };
    if (projectId) record();
    else void ready.then(record);
  });
}

/** 定期清理过期记录 */
const prune = () =>
  db
    .delete(schema.editLog)
    .where(lt(schema.editLog.createdAt, new Date(Date.now() - RETENTION_DAYS * 86_400_000)))
    .then(() => {}, (err) => console.error('[edit-log] prune failed', err));
setInterval(prune, 6 * 3_600_000).unref();
setTimeout(prune, 60_000).unref();

/** 进程退出前把还没写入的合并记录写掉 */
export function flushAllEditLogs() {
  for (const key of [...pending.keys()]) flush(key);
}
