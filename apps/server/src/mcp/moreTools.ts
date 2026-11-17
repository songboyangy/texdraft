import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path/posix';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readText, setWholeText, transactText } from '../collab/hocuspocus.js';
import { latestCompile } from '../compile/service.js';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { blobStore } from '../lib/blobStore.js';
import { normalizeProjectPath } from '../lib/paths.js';
import { replaceInProject } from '../projects/search.js';
import {
  createFolder,
  createProject,
  createTextFile,
  deleteFile,
  ENGINES,
  findFile,
  getProject,
  listFiles,
  listFolders,
  snapshotProject,
  updateProject,
  uploadFile,
  upsertBinaryFile,
} from '../projects/service.js';
import { projectSymbols } from '../projects/symbols.js';
import { createVersion, listVersions, restoreVersion } from '../projects/versions.js';

/**
 * MCP 专用的项目 / 文件管理工具（内置 Agent 不需要）：
 * 新建、复制项目，项目设置，复制、上传文件，全项目替换，大纲，历史版本。
 */

export { ToolError } from '../tools/types.js';
import { ToolError } from '../tools/types.js';

const PROJECT = { project: { type: 'string', description: 'Project id or exact project name. Optional when the access token is bound to one project.' } };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** ChatGPT 传入用户上传文件时的对象结构（_meta["openai/fileParams"]） */
const FILE_OBJECT = {
  type: 'object',
  description: 'A file the user attached in the chat.',
  properties: {
    download_url: { type: 'string' },
    file_id: { type: 'string' },
    mime_type: { type: 'string' },
    file_name: { type: 'string' },
  },
  required: ['download_url', 'file_id'],
};

