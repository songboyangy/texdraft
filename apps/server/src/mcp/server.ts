import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { getRole, listProjects } from '../projects/service.js';
import { createVersion } from '../projects/versions.js';
import { executeTool, getTool, mcpTools } from '../tools/registry.js';
import { textResult, type ToolDef } from '../tools/types.js';
import { getRunBinding } from './runBinding.js';
import type { TokenAuth } from './tokens.js';

/**
 * TeXdraft MCP 服务：让本地 Agent（Claude Code / Codex / Gemini CLI …）、ChatGPT、Claude.ai 通过工具操作云端项目。
 * 工具定义来自统一注册表（tools/registry.ts）；本文件只负责项目解析、权限、检查点与 MCP 元数据。
 * 编辑走 Yjs（在线编辑者实时可见）；外部 Agent 首次修改项目前自动打检查点，可在“历史版本”中恢复。
 */

export const INSTRUCTIONS = `TeXdraft is a collaborative online LaTeX editor. These tools operate on a TeXdraft project stored on the server (not on your local disk).
- Call list_projects first if you do not know the project; pass "project" (id or exact name) to every other tool unless the token is bound to a single project.
- Read before editing (read_file / grep). Edit with str_replace using text copied exactly from read_file output (without line-number prefixes); use write_file only for new files or full rewrites.
- Edits are applied live to the shared documents, so collaborators see them immediately. A checkpoint is created before your first edit and can be restored from the project's History.
- After non-trivial edits run compile and fix the errors you introduced. The PDF updates for the user automatically.
- For references use search_citations + add_citation (adds BibTeX to the project .bib and returns the key to \\cite). Never invent references.
- Folders: create_folder (may stay empty), move_folder (rename/move with contents), delete_folder. Files in a/b.tex create folder a implicitly.
- Project management (tag_project adds your own tags; list_projects shows them and filters by tag): create_project / copy_project, get_project / update_project (name, main file, engine), copy_file, upload_file (chat attachments, https URLs or base64), replace_in_project, get_outline.
- Reviewing the paper: get_pdf_pages (rendered pages + text) after compiling, get_compile_diagnostics (errors with source lines and hints), get_project_dependencies, get_citation_context, get_file_diff (changes since a version).
- For coordinated edits across several places/files prefer apply_patch (all-or-nothing; dry_run to preview).
- History: save_version before risky changes; list_versions / restore_version to roll back (restoring saves the current state first).
- Do not use local shell/file tools to modify the paper: the source of truth is the TeXdraft project.`;

const PROJECT_PROP = {
  project: { type: 'string', description: 'Project id or exact project name. Optional when the access token is bound to one project.' },
};

/** 写操作检查点：同一令牌在同一项目内 30 分钟内的连续修改共用一个检查点 */
const CHECKPOINT_IDLE_MS = 30 * 60 * 1000;
const lastWrite = new Map<string, number>();

class McpToolError extends Error {}

async function resolveProject(auth: TokenAuth, ref: unknown): Promise<string> {
  if (auth.projectId) {
    if (ref && ref !== auth.projectId) {
      const [p] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, auth.projectId));
      if (ref !== p?.name) throw new McpToolError(`This access token is bound to project "${p?.name ?? auth.projectId}".`);
    }
    return auth.projectId;
  }
  if (typeof ref !== 'string' || !ref.trim()) throw new McpToolError('Missing "project". Call list_projects to find the project id.');
  const projects = await listProjects(auth.userId);
  const hit = projects.find((p) => p.id === ref) ?? projects.filter((p) => p.name === ref);
  if (Array.isArray(hit)) {
    if (hit.length === 1) return hit[0].id;
    if (hit.length > 1) throw new McpToolError(`Several projects are named "${ref}"; pass the project id instead.`);
    throw new McpToolError(`Project not found: ${ref}. Call list_projects.`);
  }
  return hit.id;
}

/** MCP tools/list 的条目：项目工具加 project 参数；注解与 _meta 来自工具定义 */
function listing(t: ToolDef) {
  const schema = t.inputSchema as { properties?: Record<string, unknown> };
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.scope === 'project' ? { ...t.inputSchema, properties: { ...PROJECT_PROP, ...(schema.properties ?? {}) }, additionalProperties: false } : t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: t.readOnly,
      destructiveHint: !!t.destructive,
      idempotentHint: !!t.idempotent,
      openWorldHint: !!t.openWorld,
    },
    _meta: {
      // 所有工具都需要 OAuth（或个人访问令牌）
      securitySchemes: [{ type: 'oauth2', scopes: ['projects'] }],
      ...(t.meta ?? {}),
    },
  };
}

export function buildMcpServer(auth: TokenAuth) {
  const server = new Server({ name: 'texdraft', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  /** 会话内缓存（search_citations → add_citation） */
  const cache = new Map<string, unknown>();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools().map(listing) }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const { project: projectRef, ...args } = (req.params.arguments ?? {}) as Record<string, unknown>;
    const def = getTool(name);
    if (!def || !def.mcp) return textResult(`Unknown tool: ${name}`, true) as CallToolResult;
    try {
      // 聊天栏里的本机 CLI 运行：改动计入该次运行（汇总 diff、撤销），不另打检查点
      const binding = getRunBinding(auth.tokenId);
      let projectId: string | null = auth.projectId;
      if (def.scope === 'project') {
        projectId = await resolveProject(auth, projectRef);
        const role = await getRole(projectId, auth.userId);
        if (!role) throw new McpToolError('Project not found or access revoked.');
        if (def.access !== 'read' && role === 'viewer') throw new McpToolError('You only have read access to this project.');
        if (def.access === 'files' && !binding) {
          const key = `${auth.tokenId}:${projectId}`;
          if (Date.now() - (lastWrite.get(key) ?? 0) > CHECKPOINT_IDLE_MS) {
            await createVersion(projectId, auth.userId, 'checkpoint', `MCP: ${auth.tokenName}`);
          }
          lastWrite.set(key, Date.now());
        }
      }
      return (await executeTool(name, args, {
        userId: auth.userId,
        projectId,
        scoped: !!auth.projectId,
        runId: binding?.runId ?? `mcp:${auth.tokenId}`,
        touch: (p) => binding?.tracker.touch(p),
        emit: (e) => binding?.emit(e),
        cache,
      })) as CallToolResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!(err instanceof McpToolError)) console.error(`[mcp] tool ${name} failed`, err);
      return textResult(msg, true) as CallToolResult;
    }
  });

  return server;
}
