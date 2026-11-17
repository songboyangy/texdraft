import { strFromU8, unzipSync, zipSync } from 'fflate';
import { eq } from 'drizzle-orm';
import { encodeInitialState } from '../collab/hocuspocus.js';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { blobStore } from '../lib/blobStore.js';
import { HttpError, badRequest } from '../lib/http.js';
import { PathError, isTextPath, normalizeProjectPath } from '../lib/paths.js';
import { assertCanCreateProject, listFolders, snapshotProject } from './service.js';

const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 3000;
/** 导入时跳过的编译产物与系统文件 */
const SKIP = /(^|\/)(__MACOSX|\.git|\.DS_Store|Thumbs\.db)(\/|$)|\.(aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex\.gz|synctex|bbl|blg|bcf|run\.xml|xdv|nav|snm|vrb)$/i;

/** 把整个项目打包成 zip */
export async function exportProjectZip(projectId: string): Promise<Uint8Array> {
  const files = await snapshotProject(projectId);
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    if (f.kind === 'text') entries[f.path] = new TextEncoder().encode(f.content ?? '');
    else if (f.blobKey) entries[f.path] = new Uint8Array(await blobStore.get(f.blobKey));
  }
  // 空文件夹以目录条目保存（有文件的文件夹由文件路径体现）
  for (const d of await listFolders(projectId)) {
    if (!files.some((f) => f.path.startsWith(d + '/'))) entries[d + '/'] = new Uint8Array(0);
  }
  return zipSync(entries, { level: 6 });
}

/** 从 zip 导入为新项目（兼容 Overleaf 导出的 zip 与 GitHub 仓库 zip）。zh：错误信息用中文 */
export async function importProjectZip(userId: string, name: string, data: Buffer, zh = false) {
  const t = (cn: string, en: string) => (zh ? cn : en);
  await assertCanCreateProject(userId);
  if (data.length > MAX_ZIP_BYTES) throw badRequest(t('压缩包过大（上限 200 MB）', 'The zip is too large (limit 200 MB)'));
  let raw: Record<string, Uint8Array>;
  // 解压前按条目声明的原始大小把关，防止“压缩炸弹”（几 MB 的 zip 解出几十 GB）占满内存
  const unpackLimit = config.quota.maxProjectBytes > 0 ? config.quota.maxProjectBytes : 1024 * 1024 * 1024;
  let declared = 0;
  try {
    raw = unzipSync(new Uint8Array(data), {
      filter: (f) => {
        declared += f.originalSize;
        if (declared > unpackLimit) throw new HttpError(413, t(`解压后的文件总大小超过上限（${Math.round(unpackLimit / 1024 / 1024)} MB）`, `The unpacked files exceed the size limit (${Math.round(unpackLimit / 1024 / 1024)} MB)`));
        return true;
      },
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest(t('无法解析 zip 文件', 'Could not read the zip file'));
  }
  let paths = Object.keys(raw).filter((p) => !p.endsWith('/') && !SKIP.test(p));
  if (!paths.length) throw badRequest(t('压缩包里没有可导入的文件', 'The zip contains no files to import'));
  if (paths.length > MAX_ENTRIES) throw badRequest(t(`文件过多（上限 ${MAX_ENTRIES} 个）`, `Too many files (limit ${MAX_ENTRIES})`));

  // 所有文件都在同一个顶层目录下时去掉这一层（如 paper-main/…）
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  const strip = tops.size === 1 && paths.every((p) => p.includes('/')) ? [...tops][0] + '/' : '';
  const entries: { path: string; data: Uint8Array }[] = [];
  for (const p of paths) {
    try {
      entries.push({ path: normalizeProjectPath(p.slice(strip.length)), data: raw[p] });
    } catch (e) {
      if (!(e instanceof PathError)) throw e;
    }
  }
  paths = entries.map((e) => e.path);
  // 空文件夹（目录条目下没有任何文件）也保留
  const emptyDirs = new Set<string>();
  for (const k of Object.keys(raw)) {
    if (!k.endsWith('/') || SKIP.test(k) || !k.startsWith(strip) || k === strip) continue;
    try {
      const d = normalizeProjectPath(k.slice(strip.length).replace(/\/+$/, ''));
      if (!paths.some((p) => p.startsWith(d + '/'))) emptyDirs.add(d);
    } catch (e) {
      if (!(e instanceof PathError)) throw e;
    }
  }
  const total = entries.reduce((n, e) => n + e.data.length, 0);
  if (config.quota.maxProjectBytes > 0 && total > config.quota.maxProjectBytes) {
    throw new HttpError(413, t(`解压后的文件总大小超过项目上限（${Math.round(config.quota.maxProjectBytes / 1024 / 1024)} MB）`, `The unpacked files exceed the project size limit (${Math.round(config.quota.maxProjectBytes / 1024 / 1024)} MB)`));
  }

  // 主文件：含 \documentclass 的 .tex，优先 main.tex，其次路径最短
  const texWithClass = entries
    .filter((e) => e.path.endsWith('.tex') && /\\documentclass/.test(strFromU8(e.data.subarray(0, 20000))))
    .map((e) => e.path)
    .sort((a, b) => (a === 'main.tex' ? -1 : b === 'main.tex' ? 1 : a.split('/').length - b.split('/').length || a.length - b.length));
  const mainFile = texWithClass[0] ?? paths.find((p) => p.endsWith('.tex'));
  if (!mainFile) throw badRequest(t('压缩包里没有 .tex 文件', 'The zip contains no .tex file'));
  const usesXe = texWithClass[0]
    ? /\\usepackage(\[[^\]]*\])?\{(ctex|xeCJK|fontspec)\}|\\documentclass(\[[^\]]*\])?\{ctex/.test(
        strFromU8(entries.find((e) => e.path === texWithClass[0])!.data.subarray(0, 20000)),
      )
    : false;

  const blobs: { path: string; key: string; size: number }[] = [];
  for (const e of entries) {
    const asText = isTextPath(e.path) && e.data.length <= config.limits.maxTextFileBytes;
    if (!asText) blobs.push({ path: e.path, key: await blobStore.put(Buffer.from(e.data)), size: e.data.length });
  }

  return db.transaction(async (tx) => {
    const [p] = await tx
      .insert(schema.projects)
      .values({ ownerId: userId, name: name.trim().slice(0, 120) || 'Imported Project', mainFile, engine: usesXe ? 'xelatex' : 'pdflatex' })
      .returning();
    await tx.insert(schema.projectMembers).values({ projectId: p.id, userId, role: 'owner' });
    for (const e of entries) {
      const blob = blobs.find((b) => b.path === e.path);
      if (blob) {
        await tx.insert(schema.files).values({ projectId: p.id, path: e.path, kind: 'binary', blobKey: blob.key, size: blob.size });
      } else {
        const text = strFromU8(e.data);
        const [f] = await tx.insert(schema.files).values({ projectId: p.id, path: e.path, kind: 'text', size: e.data.length }).returning();
        await tx.insert(schema.docStates).values({ fileId: f.id, state: encodeInitialState(text) });
      }
    }
    for (const d of emptyDirs) {
      if (!paths.includes(d)) await tx.insert(schema.folders).values({ projectId: p.id, path: d }).onConflictDoNothing();
    }
    await tx.update(schema.projects).set({ updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    return { id: p.id, name: p.name, fileCount: entries.length, mainFile };
  });
}
