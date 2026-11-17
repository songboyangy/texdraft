import { createRequire } from 'node:module';
import path from 'node:path/posix';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { applyPatch, diffLines, parsePatch } from 'diff';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { CompileDiagnostic } from '@texdraft/shared';
import { readText, transactText, applyMinimalReplace } from '../collab/hocuspocus.js';
import { checkCompileRate, compileProject, latestCompile } from '../compile/service.js';
import { db, schema } from '../db/client.js';
import { blobStore } from '../lib/blobStore.js';
import { normalizeProjectPath } from '../lib/paths.js';
import { createTextFile, deleteFile, findFile, getProject, listFiles } from '../projects/service.js';
import { diffVersion, listVersions } from '../projects/versions.js';
import { ToolError } from './moreTools.js';

/**
 * 面向论文写作的 MCP 工具：看 PDF 页面、精确编译诊断、多文件原子修改、依赖分析、引用上下文、改动差异。
 */

const PROJECT = { project: { type: 'string', description: 'Project id or exact project name. Optional when the access token is bound to one project.' } };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const PAPER_TOOL_SPECS = [
  {
    name: 'get_pdf_pages',
    description:
      'Render pages of the most recent compiled PDF as PNG images (plus their extracted text) to check layout, equations, figures and tables. ' +
      'Compile first if the source changed. Up to 4 pages per call.',
    inputSchema: obj({
      ...PROJECT,
      pages: { type: 'string', description: 'Pages to render, e.g. "1", "2-4", "1,3,5" (default "1")' },
      scale: { type: 'number', minimum: 0.5, maximum: 3, default: 1.5, description: 'Zoom; 1.5 ≈ 900px wide for A4/Letter' },
      include_text: { type: 'boolean', default: true },
    }),
  },
  {
    name: 'get_compile_diagnostics',
    description:
      'Structured compile errors/warnings with file, line, message, the offending source lines and a hint for common LaTeX errors. ' +
      'Uses the latest compile, or compiles first with recompile: true.',
    inputSchema: obj({
      ...PROJECT,
      recompile: { type: 'boolean', default: false },
      level: { type: 'string', enum: ['error', 'warning', 'all'], default: 'all', description: '"warning" includes errors; "all" also lists overfull/underfull boxes' },
      context_lines: { type: 'integer', minimum: 0, maximum: 10, default: 2 },
    }),
  },
  {
    name: 'apply_patch',
    description:
      'Apply several changes across one or more files atomically: either every change applies or nothing is modified. ' +
      'Give "edits" (list of {path, old_str, new_str, replace_all}; old_str must match exactly once unless replace_all; an empty old_str on a missing file creates it) ' +
      'or "patch" (a unified diff, may create files from /dev/null or delete them to /dev/null). Changes are merged line-by-line so collaborators\' concurrent edits elsewhere are kept.',
    inputSchema: obj({
      ...PROJECT,
      edits: {
        type: 'array',
        items: obj({ path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' }, replace_all: { type: 'boolean', default: false } }, ['path', 'old_str', 'new_str']),
      },
      patch: { type: 'string', description: 'Unified diff (git diff format accepted)' },
      dry_run: { type: 'boolean', default: false, description: 'Validate and show the resulting diff without changing anything' },
    }),
  },
  {
    name: 'get_project_dependencies',
    description:
      'Dependency tree starting at the main file: \\input / \\include / \\subfile / \\import, \\includegraphics (honouring \\graphicspath), bibliographies, local .sty/.cls and listings. ' +
      'Reports missing files (with file:line) and project files that are never referenced.',
    inputSchema: obj({ ...PROJECT }),
  },
  {
    name: 'get_citation_context',
    description:
      'Every citation in the paper: the key, its bibliography entry (title/author) or MISSING, and each place it is cited with file:line and the surrounding sentence. Also lists bibliography entries that are never cited.',
    inputSchema: obj({
      ...PROJECT,
      key: { type: 'string', description: 'Only this citation key' },
      context_chars: { type: 'integer', minimum: 40, maximum: 600, default: 180 },
    }),
  },
  {
    name: 'get_file_diff',
    description:
      'Unified diff of the project between a saved version and now, to review changes. Defaults to the most recent version (e.g. the checkpoint taken before the latest AI edits). Optionally limit to one file.',
    inputSchema: obj({
      ...PROJECT,
      path: { type: 'string' },
      version_id: { type: 'string', description: 'Base version from list_versions (default: the most recent one)' },
      max_chars: { type: 'integer', minimum: 1000, maximum: 100000, default: 30000 },
    }),
  },
];

export const PAPER_READ_ONLY = ['get_pdf_pages', 'get_compile_diagnostics', 'get_project_dependencies', 'get_citation_context', 'get_file_diff'];
export const PAPER_WRITE_TOOLS = new Set(['apply_patch']);
export const PAPER_TITLES: Record<string, string> = {
  get_pdf_pages: 'View PDF pages', get_compile_diagnostics: 'Compile diagnostics', apply_patch: 'Apply multi-file patch',
  get_project_dependencies: 'Project dependencies', get_citation_context: 'Citation context', get_file_diff: 'Diff since version',
};

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** 去掉 LaTeX 注释（保留 \%），保持行数不变 */
function stripComments(line: string) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === '%') return line.slice(0, i);
  }
  return line;
}

