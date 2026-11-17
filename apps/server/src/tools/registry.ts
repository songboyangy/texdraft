import type { CitationSearchResult } from '@texdraft/shared';
import { latestCompile } from '../compile/service.js';
import { addCitation, searchOnline } from '../projects/citations.js';
import { listProjects } from '../projects/service.js';
import { editProjectTagsByName, listTags } from '../projects/tags.js';
import {
  MORE_DESTRUCTIVE,
  MORE_EDITOR_TOOLS,
  MORE_FILE_WRITE_TOOLS,
  MORE_READ_ONLY,
  MORE_TITLES,
  MORE_TOOL_SPECS,
  NO_PROJECT_TOOLS,
  runMoreTool,
} from '../mcp/moreTools.js';
import { PAPER_READ_ONLY, PAPER_TITLES, PAPER_TOOL_SPECS, PAPER_WRITE_TOOLS, runPaperTool } from '../mcp/paperTools.js';
import { CORE_TOOLS, formatCompileResult } from './core.js';
import { ToolError, textResult, type ToolContext, type ToolDef, type ToolResult } from './types.js';

/**
 * 全部工具的唯一注册表。内置 Agent 取 agent=true 的子集（只在当前项目内工作），MCP 取 mcp=true 的全部。
 */

const FILE_WRITE = new Set(['str_replace', 'write_file', 'delete_file', 'move_file', 'create_folder', 'move_folder', 'delete_folder', 'add_citation', ...MORE_FILE_WRITE_TOOLS, ...PAPER_WRITE_TOOLS]);
const EDITOR = new Set([...MORE_EDITOR_TOOLS]);
const READ_ONLY = new Set(['list_projects', 'list_files', 'read_file', 'grep', 'compile', 'get_compile_result', 'search_citations', ...MORE_READ_ONLY, ...PAPER_READ_ONLY]);
const DESTRUCTIVE = new Set(['write_file', 'delete_file', 'delete_folder', ...MORE_DESTRUCTIVE, 'apply_patch']);
const IDEMPOTENT = new Set(['tag_project', 'read_file', 'list_files', 'grep', 'list_projects', 'get_compile_result', 'write_file', 'delete_file', 'create_folder']);

/**
 * 不给内置 Agent 的工具：它只在当前项目内工作；每次运行自带检查点与一键撤销，所以不需要 restore_version；
 * compile 已返回诊断，get_compile_result 多余。
 */
const NOT_FOR_AGENT = new Set(['list_projects', 'create_project', 'copy_project', 'restore_version', 'get_compile_result', 'tag_project']);

const CORE_TITLES: Record<string, string> = {
  list_files: 'List files', read_file: 'Read file', grep: 'Search project', str_replace: 'Edit file', write_file: 'Write file',
  delete_file: 'Delete file', move_file: 'Move/rename file', create_folder: 'Create folder', move_folder: 'Move/rename folder',
  delete_folder: 'Delete folder', compile: 'Compile',
};

const access = (name: string) => (FILE_WRITE.has(name) ? 'files' : EDITOR.has(name) ? 'edit' : 'read') as ToolDef['access'];

function base(name: string, title: string) {
  return {
    name,
    title,
    access: access(name),
    readOnly: READ_ONLY.has(name),
    destructive: DESTRUCTIVE.has(name),
    idempotent: IDEMPOTENT.has(name),
    openWorld: name === 'search_citations',
    agent: !NOT_FOR_AGENT.has(name),
    mcp: true,
  };
}

/** 去掉 MCP 专用的 project 参数（MCP 层统一添加） */
function withoutProject(schema: Record<string, unknown>) {
  const props = { ...((schema.properties as Record<string, unknown>) ?? {}) };
  delete props.project;
  return { ...schema, properties: props };
}

/** 通用的界面摘要：取最能说明操作对象的参数 */
function genericSummary(input: Record<string, unknown>) {
  for (const k of ['path', 'query', 'key', 'pages', 'name', 'version_id', 'label']) {
    if (typeof input[k] === 'string' && input[k]) return String(input[k]).slice(0, 120);
  }
  if (typeof input.from === 'string' && typeof input.to === 'string') return `${input.from} → ${input.to}`;
  if (Array.isArray(input.edits)) {
    const paths = [...new Set((input.edits as { path?: string }[]).map((e) => e.path).filter(Boolean))];
    return paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` +${paths.length - 3}` : '');
  }
  return '';
}

// ---------------- 核心文件工具 ----------------