export const MORE_TOOL_SPECS = [
  {
    name: 'create_project',
    description: 'Create a new TeXdraft project containing a starter main.tex. Returns the new project id.',
    inputSchema: obj({ name: { type: 'string', description: 'Project name' } }, ['name']),
  },
  {
    name: 'copy_project',
    description: 'Duplicate a project (all files and settings) into a new project you own. Returns the new project id.',
    inputSchema: obj({ ...PROJECT, name: { type: 'string', description: 'Name of the copy (default: "<name> (copy)")' } }),
  },
  {
    name: 'get_project',
    description: 'Show project settings (name, main file, engine, your role), file count/size and the status of the latest compile.',
    inputSchema: obj({ ...PROJECT }),
  },
  {
    name: 'update_project',
    description: 'Rename the project or change its main file / LaTeX engine (pdflatex, xelatex, lualatex). Only the given fields change.',
    inputSchema: obj({
      ...PROJECT,
      name: { type: 'string' },
      main_file: { type: 'string', description: 'Path of the root .tex file' },
      engine: { type: 'string', enum: ENGINES },
    }),
  },
  {
    name: 'copy_file',
    description: 'Copy a file (text or binary) to a new path inside the project. Folders are created implicitly.',
    inputSchema: obj({ ...PROJECT, from: { type: 'string' }, to: { type: 'string' }, overwrite: { type: 'boolean', default: false } }, ['from', 'to']),
  },
  {
    name: 'upload_file',
    description:
      'Add a file (image, PDF, .bib, .tex, data …) to the project. Provide exactly one source: "file" (a file the user attached in the chat), "url" (public https URL), or "content_base64". ' +
      'Text files become editable documents; others are stored as binary. "path" may be a folder ending with "/" to keep the original file name. Existing files are overwritten.',
    inputSchema: obj({
      ...PROJECT,
      path: { type: 'string', description: 'Target path, e.g. figures/plot.png or figures/' },
      file: FILE_OBJECT,
      url: { type: 'string', description: 'Public https URL to download' },
      content_base64: { type: 'string', description: 'File content encoded as base64' },
    }),
  },
  {
    name: 'replace_in_project',
    description: 'Find and replace across all text files of the project (or only "paths"). Supports regex ($1 back-references), case sensitivity and whole words. Returns the number of replacements.',
    inputSchema: obj(
      {
        ...PROJECT,
        query: { type: 'string' },
        replacement: { type: 'string' },
        regex: { type: 'boolean', default: false },
        case_sensitive: { type: 'boolean', default: false },
        whole_word: { type: 'boolean', default: false },
        paths: { type: 'array', items: { type: 'string' }, description: 'Limit to these files' },
      },
      ['query', 'replacement'],
    ),
  },
  {
    name: 'get_outline',
    description: 'Document structure: section headings (file:line), \\label keys and BibTeX keys defined in the project. Useful before cross-referencing or citing.',
    inputSchema: obj({ ...PROJECT }),
  },
  {
    name: 'list_versions',
    description: 'List saved versions of the project (manual saves, automatic snapshots, checkpoints before AI edits), newest first.',
    inputSchema: obj({ ...PROJECT, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }),
  },
  {
    name: 'save_version',
    description: 'Save a named snapshot of the whole project to its History.',
    inputSchema: obj({ ...PROJECT, label: { type: 'string' } }),
  },
  {
    name: 'restore_version',
    description: 'Restore the project (or only "paths") to a version from list_versions. The current state is saved as a version first, so this can be undone.',
    inputSchema: obj({ ...PROJECT, version_id: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, ['version_id']),
  },
];

/** 不需要已有项目的工具 */
export const NO_PROJECT_TOOLS = new Set(['create_project']);
/** 修改项目文件：需要编辑权限，并在首次修改前打检查点 */
export const MORE_FILE_WRITE_TOOLS = new Set(['copy_file', 'upload_file', 'replace_in_project']);
/** 需要编辑权限但不改文件内容（或自带安全快照） */
export const MORE_EDITOR_TOOLS = new Set(['update_project', 'save_version', 'restore_version']);
export const MORE_READ_ONLY = ['get_project', 'get_outline', 'list_versions'];
export const MORE_DESTRUCTIVE = ['upload_file', 'replace_in_project', 'restore_version'];
export const MORE_TITLES: Record<string, string> = {
  create_project: 'Create project', copy_project: 'Copy project', get_project: 'Project info', update_project: 'Project settings',
  copy_file: 'Copy file', upload_file: 'Upload file', replace_in_project: 'Find & replace in project', get_outline: 'Document outline',
  list_versions: 'List versions', save_version: 'Save version', restore_version: 'Restore version',
};

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

// ---------------- 下载（防 SSRF） ----------------

function isPrivateAddress(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

/** 只允许公网 https 地址；每一跳重定向都重新检查，限制大小与时间 */
async function download(rawUrl: string): Promise<{ data: Buffer; fileName?: string; contentType?: string }> {
  let url = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ToolError(`Invalid URL: ${url}`);
    }
    if (u.protocol !== 'https:') throw new ToolError('Only https URLs can be downloaded.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addrs.length) throw new ToolError(`Cannot resolve ${host}`);
    if (addrs.some(isPrivateAddress)) throw new ToolError('Downloading from private or local network addresses is not allowed.');

    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, u).toString();
      continue;
    }
    if (!res.ok) throw new ToolError(`Download failed: HTTP ${res.status}`);
    const max = config.limits.maxUploadBytes;
    if (Number(res.headers.get('content-length') ?? 0) > max) throw new ToolError(`File is larger than ${max >> 20} MB`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > max) throw new ToolError(`File is larger than ${max >> 20} MB`);
      chunks.push(Buffer.from(chunk));
    }
    const cd = res.headers.get('content-disposition') ?? '';
    const fromHeader = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ?? /filename="?([^";]+)"?/i.exec(cd)?.[1];
    const fileName = fromHeader ? decodeURIComponent(fromHeader) : path.basename(u.pathname) || undefined;
    return { data: Buffer.concat(chunks), fileName, contentType: res.headers.get('content-type') ?? undefined };
  }
  throw new ToolError('Too many redirects');
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'application/x-bibtex': '.bib', 'text/x-tex': '.tex', 'text/csv': '.csv',
};

/** 把文件名清理成安全的项目内文件名 */
function safeName(name: string | undefined, mime?: string) {
  let n = (name ?? '').split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N}._ -]/gu, '_').trim();
  if (!n || n.startsWith('.')) n = `upload${n}`;
  if (!path.extname(n) && mime) n += EXT_BY_MIME[mime.split(';')[0].trim()] ?? '';
  return n;
}

// ---------------- 复制 ----------------

async function copyBlob(blobKey: string) {
  return blobStore.put(await blobStore.get(blobKey));
}

// ---------------- 处理 ----------------

export interface MoreToolContext {
  userId: string;
  /** 令牌是否限定在单个项目 */
  scoped: boolean;
  projectId: string | null;
  touch(path: string): void;
}