async function textFiles(projectId: string) {
  const files = await listFiles(projectId);
  const out = new Map<string, string>();
  for (const f of files) if (f.kind === 'text') out.set(f.path, await readText(f.id));
  return { files, texts: out };
}

// =====================================================================
// get_pdf_pages
// =====================================================================

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;
const require_ = createRequire(import.meta.url);
const loadPdfJs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

function parsePages(spec: string, total: number) {
  const out = new Set<number>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) throw new ToolError(`Invalid page spec "${part}". Use e.g. "1", "2-4" or "1,3".`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b) && out.size < 50; p++) if (p >= 1 && p <= total) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

async function getPdfPages(projectId: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const [job] = await db
    .select()
    .from(schema.compileJobs)
    .where(and(eq(schema.compileJobs.projectId, projectId), isNotNull(schema.compileJobs.pdfKey)))
    .orderBy(desc(schema.compileJobs.createdAt))
    .limit(1);
  if (!job?.pdfKey) throw new ToolError('No PDF yet. Call compile first.');
  const latest = await latestCompile(projectId);
  const stale = latest && latest.jobId !== job.id ? ` NOTE: the latest compile (${latest.status}) produced no PDF; these pages come from an earlier successful compile.` : '';

  const pdfjs = await loadPdfJs();
  const { createCanvas } = require_('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  const data = new Uint8Array(await blobStore.get(job.pdfKey));
  // 中文等 CID 字体需要 cMap 才能正确渲染与提取文字；标准 14 字体需要 standard_fonts（Node 端是文件系统路径）
  const pdfjsRoot = path.dirname(require_.resolve('pdfjs-dist/package.json'));
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: false,
    cMapUrl: `${pdfjsRoot}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfjsRoot}/standard_fonts/`,
  });
  const doc = await task.promise;
  try {
    const pages = parsePages(str(args.pages) ?? '1', doc.numPages);
    if (!pages.length) throw new ToolError(`The PDF has ${doc.numPages} page(s); none of the requested pages exist.`);
    const shown = pages.slice(0, 4);
    const scale = Math.min(3, Math.max(0.5, Number(args.scale ?? 1.5)));
    const includeText = args.include_text !== false;
    const content: CallToolResult['content'] = [
      {
        type: 'text',
        text: `PDF from compile at ${job.createdAt.toISOString()} — ${doc.numPages} page(s). Showing page(s) ${shown.join(', ')}.` +
          (pages.length > shown.length ? ` (${pages.length - shown.length} more requested; ask again for them.)` : '') + stale,
      },
    ];
    for (const n of shown) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale });
      const w = Math.ceil(vp.width);
      const h = Math.ceil(vp.height);
      if (w * h > 12_000_000) throw new ToolError('Requested scale is too large for this page size.');
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
      content.push({ type: 'image', data: canvas.toBuffer('image/png').toString('base64'), mimeType: 'image/png' });
      if (includeText) {
        const tc = await page.getTextContent();
        let pageText = '';
        for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) pageText += (it.str ?? '') + (it.hasEOL ? '\n' : '');
        pageText = pageText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        content.push({ type: 'text', text: `--- page ${n} text ---\n${pageText.slice(0, 3000)}${pageText.length > 3000 ? '\n…' : ''}` });
      }
      page.cleanup();
    }
    return { content };
  } finally {
    await task.destroy();
  }
}