const coreDefs: ToolDef[] = CORE_TOOLS.map((t) => ({
  ...base(t.name, CORE_TITLES[t.name] ?? t.name),
  description: t.description,
  inputSchema: t.jsonSchema,
  schema: t.schema,
  scope: 'project',
  summarize: (input) => {
    const p = t.schema.safeParse(input);
    return p.success ? t.summarize(p.data) : '';
  },
  run: (input, ctx) => t.run(input as never, ctx as ToolContext & { projectId: string }),
}));

// ---------------- 项目、编译结果与文献 ----------------

const citeLine = (r: CitationSearchResult, i: number) =>
  `[${i}] ${r.title} — ${r.authors.slice(0, 3).join(', ')}${r.authors.length > 3 ? ' et al.' : ''} (${r.year ?? 'n.d.'}) ${r.source === 'arxiv' ? `arXiv:${r.id}` : `doi:${r.id}`}`;

const projectDefs: ToolDef[] = [
  {
    ...base('list_projects', 'List projects'),
    description:
      'List the TeXdraft projects this token can access (id, name, your role, last update, your tags). ' +
      'Pass tag to list only projects with that tag (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: { tag: { type: 'string', description: 'Only projects carrying this tag' } },
      additionalProperties: false,
    },
    scope: 'global',
    async run(i, ctx) {
      const all = await listProjects(ctx.userId);
      const names = new Map((await listTags(ctx.userId)).map((t) => [t.id, t.name]));
      let shown = ctx.scoped && ctx.projectId ? all.filter((p) => p.id === ctx.projectId) : all;
      const want = typeof i.tag === 'string' ? i.tag.trim().toLowerCase() : '';
      if (want) shown = shown.filter((p) => (p.tags ?? []).some((id) => names.get(id)?.toLowerCase() === want));
      const line = (p: (typeof all)[number]) => {
        const tags = (p.tags ?? []).map((id) => names.get(id)).filter(Boolean);
        return `${p.id}\t${p.name}\t${p.role}\tupdated ${p.updatedAt}${tags.length ? `\ttags: ${tags.join(', ')}` : ''}`;
      };
      return shown.map(line).join('\n') || (want ? `(no projects tagged "${i.tag}")` : '(no projects)');
    },
  },
  {
    ...base('tag_project', 'Tag project'),
    description:
      'Add or remove your own tags on the project (tags organise the project list; they are personal and do not change the project). ' +
      'Tags in add are created if they do not exist. Returns the project\'s tags afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string' }, description: 'Tag names to add' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tag names to remove' },
      },
      additionalProperties: false,
    },
    scope: 'project',
    summarize: (i) => [...((i.add as string[]) ?? []).map((t) => `+${t}`), ...((i.remove as string[]) ?? []).map((t) => `-${t}`)].join(' '),
    async run(i, ctx) {
      const add = Array.isArray(i.add) ? i.add.map(String) : [];
      const remove = Array.isArray(i.remove) ? i.remove.map(String) : [];
      if (!add.length && !remove.length) throw new ToolError('Nothing to change: pass add and/or remove.');
      const now = await editProjectTagsByName(ctx.userId, ctx.projectId!, add, remove);
      return now.length ? `Tags now: ${now.join(', ')}.` : 'The project has no tags now.';
    },
  },
  {
    ...base('get_compile_result', 'Get compile result'),
    description: 'Return the diagnostics of the most recent compile of the project without recompiling.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'project',
    async run(_i, ctx) {
      const r = await latestCompile(ctx.projectId!);
      return r ? formatCompileResult(r) : 'The project has not been compiled yet. Call compile.';
    },
  },
  {
    ...base('search_citations', 'Search references'),
    description:
      'Search Crossref (journal/conference papers) and arXiv (preprints) for references. Accepts a title, keywords, a DOI or an arXiv id. Returns candidates with an index to pass to add_citation.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    scope: 'project',
    summarize: (i) => String(i.query ?? ''),
    async run(i, ctx) {
      const q = String(i.query ?? '');
      const { results, errors } = await searchOnline(q);
      ctx.cache.set(`cite:${q}`, results);
      return (results.map(citeLine).join('\n') || 'No results.') + (errors.length ? `\n(some sources failed: ${errors.join('; ')})` : '');
    },
  },
  {
    ...base('add_citation', 'Add reference'),
    description:
      'Add one search_citations result to the project bibliography (.bib; created if missing). Returns the BibTeX key to use in \\cite{...}. Reuses the existing key if the paper is already in the bibliography.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The same query passed to search_citations' }, index: { type: 'integer', minimum: 0 } },
      required: ['query', 'index'],
      additionalProperties: false,
    },
    scope: 'project',
    summarize: (i) => String(i.query ?? ''),
    async run(i, ctx) {
      const q = String(i.query ?? '');
      const results = (ctx.cache.get(`cite:${q}`) as CitationSearchResult[] | undefined) ?? (await searchOnline(q)).results;
      const r = results[Number(i.index)];
      if (!r) throw new ToolError('Invalid index; call search_citations first.');
      const res = await addCitation(ctx.projectId!, r);
      ctx.touch(res.bibPath);
      return (
        `${res.added ? 'Added' : 'Already present:'} \\cite{${res.key}} (${res.bibPath}).` +
        (res.needsBibliography ? ' Note: the project has no \\bibliography / \\printbibliography yet; add one before \\end{document}.' : '')
      );
    },
  },
];

