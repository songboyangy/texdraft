import type { CompileResult } from '@texdraft/shared';
import picomatch from 'picomatch';
import { z } from 'zod';
import { applyMinimalReplace, readText, setWholeText, transactText } from '../collab/hocuspocus.js';
import { checkCompileRate, compileProject } from '../compile/service.js';
import { config } from '../config.js';
import { ToolError, type ToolContext } from './types.js';
import { normalizeProjectPath } from '../lib/paths.js';
import {
  createFolder, createTextFile, deleteFile, deleteFolder, findFile, listFiles, listFolders, normalizeFolderPath, readTextFile,
  renameFile, renameFolder,
} from '../projects/service.js';

/** 核心文件工具运行时一定有项目（scope = project） */
type CoreContext = ToolContext & { projectId: string };

export interface CoreToolSpec<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  jsonSchema: Record<string, unknown>;
  /** 给界面看的操作对象（文件路径、搜索词等）；动作名称由前端按语言显示 */
  summarize: (input: z.infer<S>) => string;
  run: (input: z.infer<S>, ctx: CoreContext) => Promise<string>;
}

function defineTool<S extends z.ZodTypeAny>(spec: CoreToolSpec<S>) {
  return spec;
}

const MAX_READ_LINES = 1500;
const MAX_GREP_RESULTS = 200;

function numbered(lines: string[], startLine: number) {
  return lines.map((l, i) => `${String(startLine + i).padStart(5)}\t${l}`).join('\n');
}

function lineOf(text: string, index: number) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function countOccurrences(hay: string, needle: string) {
  let count = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) count++;
  return count;
}

/** 编辑后返回改动附近的片段，方便模型核对 */
function snippetAround(text: string, startIdx: number, len: number) {
  const lines = text.split('\n');
  const first = lineOf(text, startIdx);
  const last = lineOf(text, startIdx + Math.max(0, len - 1));
  const from = Math.max(1, first - 3);
  const to = Math.min(lines.length, last + 3);
  return numbered(lines.slice(from - 1, to), from);
}