// =====================================================================
// get_compile_diagnostics
// =====================================================================

const HINTS: [RegExp, string][] = [
  [/Undefined control sequence/i, 'A command is misspelled or its package is not loaded (\\usepackage{...}).'],
  [/Missing \$ inserted/i, 'Math-only syntax (_ ^ \\alpha …) used outside math mode, or a math environment is not closed.'],
  [/File `?([^'`]+)'? not found/i, 'The file is not in the project (check the path / extension) or the package is unavailable.'],
  [/Citation .* undefined/i, 'The key is not in the .bib file, or BibTeX/biber has not run yet (compile again).'],
  [/Reference .* undefined/i, 'No matching \\label, or it needs another compile pass.'],
  [/Extra alignment tab/i, 'A table row has more & than the column spec allows.'],
  [/Missing \} inserted|Extra \}|Runaway argument/i, 'Unbalanced braces near this line.'],
  [/\\begin\{([^}]+)\} on input line \d+ ended by \\end\{([^}]+)\}/i, 'Environments are mismatched or not closed in order.'],
  [/Misplaced alignment tab character &/i, '& used outside a table/align; escape it as \\&.'],
  [/Overfull \\hbox/i, 'A line sticks into the margin: rephrase, allow hyphenation, or break long URLs/formulas.'],
  [/There's no line here to end/i, '\\\\ used where no line is being typeset (e.g. after a blank line).'],
  [/Font .* not found|fontspec error/i, 'The font is not installed for this engine; use another font or switch engine.'],
];

async function getCompileDiagnostics(projectId: string, userId: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (args.recompile) await checkCompileRate(userId, false);
  const result = args.recompile ? await compileProject(projectId, 'mcp:diagnostics') : await latestCompile(projectId);
  if (!result) throw new ToolError('The project has not been compiled yet. Pass recompile: true.');
  const level = str(args.level) ?? 'all';
  const ctxLines = Math.min(10, Math.max(0, Number(args.context_lines ?? 2)));
  const wanted = (d: CompileDiagnostic) => (level === 'error' ? d.level === 'error' : level === 'warning' ? d.level !== 'badbox' : true);
  const diags = result.diagnostics.filter(wanted);
  const counts = (l: string) => result.diagnostics.filter((d) => d.level === l).length;
  const head = `Compile ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s, PDF ${result.ok ? 'generated' : 'NOT generated'}. ` +
    `${counts('error')} error(s), ${counts('warning')} warning(s), ${counts('badbox')} bad box(es).`;
  if (!diags.length) return text(head + (result.ok ? ' Nothing to fix at this level.' : `\nLog tail:\n${result.logTail.slice(-2000)}`));

  const cache = new Map<string, string[] | null>();
  const sourceLines = async (file: string) => {
    if (!cache.has(file)) {
      const f = await findFile(projectId, file).catch(() => null);
      cache.set(file, f?.kind === 'text' ? (await readText(f.id)).split('\n') : null);
    }
    return cache.get(file)!;
  };
  const blocks: string[] = [];
  for (const [i, d] of diags.slice(0, 40).entries()) {
    const loc = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : '(location unknown)';
    let block = `#${i + 1} [${d.level}] ${loc}\n  ${d.message.trim().replace(/\n/g, '\n  ')}`;
    const hint = HINTS.find(([re]) => re.test(d.message))?.[1];
    if (hint) block += `\n  hint: ${hint}`;
    if (d.file && d.line) {
      const lines = await sourceLines(d.file);
      if (lines) {
        const from = Math.max(1, d.line - ctxLines);
        const to = Math.min(lines.length, d.line + ctxLines);
        const width = String(to).length;
        for (let n = from; n <= to; n++) block += `\n  ${n === d.line ? '>' : ' '} ${String(n).padStart(width)} | ${lines[n - 1]}`;
      }
    }
    blocks.push(block);
  }
  if (diags.length > 40) blocks.push(`… ${diags.length - 40} more`);
  return text(`${head}\n\n${blocks.join('\n\n')}`);
}

// =====================================================================
// apply_patch
// =====================================================================

interface FileChange { path: string; kind: 'modify' | 'create' | 'delete'; transform?: (cur: string) => string; content?: string }