export async function runMoreTool(name: string, args: Record<string, unknown>, ctx: MoreToolContext): Promise<CallToolResult> {
  const { userId } = ctx;

  if (name === 'create_project') {
    if (ctx.scoped) throw new ToolError('This access token is bound to a single project and cannot create projects.');
    const p = await createProject(userId, str(args.name) ?? '');
    return text(`Created project "${p.name}" (id ${p.id}) with a starter main.tex.`);
  }

  const projectId = ctx.projectId!;

  if (name === 'copy_project') {
    if (ctx.scoped) throw new ToolError('This access token is bound to a single project and cannot create projects.');
    const src = await getProject(projectId, userId);
    const copy = await createProject(userId, str(args.name) ?? `${src.name} (copy)`);
    const files = await snapshotProject(projectId);
    for (const f of files) {
      if (f.kind === 'text') {
        if (f.path === 'main.tex') {
          const target = await findFile(copy.id, 'main.tex');
          await transactText(target!.id, 'copy-project', (y) => setWholeText(y, f.content ?? ''));
        } else {
          await createTextFile(copy.id, f.path, f.content ?? '');
        }
      } else if (f.blobKey) {
        await db.insert(schema.files).values({ projectId: copy.id, path: f.path, kind: 'binary', blobKey: await copyBlob(f.blobKey), size: f.size });
      }
    }
    if (!files.some((f) => f.path === 'main.tex')) await deleteFile(copy.id, 'main.tex');
    for (const d of await listFolders(projectId)) await createFolder(copy.id, d);
    await updateProject(copy.id, userId, { mainFile: src.mainFile, engine: src.engine });
    return text(`Copied "${src.name}" to new project "${copy.name}" (id ${copy.id}, ${files.length} files).`);
  }

  if (name === 'get_project') {
    const p = await getProject(projectId, userId);
    const files = await listFiles(projectId);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    const last = await latestCompile(projectId);
    return text(
      [
        `Project: ${p.name} (id ${p.id})`,
        `Your role: ${p.role}`,
        `Main file: ${p.mainFile}`,
        `Engine: ${p.engine}`,
        `Files: ${files.length} (${files.filter((f) => f.kind === 'text').length} text), ${(bytes / 1024).toFixed(1)} KB`,
        `Last updated: ${p.updatedAt}`,
        `Latest compile: ${last ? `${last.status}${` in ${(last.durationMs / 1000).toFixed(1)}s`}, ${last.diagnostics.filter((d) => d.level === 'error').length} errors` : 'never compiled'}`,
      ].join('\n'),
    );
  }

  if (name === 'update_project') {
    const patch = { name: str(args.name), mainFile: str(args.main_file), engine: str(args.engine) };
    if (!patch.name && !patch.mainFile && !patch.engine) throw new ToolError('Nothing to change: pass name, main_file or engine.');
    await updateProject(projectId, userId, patch);
    const p = await getProject(projectId, userId);
    return text(`Updated. Name: ${p.name}; main file: ${p.mainFile}; engine: ${p.engine}.`);
  }

  if (name === 'copy_file') {
    const from = normalizeProjectPath(str(args.from) ?? '');
    const to = normalizeProjectPath(str(args.to) ?? '');
    const src = await findFile(projectId, from);
    if (!src) throw new ToolError(`File not found: ${from}`);
    const existing = await findFile(projectId, to);
    if (existing && !args.overwrite) throw new ToolError(`${to} already exists; pass overwrite: true to replace it.`);
    if (src.kind === 'text') {
      const content = await readText(src.id);
      if (existing?.kind === 'text') await transactText(existing.id, 'mcp-copy', (y) => setWholeText(y, content));
      else {
        if (existing) await deleteFile(projectId, to);
        await createTextFile(projectId, to, content);
      }
    } else {
      if (existing?.kind === 'text') await deleteFile(projectId, to);
      await upsertBinaryFile(projectId, to, await blobStore.get(src.blobKey!));
    }
    ctx.touch(to);
    return text(`Copied ${from} → ${to}.`);
  }

  if (name === 'upload_file') {
    const sources = [args.file, args.url, args.content_base64].filter((v) => v !== undefined && v !== null && v !== '');
    if (sources.length !== 1) throw new ToolError('Provide exactly one of "file", "url" or "content_base64".');
    let data: Buffer;
    let fileName: string | undefined;
    let mime: string | undefined;
    if (args.file) {
      const f = args.file as { download_url?: string; file_name?: string; mime_type?: string };
      if (!f.download_url) throw new ToolError('The attached file has no download_url.');
      const d = await download(f.download_url);
      data = d.data;
      fileName = f.file_name ?? d.fileName;
      mime = f.mime_type ?? d.contentType;
    } else if (typeof args.url === 'string') {
      const d = await download(args.url);
      data = d.data;
      fileName = d.fileName;
      mime = d.contentType;
    } else {
      data = Buffer.from(String(args.content_base64), 'base64');
      if (data.length > config.limits.maxUploadBytes) throw new ToolError('File is too large');
    }
    let target = str(args.path)?.trim() ?? '';
    if (!target || target.endsWith('/')) {
      if (!fileName && !mime && !target) throw new ToolError('Pass "path" (no file name could be determined).');
      target += safeName(fileName, mime);
    }
    const entry = await uploadFile(projectId, target, data);
    ctx.touch(entry.path);
    return text(`Uploaded ${entry.path} (${entry.kind}, ${(data.length / 1024).toFixed(1)} KB).` + (entry.kind === 'binary' && /\.(png|jpe?g|pdf|eps|svg)$/i.test(entry.path) ? ` Include it with \\includegraphics{${entry.path}}.` : ''));
  }

  if (name === 'replace_in_project') {
    const paths = Array.isArray(args.paths) ? (args.paths as string[]).map(normalizeProjectPath) : undefined;
    for (const f of await listFiles(projectId)) if (f.kind === 'text' && (!paths || paths.includes(f.path))) ctx.touch(f.path);
    const r = await replaceInProject(projectId, {
      query: str(args.query) ?? '',
      replacement: str(args.replacement) ?? '',
      regex: !!args.regex,
      caseSensitive: !!args.case_sensitive,
      wholeWord: !!args.whole_word,
      paths,
    });
    return text(r.replaced ? `Replaced ${r.replaced} occurrence(s) in ${r.files} file(s).` : 'No matches; nothing was changed.');
  }

  if (name === 'get_outline') {
    const files = await listFiles(projectId);
    const headings: string[] = [];
    const re = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
    for (const f of files) {
      if (f.kind !== 'text' || !/\.(tex|ltx)$/i.test(f.path)) continue;
      const lines = (await readText(f.id)).split('\n');
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('%')) return;
        for (const m of line.matchAll(re)) {
          const depth = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'].indexOf(m[1]);
          headings.push(`${'  '.repeat(Math.max(0, depth - 2))}${m[2].trim()}  (${f.path}:${i + 1})`);
        }
      });
    }
    const sym = await projectSymbols(projectId);
    return text(
      [
        'Sections:',
        headings.join('\n') || '  (none)',
        '',
        `Labels (${sym.labels.length}): ${sym.labels.map((l) => `${l.label} (${l.file}:${l.line})`).join(', ') || '(none)'}`,
        '',
        `BibTeX keys (${sym.citations.length}): ${sym.citations.map((c) => c.key).join(', ') || '(none)'}`,
      ].join('\n'),
    );
  }

  if (name === 'list_versions') {
    const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
    const versions = (await listVersions(projectId)).slice(0, limit);
    if (!versions.length) return text('No saved versions yet.');
    return text(
      versions
        .map((v) => {
          const changes = v.run?.changes?.length ? ` — changed ${v.run.changes.map((c) => `${c.path} +${c.additions}/-${c.deletions}`).join(', ')}${v.run.reverted ? ' (undone)' : ''}` : '';
          return `${v.id}\t${v.createdAt}\t${v.kind}\t${v.label ?? ''}${changes}`;
        })
        .join('\n'),
    );
  }

  if (name === 'save_version') {
    const label = str(args.label)?.trim() || null;
    const v = await createVersion(projectId, userId, 'manual', label);
    return text(`Saved version ${v.id}${label ? ` "${label}"` : ''} (${v.files.length} files).`);
  }

  if (name === 'restore_version') {
    const vid = str(args.version_id) ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(vid)) throw new ToolError('Invalid version_id; use an id from list_versions.');
    const paths = Array.isArray(args.paths) ? (args.paths as string[]).map(normalizeProjectPath) : undefined;
    paths?.forEach((p) => ctx.touch(p));
    const r = await restoreVersion(projectId, userId, vid, paths, 'Before restore (MCP)');
    return text(`Restored ${r.changed} file(s). The previous state was saved as version ${r.safetyVersionId}.`);
  }

  throw new ToolError(`Unknown tool: ${name}`);
}

