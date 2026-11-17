import { Database } from '@hocuspocus/extension-database';
import { Hocuspocus } from '@hocuspocus/server';
import { eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { db, schema } from '../db/client.js';
import { userIdFromCookieHeader } from '../lib/auth.js';
import { attachEditLog, flushFile } from './editLog.js';

/** 每个文本文件对应一个 Y.Doc，文档名 = files.id，正文存放在名为 content 的 Y.Text 中 */
export const TEXT_FIELD = 'content';

export interface CollabContext {
  userId?: string;
  /** 服务端直连（Agent / API 写入）时的来源标记 */
  origin?: string;
}

async function fileAccess(fileId: string, userId: string) {
  const rows = await db
    .select({ projectId: schema.files.projectId, kind: schema.files.kind, role: schema.projectMembers.role })
    .from(schema.files)
    .innerJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.files.projectId))
    .where(sql`${schema.files.id} = ${fileId} and ${schema.projectMembers.userId} = ${userId}`)
    .limit(1);
  return rows[0] ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const hocuspocus = new Hocuspocus<CollabContext>({
  name: 'texdraft-collab',
  quiet: true,
  debounce: 1000,
  maxDebounce: 5000,

  // 每个连接都会触发：用会话 Cookie 鉴权，viewer 只读
  async onConnect({ documentName, requestHeaders, connectionConfig, context }) {
    const userId = await userIdFromCookieHeader(requestHeaders.get('cookie'));
    if (!userId) throw new Error('unauthenticated');
    if (!UUID_RE.test(documentName)) throw new Error('bad document');
    const access = await fileAccess(documentName, userId);
    if (!access || access.kind !== 'text') throw new Error('forbidden');
    connectionConfig.readOnly = access.role === 'viewer';
    context.userId = userId;
  },

  // 编辑记录：文档加载后观察它的修改（只记元数据），卸载时写掉尚未合并完的记录
  async afterLoadDocument({ documentName, document }) {
    if (UUID_RE.test(documentName)) attachEditLog(documentName, document, document.getText(TEXT_FIELD));
  },
  async afterUnloadDocument({ documentName }) {
    flushFile(documentName);
  },

  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const rows = await db
          .select({ state: schema.docStates.state })
          .from(schema.docStates)
          .where(eq(schema.docStates.fileId, documentName))
          .limit(1);
        return rows[0]?.state ?? null;
      },
      store: async ({ documentName, state, document }) => {
        const size = Buffer.byteLength(document.getText(TEXT_FIELD).toString());
        try {
          await db.transaction(async (tx) => {
            await tx
              .insert(schema.docStates)
              .values({ fileId: documentName, state })
              .onConflictDoUpdate({ target: schema.docStates.fileId, set: { state, updatedAt: new Date() } });
            const [f] = await tx
              .update(schema.files)
              .set({ size, updatedAt: new Date() })
              .where(eq(schema.files.id, documentName))
              .returning({ projectId: schema.files.projectId });
            if (f) await tx.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, f.projectId));
          });
        } catch (err) {
          // 文件已被删除（外键失败）时忽略
          if (!String(err).includes('foreign key')) console.error('[collab] store failed', documentName, err);
        }
      },
    }),
  ],
});

// ---------------------------------------------------------------------------
// 服务端读写文本：优先使用内存中的活动文档，保证与在线编辑者一致
// ---------------------------------------------------------------------------

export async function readText(fileId: string): Promise<string> {
  const live = hocuspocus.documents.get(fileId);
  if (live) return live.getText(TEXT_FIELD).toString();
  const rows = await db
    .select({ state: schema.docStates.state })
    .from(schema.docStates)
    .where(eq(schema.docStates.fileId, fileId))
    .limit(1);
  if (!rows[0]) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, rows[0].state);
  return doc.getText(TEXT_FIELD).toString();
}

/** 新建文件时直接写入初始状态（此时不可能有在线连接） */
export function encodeInitialState(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText(TEXT_FIELD).insert(0, content);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * 在文档上执行一次事务。修改通过 Hocuspocus 广播给所有在线编辑者，并走正常的持久化流程。
 * fn 拿到的是“此刻最新”的文本，所以定位不依赖调用方之前读到的旧内容/行号。
 */
export async function transactText<T>(fileId: string, origin: string, fn: (ytext: Y.Text) => T): Promise<T> {
  const conn = await hocuspocus.openDirectConnection(fileId, { origin });
  let result!: T;
  let error: unknown;
  try {
    await conn.transact((doc) => {
      try {
        result = fn(doc.getText(TEXT_FIELD));
      } catch (e) {
        error = e;
      }
    });
  } finally {
    await conn.disconnect();
  }
  if (error) throw error;
  return result;
}

/**
 * 把 ytext 中 [start, start+oldStr.length) 替换为 newStr，只对真正变化的部分做 delete/insert，
 * 这样其他人的光标、以及落在未变化区域的并发编辑都不受影响。
 */
export function applyMinimalReplace(ytext: Y.Text, start: number, oldStr: string, newStr: string) {
  let prefix = 0;
  const maxPrefix = Math.min(oldStr.length, newStr.length);
  while (prefix < maxPrefix && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(oldStr.length, newStr.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldStr.charCodeAt(oldStr.length - 1 - suffix) === newStr.charCodeAt(newStr.length - 1 - suffix)
  ) suffix++;
  const delLen = oldStr.length - prefix - suffix;
  const ins = newStr.slice(prefix, newStr.length - suffix);
  const at = start + prefix;
  if (delLen > 0) ytext.delete(at, delLen);
  if (ins) ytext.insert(at, ins);
}

export function setWholeText(ytext: Y.Text, next: string) {
  applyMinimalReplace(ytext, 0, ytext.toString(), next);
}

/** 文件删除后断开在线编辑者并卸载内存文档 */
export async function evictDocument(fileId: string) {
  hocuspocus.closeConnections(fileId);
  const doc = hocuspocus.documents.get(fileId);
  if (doc) await hocuspocus.unloadDocument(doc).catch(() => {});
}