export function formatCompileResult(r: CompileResult) {
  const errors = r.diagnostics.filter((d) => d.level === 'error');
  const warnings = r.diagnostics.filter((d) => d.level === 'warning');
  const badboxes = r.diagnostics.filter((d) => d.level === 'badbox');
  const fmt = (d: CompileResult['diagnostics'][number]) =>
    `- ${d.file ?? '?'}${d.line ? `:${d.line}` : ''}: ${d.message}`;
  const parts = [
    `status: ${r.status} (${(r.durationMs / 1000).toFixed(1)}s), pdf ${r.ok ? 'generated and shown to the user' : 'NOT generated'}`,
    `errors (${errors.length}):`,
    ...errors.slice(0, 30).map(fmt),
    `warnings (${warnings.length}):`,
    ...warnings.slice(0, 20).map(fmt),
    badboxes.length ? `overfull/underfull boxes: ${badboxes.length} (first: ${badboxes.slice(0, 3).map(fmt).join(' ')})` : '',
  ];
  if (errors.length === 0 && !r.ok && r.logTail) parts.push('log tail:\n' + r.logTail.slice(-2000));
  return parts.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------

const listFilesTool = defineTool({
  name: 'list_files',
  description: 'List every file in the LaTeX project with its kind (text/binary) and size in bytes, plus any empty folders.',
  schema: z.object({}),
  jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
  summarize: () => '',
  async run(_i, ctx) {
    const files = await listFiles(ctx.projectId);
    const empty = (await listFolders(ctx.projectId)).filter((d) => !files.some((f) => f.path.startsWith(d + '/')));
    const lines = [...files.map((f) => `${f.path}\t${f.kind}\t${f.size}B`), ...empty.map((d) => `${d}/\tfolder (empty)`)];
    return lines.join('\n') || '(project is empty)';
  },
});

const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a text file. Output lines are prefixed with their 1-based line number and a tab (the prefix is NOT part of the file). ' +
    `Reads at most ${MAX_READ_LINES} lines per call; use start_line/end_line for large files.`,
  schema: z.object({
    path: z.string(),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative path, e.g. "sections/intro.tex"' },
      start_line: { type: 'integer', minimum: 1 },
      end_line: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  summarize: (i) => `${i.path}${i.start_line ? `:${i.start_line}-${i.end_line ?? ''}` : ''}`,
  async run(i, ctx) {
    const { content } = await readTextFile(ctx.projectId, i.path);
    const lines = content.split('\n');
    const start = i.start_line ?? 1;
    const end = Math.min(lines.length, i.end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
    if (start > lines.length) return `(file has only ${lines.length} lines)`;
    const body = numbered(lines.slice(start - 1, end), start);
    const more = end < lines.length ? `\n... (${lines.length - end} more lines; total ${lines.length})` : '';
    return body + more;
  },
});

const grepTool = defineTool({
  name: 'grep',
  description:
    'Search all text files with a JavaScript regular expression. Returns "path:line: text" matches. ' +
    'Use it to find \\label, \\ref, \\cite keys, commands, or wording across the project.',
  schema: z.object({ pattern: z.string().min(1), glob: z.string().optional(), case_sensitive: z.boolean().optional() }),
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JS regex, e.g. "\\\\label\\{fig:" ' },
      glob: { type: 'string', description: 'Optional path filter, e.g. "sections/**/*.tex" or "*.bib"' },
      case_sensitive: { type: 'boolean' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  summarize: (i) => `/${i.pattern}/${i.glob ? `  ${i.glob}` : ''}`,
  async run(i, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(i.pattern, i.case_sensitive ? '' : 'i');
    } catch (e) {
      throw new ToolError(`Invalid regex: ${(e as Error).message}`);
    }
    const match = i.glob ? picomatch(i.glob, { dot: true, matchBase: !i.glob.includes('/') }) : () => true;
    const files = (await listFiles(ctx.projectId)).filter((f) => f.kind === 'text' && match(f.path));
    const results: string[] = [];
    for (const f of files) {
      const lines = (await readText(f.id)).split('\n');
      for (let n = 0; n < lines.length; n++) {
        if (re.test(lines[n])) {
          results.push(`${f.path}:${n + 1}: ${lines[n].length > 300 ? lines[n].slice(0, 300) + '…' : lines[n]}`);
          if (results.length >= MAX_GREP_RESULTS) return results.join('\n') + `\n... (stopped at ${MAX_GREP_RESULTS} matches)`;
        }
      }
    }
    return results.join('\n') || 'No matches.';
  },
});

const strReplaceTool = defineTool({
  name: 'str_replace',
  description:
    'Edit a text file by replacing an exact string. old_str must match the current file content exactly (including whitespace and line breaks, ' +
    'without the line-number prefixes from read_file) and must be unique unless replace_all is true. ' +
    'Include enough surrounding context to make it unique. Prefer several small replacements over one huge one. ' +
    'The edit is applied live to the shared document, so collaborators see it immediately.',
  schema: z.object({
    path: z.string(),
    old_str: z.string().min(1),
    new_str: z.string(),
    replace_all: z.boolean().optional(),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_str: { type: 'string', description: 'Exact text to replace (non-empty)' },
      new_str: { type: 'string', description: 'Replacement text (may be empty to delete)' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness' },
    },
    required: ['path', 'old_str', 'new_str'],
    additionalProperties: false,
  },
  summarize: (i) => i.path,
  async run(i, ctx) {
    const { file } = await readTextFile(ctx.projectId, i.path);
    const path = file.path;
    const result = await transactText(file.id, `agent:${ctx.runId}`, (y) => {
      const text = y.toString();
      const count = countOccurrences(text, i.old_str);
      if (count === 0) {
        const trimmed = i.old_str.trim();
        const hint = trimmed !== i.old_str && text.includes(trimmed)
          ? ' (a whitespace-trimmed version exists — check leading/trailing whitespace)'
          : ' — the file may have changed; re-read it before retrying';
        throw new ToolError(`old_str not found in ${path}${hint}`);
      }
      if (count > 1 && !i.replace_all) {
        throw new ToolError(`old_str matches ${count} places in ${path}; add more context or set replace_all`);
      }
      if (i.replace_all) {
        // 从后往前替换，前面的索引不受影响
        const idxs: number[] = [];
        for (let k = text.indexOf(i.old_str); k !== -1; k = text.indexOf(i.old_str, k + i.old_str.length)) idxs.push(k);
        for (const k of idxs.reverse()) applyMinimalReplace(y, k, i.old_str, i.new_str);
        return { count, idx: idxs[idxs.length - 1] };
      }
      const idx = text.indexOf(i.old_str);
      applyMinimalReplace(y, idx, i.old_str, i.new_str);
      return { count: 1, idx };
    });
    ctx.touch(path);
    ctx.emit({ type: 'file_changed', path, action: 'modified' });
    const after = await readText(file.id);
    return `Replaced ${result.count} occurrence(s) in ${path}. Excerpt after edit:\n${snippetAround(after, result.idx, i.new_str.length)}`;
  },
});

const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Create a new text file, or overwrite an existing one with complete new content. ' +
    'Use for new files (sections, .bib, .sty). For changes to existing files prefer str_replace.',
  schema: z.object({ path: z.string(), content: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string', description: 'Full file content' } },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  summarize: (i) => i.path,
  async run(i, ctx) {
    const path = normalizeProjectPath(i.path);
    if (Buffer.byteLength(i.content) > config.limits.maxTextFileBytes) throw new ToolError('content too large');
    const existing = await findFile(ctx.projectId, path);
    if (existing && existing.kind !== 'text') throw new ToolError(`${path} is a binary file`);
    if (existing) {
      await transactText(existing.id, `agent:${ctx.runId}`, (y) => setWholeText(y, i.content));
    } else {
      await createTextFile(ctx.projectId, path, i.content);
    }
    ctx.touch(path);
    ctx.emit({ type: 'file_changed', path, action: existing ? 'modified' : 'created' });
    return `${existing ? 'Overwrote' : 'Created'} ${path} (${i.content.split('\n').length} lines).`;
  },
});

const deleteFileTool = defineTool({
  name: 'delete_file',
  description: 'Delete a file from the project. Only do this when the user clearly asked for it or it is obviously part of the task.',
  schema: z.object({ path: z.string() }),
  jsonSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  summarize: (i) => i.path,
  async run(i, ctx) {
    const path = normalizeProjectPath(i.path);
    await deleteFile(ctx.projectId, path);
    ctx.touch(path);
    ctx.emit({ type: 'file_changed', path, action: 'deleted' });
    return `Deleted ${path}.`;
  },
});

const moveFileTool = defineTool({
  name: 'move_file',
  description: 'Rename or move a file. Remember to update \\input/\\include/\\includegraphics references to it.',
  schema: z.object({ from: z.string(), to: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' } },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  summarize: (i) => `${i.from} → ${i.to}`,
  async run(i, ctx) {
    const from = normalizeProjectPath(i.from);
    const to = normalizeProjectPath(i.to);
    await renameFile(ctx.projectId, from, to);
    ctx.touch(from);
    ctx.touch(to);
    ctx.emit({ type: 'file_changed', path: to, action: 'created' });
    return `Moved ${from} to ${to}.`;
  },
});

const FOLDER_SCHEMA = { type: 'object', properties: { path: { type: 'string', description: 'Folder path relative to the project root, e.g. sections or figures/plots' } }, required: ['path'], additionalProperties: false };

const createFolderTool = defineTool({
  name: 'create_folder',
  description:
    'Create a folder (it may stay empty). Parent folders are created as needed; succeeds without changes if the folder already exists. ' +
    'You do not need this before write_file: writing a/b.tex creates folder a implicitly.',
  schema: z.object({ path: z.string() }),
  jsonSchema: FOLDER_SCHEMA,
  summarize: (i) => i.path,
  async run(i, ctx) {
    const r = await createFolder(ctx.projectId, i.path);
    return r.created ? `Created folder ${r.path}/.` : `Folder ${r.path}/ already exists.`;
  },
});

const moveFolderTool = defineTool({
  name: 'move_folder',
  description:
    'Rename or move a folder together with everything inside it. The target must not exist yet. ' +
    'Afterwards update \\input/\\include/\\includegraphics/\\graphicspath references that used the old path.',
  schema: z.object({ from: z.string(), to: z.string() }),
  jsonSchema: {
    type: 'object',
    properties: { from: { type: 'string', description: 'Existing folder path' }, to: { type: 'string', description: 'New folder path' } },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  summarize: (i) => `${i.from} → ${i.to}`,
  async run(i, ctx) {
    const from = normalizeFolderPath(i.from);
    const to = normalizeFolderPath(i.to);
    const moved = await renameFolder(ctx.projectId, from, to);
    for (const m of moved) {
      ctx.touch(m.from);
      ctx.touch(m.to);
      ctx.emit({ type: 'file_changed', path: m.to, action: 'created' });
    }
    return `Moved folder ${from}/ to ${to}/ (${moved.length} file${moved.length === 1 ? '' : 's'}).` +
      (moved.length ? `\n${moved.map((m) => `${m.from} → ${m.to}`).slice(0, 50).join('\n')}` : '');
  },
});

const deleteFolderTool = defineTool({
  name: 'delete_folder',
  description:
    'Delete a folder and every file inside it. Only do this when the user clearly asked for it. ' +
    'List the folder first so you know what will be removed.',
  schema: z.object({ path: z.string() }),
  jsonSchema: FOLDER_SCHEMA,
  summarize: (i) => i.path,
  async run(i, ctx) {
    const path = normalizeFolderPath(i.path);
    const deleted = await deleteFolder(ctx.projectId, path);
    for (const p of deleted) {
      ctx.touch(p);
      ctx.emit({ type: 'file_changed', path: p, action: 'deleted' });
    }
    return `Deleted folder ${path}/ (${deleted.length} file${deleted.length === 1 ? '' : 's'}).` +
      (deleted.length ? `\n${deleted.slice(0, 50).join('\n')}` : '');
  },
});

const compileTool = defineTool({
  name: 'compile',
  description:
    'Compile the project (main file as configured) and return structured errors/warnings with file and line. ' +
    'The resulting PDF is shown to the user automatically. Compile after non-trivial edits to verify them.',
  schema: z.object({}),
  jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
  summarize: () => '',
  async run(_i, ctx) {
    await checkCompileRate(ctx.userId, false);
    const result = await compileProject(ctx.projectId, `agent:${ctx.runId}`);
    ctx.emit({ type: 'compile_result', result });
    return formatCompileResult(result);
  },
});

export const CORE_TOOLS = [
  listFilesTool, readFileTool, grepTool, strReplaceTool, writeFileTool, deleteFileTool, moveFileTool,
  createFolderTool, moveFolderTool, deleteFolderTool, compileTool,
] as unknown as CoreToolSpec[];