// ---------------- 项目管理与论文检查（实现在 mcp/moreTools、mcp/paperTools） ----------------

const moreDefs: ToolDef[] = MORE_TOOL_SPECS.map((s) => ({
  ...base(s.name, MORE_TITLES[s.name] ?? s.name),
  description: s.description,
  inputSchema: withoutProject(s.inputSchema),
  scope: NO_PROJECT_TOOLS.has(s.name) ? 'global' : 'project',
  meta: s.name === 'upload_file' ? { 'openai/fileParams': ['file'] } : undefined,
  summarize: genericSummary,
  run: (input, ctx) => runMoreTool(s.name, input, { userId: ctx.userId, scoped: ctx.scoped, projectId: ctx.projectId, touch: ctx.touch }) as Promise<ToolResult>,
}));

const paperDefs: ToolDef[] = PAPER_TOOL_SPECS.map((s) => ({
  ...base(s.name, PAPER_TITLES[s.name] ?? s.name),
  description: s.description,
  inputSchema: withoutProject(s.inputSchema),
  scope: 'project',
  summarize: genericSummary,
  run: (input, ctx) => runPaperTool(s.name, input, { projectId: ctx.projectId!, userId: ctx.userId, touch: ctx.touch }) as Promise<ToolResult>,
}));

export const TOOLS: ToolDef[] = [...projectDefs.slice(0, 1), ...paperDefs, ...moreDefs, ...coreDefs, ...projectDefs.slice(1)];
const byName = new Map(TOOLS.map((t) => [t.name, t]));

export const getTool = (name: string) => byName.get(name);
export const agentTools = () => TOOLS.filter((t) => t.agent);
export const mcpTools = () => TOOLS.filter((t) => t.mcp);

export function summarizeToolInput(name: string, input: unknown): string {
  const t = byName.get(name);
  if (!t || !input || typeof input !== 'object') return '';
  try {
    return (t.summarize ?? genericSummary)(input as Record<string, unknown>);
  } catch {
    return '';
  }
}

/** 轻量的参数校验（没有 zod schema 的工具）：必填项与基本类型 */
function checkArgs(def: ToolDef, input: Record<string, unknown>): string | null {
  const schema = def.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
  for (const k of schema.required ?? []) if (input[k] === undefined || input[k] === null) return `Missing required argument "${k}"`;
  for (const [k, v] of Object.entries(input)) {
    const type = schema.properties?.[k]?.type;
    if (!type || v === undefined || v === null) continue;
    const ok =
      type === 'string' ? typeof v === 'string'
      : type === 'integer' ? Number.isInteger(v)
      : type === 'number' ? typeof v === 'number'
      : type === 'boolean' ? typeof v === 'boolean'
      : type === 'array' ? Array.isArray(v)
      : type === 'object' ? typeof v === 'object' && !Array.isArray(v)
      : true;
    if (!ok) return `Argument "${k}" must be of type ${type}`;
  }
  return null;
}

/** 校验并执行一个工具调用；永不抛出，错误以 isError 结果返回（可直接交给模型） */
export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  const def = byName.get(name);
  if (!def) return textResult(`Unknown tool: ${name}`, true);
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  if (def.schema) {
    // 流式工具参数下服务端不校验，宽松解析可能得到被截断的对象
    const parsed = def.schema.safeParse(input);
    if (!parsed.success) {
      return textResult(JSON.stringify({ INVALID_ARGUMENTS: JSON.stringify(input).slice(0, 2000), issues: parsed.error.issues.slice(0, 5) }), true);
    }
  } else {
    const problem = checkArgs(def, input);
    if (problem) return textResult(problem, true);
  }
  if (def.scope === 'project' && !ctx.projectId) return textResult('No project selected.', true);
  try {
    const out = await def.run(input, ctx);
    return typeof out === 'string' ? textResult(out) : out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!(err instanceof ToolError) && !(err as { statusCode?: number }).statusCode) console.error(`[tools] ${name} failed`, err);
    return textResult(msg, true);
  }
}

export { formatCompileResult, ToolError };