function editTransform(path: string, edits: { old_str: string; new_str: string; replace_all?: boolean }[]) {
  return (cur: string) => {
    let out = cur;
    for (const [i, e] of edits.entries()) {
      if (!e.old_str) throw new ToolError(`${path}: edit #${i + 1} has an empty old_str (only allowed to create a missing file).`);
      const count = out.split(e.old_str).length - 1;
      if (count === 0) throw new ToolError(`${path}: edit #${i + 1} old_str not found (it must match the current text exactly, including whitespace).`);
      if (count > 1 && !e.replace_all) throw new ToolError(`${path}: edit #${i + 1} old_str matches ${count} times; add more context or set replace_all.`);
      out = e.replace_all ? out.split(e.old_str).join(e.new_str) : out.replace(e.old_str, () => e.new_str);
    }
    return out;
  };
}

const stripPrefix = (p: string | undefined) => (p ?? '').replace(/^"|"$/g, '').replace(/\t.*$/, '').replace(/^[ab]\//, '');

function changesFromPatch(patchText: string): FileChange[] {
  let parsed;
  try {
    parsed = parsePatch(patchText);
  } catch (e) {
    throw new ToolError(`Could not parse the patch: ${(e as Error).message}`);
  }
  const changes: FileChange[] = [];
  for (const fp of parsed) {
    if (!fp.hunks.length) continue;
    const oldName = stripPrefix(fp.oldFileName);
    const newName = stripPrefix(fp.newFileName);
    if (newName === '/dev/null' || newName === 'dev/null') {
      changes.push({ path: normalizeProjectPath(oldName), kind: 'delete' });
    } else if (oldName === '/dev/null' || oldName === 'dev/null') {
      const content = applyPatch('', fp);
      if (content === false) throw new ToolError(`${newName}: could not build the new file from the patch.`);
      changes.push({ path: normalizeProjectPath(newName), kind: 'create', content });
    } else {
      if (oldName && newName && oldName !== newName) throw new ToolError(`Renames are not supported in patches (${oldName} → ${newName}); use move_file.`);
      const p = normalizeProjectPath(newName || oldName);
      changes.push({
        path: p,
        kind: 'modify',
        transform: (cur) => {
          const r = applyPatch(cur, fp, { fuzzFactor: 0 });
          if (r === false) throw new ToolError(`${p}: a hunk does not match the current file. Re-read the file and regenerate the patch.`);
          return r;
        },
      });
    }
  }
  if (!changes.length) throw new ToolError('The patch contains no changes.');
  return changes;
}

/** 按行差异把 cur → next 写入 Yjs：只改动变化的行块，其余位置（含协作者的并发编辑）不受影响 */
function applyLineDiff(ytext: import('yjs').Text, cur: string, next: string) {
  const ops: { at: number; oldStr: string; newStr: string }[] = [];
  let pos = 0;
  let pending: { at: number; oldStr: string; newStr: string } | null = null;
  for (const part of diffLines(cur, next)) {
    if (part.added || part.removed) {
      pending ??= { at: pos, oldStr: '', newStr: '' };
      if (part.removed) {
        pending.oldStr += part.value;
        pos += part.value.length;
      } else pending.newStr += part.value;
    } else {
      if (pending) ops.push(pending);
      pending = null;
      pos += part.value.length;
    }
  }
  if (pending) ops.push(pending);
  for (const op of ops.reverse()) applyMinimalReplace(ytext, op.at, op.oldStr, op.newStr);
}

async function applyPatchTool(projectId: string, args: Record<string, unknown>, touch: (p: string) => void): Promise<CallToolResult> {
  const hasEdits = Array.isArray(args.edits) && args.edits.length > 0;
  const hasPatch = typeof args.patch === 'string' && args.patch.trim() !== '';
  if (hasEdits === hasPatch) throw new ToolError('Provide either "edits" or "patch".');

  let changes: FileChange[];
  if (hasPatch) changes = changesFromPatch(args.patch as string);
  else {
    const byPath = new Map<string, { old_str: string; new_str: string; replace_all?: boolean }[]>();
    for (const e of args.edits as { path: string; old_str: string; new_str: string; replace_all?: boolean }[]) {
      const p = normalizeProjectPath(String(e.path ?? ''));
      byPath.set(p, [...(byPath.get(p) ?? []), { old_str: String(e.old_str ?? ''), new_str: String(e.new_str ?? ''), replace_all: !!e.replace_all }]);
    }
    changes = [];
    for (const [p, edits] of byPath) {
      if (edits.length === 1 && edits[0].old_str === '' && !(await findFile(projectId, p))) changes.push({ path: p, kind: 'create', content: edits[0].new_str });
      else changes.push({ path: p, kind: 'modify', transform: editTransform(p, edits) });
    }
  }
  if (new Set(changes.map((c) => c.path)).size !== changes.length) throw new ToolError('Each file may appear only once in a patch.');

  // ---- 第一阶段：全部校验，任何一处失败都不做修改
  const problems: string[] = [];
  const preview: { path: string; before: string; after: string; fileId?: string }[] = [];
  for (const c of changes) {
    const f = await findFile(projectId, c.path);
    try {
      if (c.kind === 'create') {
        if (f) throw new ToolError(`${c.path}: already exists.`);
        preview.push({ path: c.path, before: '', after: c.content ?? '' });
      } else {
        if (!f) throw new ToolError(`${c.path}: file not found.`);
        if (f.kind !== 'text') throw new ToolError(`${c.path}: binary files cannot be patched.`);
        const before = await readText(f.id);
        preview.push({ path: c.path, before, after: c.kind === 'delete' ? '' : c.transform!(before), fileId: f.id });
      }
    } catch (e) {
      problems.push(e instanceof ToolError ? e.message : `${c.path}: ${(e as Error).message}`);
    }
  }
  if (problems.length) return { content: [{ type: 'text', text: `Nothing was changed. ${problems.length} problem(s):\n- ${problems.join('\n- ')}` }], isError: true };

  const summary = changes.map((c, i) => {
    const p = preview[i];
    let add = 0;
    let del = 0;
    for (const part of diffLines(p.before, p.after)) {
      const n = part.count ?? 0;
      if (part.added) add += n;
      else if (part.removed) del += n;
    }
    return `${c.kind === 'create' ? 'created' : c.kind === 'delete' ? 'deleted' : 'modified'} ${c.path} (+${add} −${del})`;
  });
  if (args.dry_run) return text(`Dry run OK — would apply:\n- ${summary.join('\n- ')}`);

  // ---- 第二阶段：写入；中途失败则回滚已写入的文件
  const done: { change: FileChange; before: string; fileId?: string }[] = [];
  try {
    for (const [i, c] of changes.entries()) {
      const p = preview[i];
      touch(c.path);
      if (c.kind === 'create') {
        await createTextFile(projectId, c.path, c.content ?? '');
        done.push({ change: c, before: '' });
      } else if (c.kind === 'delete') {
        await deleteFile(projectId, c.path);
        done.push({ change: c, before: p.before });
      } else {
        let before = '';
        await transactText(p.fileId!, 'mcp-apply-patch', (y) => {
          before = y.toString();
          // 基于写入瞬间的最新文本重新计算，校验后若有人改动了相关位置会在这里报错
          applyLineDiff(y, before, c.transform!(before));
        });
        done.push({ change: c, before, fileId: p.fileId });
      }
    }
  } catch (e) {
    for (const d of done.reverse()) {
      try {
        if (d.change.kind === 'create') await deleteFile(projectId, d.change.path);
        else if (d.change.kind === 'delete') await createTextFile(projectId, d.change.path, d.before);
        else await transactText(d.fileId!, 'mcp-apply-patch-rollback', (y) => applyLineDiff(y, y.toString(), d.before));
      } catch (re) {
        console.error('[mcp] apply_patch rollback failed', re);
      }
    }
    throw new ToolError(`Patch aborted and rolled back: ${(e as Error).message}`);
  }
  return text(`Applied atomically:\n- ${summary.join('\n- ')}`);
}

// =====================================================================
// get_project_dependencies
// =====================================================================

const GRAPHIC_EXTS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg', '.PDF', '.PNG', '.JPG'];

async function getDependencies(projectId: string, userId: string): Promise<CallToolResult> {
  const project = await getProject(projectId, userId);
  const { files, texts } = await textFiles(projectId);
  const all = new Set(files.map((f) => f.path));
  const used = new Set<string>();
  const missing: string[] = [];
  const tree: string[] = [];
  const graphicsPaths: string[] = [''];

  const resolve = (ref: string, exts: string[], bases: string[]) => {
    for (const base of bases) for (const ext of exts) {
      const cand = path.normalize(path.join(base, ref + ext)).replace(/^\.\//, '');
      if (all.has(cand)) return cand;
    }
    return null;
  };

  const visit = (file: string, depth: number, baseDir: string, seen: Set<string>) => {
    used.add(file);
    tree.push(`${'  '.repeat(depth)}${file}`);
    if (seen.has(file)) {
      tree[tree.length - 1] += '  (cycle)';
      return;
    }
    const src = texts.get(file);
    if (src === undefined) return;
    const nextSeen = new Set(seen).add(file);
    const lines = src.split('\n').map(stripComments);
    const children: { kind: string; target: string; line: number; dir?: string }[] = [];
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/g)) {
        for (const g of m[1].matchAll(/\{([^}]*)\}/g)) if (!graphicsPaths.includes(g[1])) graphicsPaths.push(g[1]);
      }
      for (const m of line.matchAll(/\\(input|include|subfile)\s*\{([^}]+)\}/g)) children.push({ kind: 'tex', target: m[2].trim(), line: i + 1 });
      for (const m of line.matchAll(/\\(sub)?(?:import|inputfrom|includefrom)\*?\s*\{([^}]*)\}\s*\{([^}]+)\}/g)) {
        children.push({ kind: 'tex', target: m[3].trim(), dir: m[1] ? path.join(baseDir, m[2]) : m[2], line: i + 1 });
      }
      for (const m of line.matchAll(/\\(includegraphics|includesvg|includepdf)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g)) children.push({ kind: 'graphic', target: m[2].trim(), line: i + 1 });
      for (const m of line.matchAll(/\\bibliography\s*\{([^}]+)\}/g)) for (const b of m[1].split(',')) children.push({ kind: 'bib', target: b.trim(), line: i + 1 });
      for (const m of line.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) children.push({ kind: 'bib', target: m[1].trim(), line: i + 1 });
      for (const m of line.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) for (const p of m[1].split(',')) children.push({ kind: 'sty', target: p.trim(), line: i + 1 });
      for (const m of line.matchAll(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) children.push({ kind: 'cls', target: m[1].trim(), line: i + 1 });
      for (const m of line.matchAll(/\\(lstinputlisting|verbatiminput|inputminted)\s*(?:\[[^\]]*\])?\s*(?:\{[^}]*\}\s*)?\{([^}]+)\}/g)) children.push({ kind: 'other', target: m[2].trim(), line: i + 1 });
    });
    for (const c of children) {
      const where = `${file}:${c.line}`;
      if (c.kind === 'tex') {
        const hit = resolve(c.target, ['', '.tex'], c.dir !== undefined ? [c.dir] : ['', baseDir]);
        if (hit) visit(hit, depth + 1, c.dir ?? baseDir, nextSeen);
        else missing.push(`${c.target} (\\input/\\include at ${where})`);
      } else if (c.kind === 'graphic') {
        const hit = resolve(c.target, GRAPHIC_EXTS, graphicsPaths.map((g) => path.join(baseDir, g)).concat(graphicsPaths));
        if (hit) {
          used.add(hit);
          tree.push(`${'  '.repeat(depth + 1)}[figure] ${hit}`);
        } else missing.push(`${c.target} (figure at ${where})`);
      } else if (c.kind === 'bib') {
        const hit = resolve(c.target, c.target.endsWith('.bib') ? [''] : ['.bib', ''], ['', baseDir]);
        if (hit) {
          used.add(hit);
          tree.push(`${'  '.repeat(depth + 1)}[bibliography] ${hit}`);
        } else missing.push(`${c.target}.bib (bibliography at ${where})`);
      } else if (c.kind === 'sty' || c.kind === 'cls') {
        const hit = resolve(c.target, [`.${c.kind}`], ['', baseDir]);
        if (hit) {
          used.add(hit);
          tree.push(`${'  '.repeat(depth + 1)}[local ${c.kind}] ${hit}`);
        }
      } else {
        const hit = resolve(c.target, [''], ['', baseDir]);
        if (hit) {
          used.add(hit);
          tree.push(`${'  '.repeat(depth + 1)}[listing] ${hit}`);
        } else missing.push(`${c.target} (listing at ${where})`);
      }
    }
  };

  if (!all.has(project.mainFile)) return text(`Main file ${project.mainFile} does not exist. Set it with update_project.`);
  visit(project.mainFile, 0, '', new Set());
  const ignorable = /(^|\/)(readme|license|latexmkrc|\.latexmkrc)(\.\w+)?$|\.(md|txt|gitignore)$/i;
  const unused = files.map((f) => f.path).filter((p) => !used.has(p) && !ignorable.test(p));
  return text(
    [
      `Main file: ${project.mainFile}`,
      '',
      'Dependency tree:',
      ...tree,
      '',
      `Missing (${missing.length}):`,
      ...(missing.length ? missing.map((m) => `  ${m}`) : ['  (none)']),
      '',
      `Not referenced from the main file (${unused.length}):`,
      ...(unused.length ? unused.map((u) => `  ${u}`) : ['  (none)']),
    ].join('\n'),
  );
}

// =====================================================================
// BibTeX 解析（字段可同行 / 跨行，支持嵌套花括号与引号）
// =====================================================================

interface BibEntry { key: string; type: string; file: string; fields: Record<string, string> }

function readBalanced(src: string, i: number, open: string, close: string) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) return j;
  }
  return -1;
}

export function parseBib(src: string, file = ''): BibEntry[] {
  const out: BibEntry[] = [];
  const re = /@(\w+)\s*([{(])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const type = m[1].toLowerCase();
    const openIdx = m.index + m[0].length - 1;
    const end = readBalanced(src, openIdx, m[2], m[2] === '{' ? '}' : ')');
    if (end < 0) break;
    re.lastIndex = end + 1;
    if (['comment', 'preamble', 'string'].includes(type)) continue;
    const body = src.slice(openIdx + 1, end);
    const comma = body.indexOf(',');
    const key = (comma < 0 ? body : body.slice(0, comma)).trim();
    if (!key) continue;
    const fields: Record<string, string> = {};
    let rest = comma < 0 ? '' : body.slice(comma + 1);
    const fre = /\s*([A-Za-z][\w-]*)\s*=\s*/y;
    let pos = 0;
    while (pos < rest.length) {
      fre.lastIndex = pos;
      const fm = fre.exec(rest);
      if (!fm) { pos++; continue; }
      let v = '';
      let q = fre.lastIndex;
      if (rest[q] === '{') {
        const e = readBalanced(rest, q, '{', '}');
        v = rest.slice(q + 1, e < 0 ? rest.length : e);
        q = e < 0 ? rest.length : e + 1;
      } else if (rest[q] === '"') {
        const e = rest.indexOf('"', q + 1);
        v = rest.slice(q + 1, e < 0 ? rest.length : e);
        q = e < 0 ? rest.length : e + 1;
      } else {
        const e = rest.slice(q).search(/[,}]|$/);
        v = rest.slice(q, q + e).trim();
        q += e;
      }
      fields[fm[1].toLowerCase()] = v.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
      const nextComma = rest.indexOf(',', q);
      pos = nextComma < 0 ? rest.length : nextComma + 1;
    }
    out.push({ key, type, file, fields });
  }
  return out;
}

// =====================================================================
// get_citation_context
// =====================================================================

async function getCitationContext(projectId: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const { texts } = await textFiles(projectId);
  const entries = [...texts].filter(([f]) => /\.bib$/i.test(f)).flatMap(([f, src]) => parseBib(src, f));
  const bib = new Map(entries.map((e) => [e.key, { title: e.fields.title, author: e.fields.author, year: e.fields.year, file: e.file }]));
  const only = str(args.key)?.trim();
  const width = Math.min(600, Math.max(40, Number(args.context_chars ?? 180)));
  const uses = new Map<string, { where: string; command: string; context: string }[]>();

  for (const [file, src] of texts) {
    if (!/\.(tex|ltx)$/i.test(file)) continue;
    const lines = src.split('\n');
    const clean = lines.map(stripComments).join('\n');
    const lineStarts = [0];
    for (let i = 0; i < clean.length; i++) if (clean[i] === '\n') lineStarts.push(i + 1);
    const lineOf = (idx: number) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= idx) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    for (const m of clean.matchAll(/\\([A-Za-z]*cite[A-Za-z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g)) {
      const idx = m.index!;
      const before = clean.slice(Math.max(0, idx - width), idx);
      const after = clean.slice(idx + m[0].length, idx + m[0].length + width / 2);
      // 句子边界：截到前一个句号/空行
      const sentStart = Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n\n'));
      const context = `${sentStart >= 0 ? '' : '…'}${before.slice(sentStart >= 0 ? sentStart + 2 : 0)}【${m[0]}】${after}…`.replace(/\s+/g, ' ').trim();
      for (const key of m[2].split(',').map((k) => k.trim()).filter(Boolean)) {
        if (key === '*' || (only && key !== only)) continue;
        uses.set(key, [...(uses.get(key) ?? []), { where: `${file}:${lineOf(idx)}`, command: `\\${m[1]}`, context }]);
      }
    }
  }

  const keys = [...uses.keys()].sort();
  const blocks = keys.map((k) => {
    const entry = bib.get(k);
    const head = `${k} — ${entry ? `${entry.title ?? '(no title)'}${entry.author ? ` / ${entry.author}` : ''}${entry.year ? ` (${entry.year})` : ''} [${entry.file}]` : 'MISSING from the bibliography'}`;
    return [head, ...uses.get(k)!.map((u) => `  ${u.where} ${u.command}: ${u.context}`)].join('\n');
  });
  const missingKeys = keys.filter((k) => !bib.has(k));
  const uncited = only ? [] : entries.map((e) => e.key).filter((k) => !uses.has(k));
  const header = only
    ? `Citation "${only}": ${uses.get(only)?.length ?? 0} use(s)${bib.has(only) ? '' : ', not in any .bib file'}.`
    : `${keys.length} cited key(s), ${[...uses.values()].reduce((n, u) => n + u.length, 0)} citation(s). Missing from .bib: ${missingKeys.length ? missingKeys.join(', ') : 'none'}.`;
  return text(
    [header, '', ...(blocks.length ? blocks : ['(no citations found)']), ...(uncited.length ? ['', `In the bibliography but never cited (${uncited.length}): ${uncited.join(', ')}`] : [])].join('\n'),
  );
}

// =====================================================================
// get_file_diff
// =====================================================================

async function getFileDiff(projectId: string, args: Record<string, unknown>): Promise<CallToolResult> {
  let vid = str(args.version_id);
  const versions = await listVersions(projectId);
  if (!vid) {
    vid = versions[0]?.id;
    if (!vid) throw new ToolError('No saved versions yet; nothing to compare against. Use save_version first.');
  } else if (!/^[0-9a-f-]{36}$/i.test(vid)) throw new ToolError('Invalid version_id; use an id from list_versions.');
  const base = versions.find((v) => v.id === vid);
  const d = await diffVersion(projectId, vid);
  const only = str(args.path) ? normalizeProjectPath(str(args.path)!) : null;
  const changed = d.files.filter((f) => f.status !== 'unchanged' && (!only || f.path === only));
  const label = base ? `${base.kind}${base.label ? ` "${base.label}"` : ''} at ${base.createdAt}` : d.createdAt;
  if (!changed.length) return text(`No differences between version ${vid} (${label}) and now${only ? ` for ${only}` : ''}.`);
  const max = Math.min(100000, Math.max(1000, Number(args.max_chars ?? 30000)));
  let body = '';
  for (const f of changed) {
    body += f.binary ? `Binary file ${f.path} ${f.status}\n` : f.patch.replace(/^Index: .*\n=+\n/, '') + '\n';
    if (body.length > max) {
      body = body.slice(0, max) + '\n… (truncated; pass path or a larger max_chars)';
      break;
    }
  }
  const summary = changed.map((f) => `${f.status} ${f.path}${f.binary ? '' : ` (+${f.additions} −${f.deletions})`}`).join(', ');
  return text(`Changes since version ${vid} (${label}) → now: ${summary}\n\n${body}`);
}

// =====================================================================

export async function runPaperTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; userId: string; touch(path: string): void },
): Promise<CallToolResult> {
  switch (name) {
    case 'get_pdf_pages':
      return getPdfPages(ctx.projectId, args);
    case 'get_compile_diagnostics':
      return getCompileDiagnostics(ctx.projectId, ctx.userId, args);
    case 'apply_patch':
      return applyPatchTool(ctx.projectId, args, ctx.touch);
    case 'get_project_dependencies':
      return getDependencies(ctx.projectId, ctx.userId);
    case 'get_citation_context':
      return getCitationContext(ctx.projectId, args);
    case 'get_file_diff':
      return getFileDiff(ctx.projectId, args);
  }
  throw new ToolError(`Unknown tool: ${name}`);
}
