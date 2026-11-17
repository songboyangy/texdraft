import type {
  AddCitationResult, AdminAiPolicy, BridgeInfo, ApiTokenSummary, ChatBackend, LocalAgentStatus, AgentContext, AgentEvent, ChatItem, CitationSearchResult, CompileResult, FileEntry, ProjectDetail,
  ProjectSummary, ProjectSymbols, ProjectTag, SearchMatch, SearchQuery, SynctexForward, SynctexReverse, ThreadSummary, TransformAction,
  TransformEvent, User, VersionDiff, VersionSummary, AuthConfig, AdminUser, InviteSummary, RegistrationMode, AiSettingsView, AiSettingsInput,
} from '@texdraft/shared';
import { getLocale } from './i18n';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const zh = getLocale() !== 'en';
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    // 服务端按 Accept-Language 选择错误信息的语言：用界面语言，而不是浏览器语言
    headers: {
      'Accept-Language': zh ? 'zh-CN' : 'en',
      ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: { error?: string } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（如代理返回的 HTML 错误页） */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? (zh ? `请求失败（${res.status}）` : `Request failed (${res.status})`));
  if (data === null && text) throw new ApiError(res.status, zh ? '服务器返回了无法识别的内容' : 'Unexpected response from the server');
  return data as T;
}

const p = (id: string) => `/api/projects/${id}`;

export const api = {
  me: () => request<User>('GET', '/api/auth/me'),
  login: (email: string, password: string) => request<User>('POST', '/api/auth/login', { email, password }),
  register: (email: string, name: string, password: string, invite?: string, turnstileToken?: string) =>
    request<User>('POST', '/api/auth/register', { email, name, password, ...(invite ? { invite } : {}), ...(turnstileToken ? { turnstileToken } : {}) }),
  authConfig: () => request<AuthConfig>('GET', '/api/auth/config'),
  changePassword: (current: string, next: string) => request<{ ok: true }>('POST', '/api/auth/password', { current, next }),
  ai: {
    settings: () => request<AiSettingsView>('GET', '/api/ai/settings'),
    save: (s: AiSettingsInput) => request<AiSettingsView>('PUT', '/api/ai/settings', s),
    remove: () => request<AiSettingsView>('DELETE', '/api/ai/settings'),
    test: (s: AiSettingsInput) => request<{ ok: boolean; latencyMs: number; reply?: string; error?: string }>('POST', '/api/ai/test', s),
  },
  admin: {
    users: () => request<{ users: AdminUser[]; ai: AdminAiPolicy }>('GET', '/api/admin/users'),
    updateUser: (id: string, patch: { isAdmin?: boolean; disabled?: boolean; aiCredit?: number | null }) => request<{ ok: true }>('PATCH', `/api/admin/users/${id}`, patch),
    resetPassword: (id: string) => request<{ password: string }>('POST', `/api/admin/users/${id}/reset-password`),
    settings: () => request<{ registration: RegistrationMode }>('GET', '/api/admin/settings'),
    updateSettings: (s: { registration: RegistrationMode }) => request<{ registration: RegistrationMode }>('PATCH', '/api/admin/settings', s),
    invites: () => request<InviteSummary[]>('GET', '/api/admin/invites'),
    createInvite: (o: { note?: string; maxUses?: number; expiresInDays?: number | null }) => request<{ code: string; invite: InviteSummary }>('POST', '/api/admin/invites', o),
    revokeInvite: (id: string) => request<{ ok: true }>('DELETE', `/api/admin/invites/${id}`),
  },
  logout: () => request('POST', '/api/auth/logout'),

  projects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  createProject: (name: string) => request<ProjectSummary>('POST', '/api/projects', { name }),
  /** 项目标签（每个用户自己的分类） */
  tags: () => request<ProjectTag[]>('GET', '/api/tags'),
  createTag: (name: string) => request<ProjectTag>('POST', '/api/tags', { name }),
  renameTag: (tagId: string, name: string) => request('PATCH', `/api/tags/${tagId}`, { name }),
  deleteTag: (tagId: string) => request('DELETE', `/api/tags/${tagId}`),
  tagProject: (tagId: string, projectId: string, on: boolean) => request(on ? 'PUT' : 'DELETE', `/api/tags/${tagId}/projects/${projectId}`),
  project: (id: string) => request<ProjectDetail>('GET', p(id)),
  updateProject: (id: string, patch: Partial<Pick<ProjectDetail, 'name' | 'mainFile' | 'engine'>>) =>
    request<ProjectDetail>('PATCH', p(id), patch),
  deleteProject: (id: string) => request('DELETE', p(id)),
  openSample: () => request<ProjectSummary>('POST', '/api/projects/sample', {}),
  importZip: (file: File, name?: string) => {
    const fd = new FormData();
    if (name) fd.append('name', name);
    fd.append('file', file, file.name);
    return request<{ id: string; name: string; fileCount: number; mainFile: string }>('POST', '/api/projects/import', fd);
  },
  downloadUrl: (id: string) => `${p(id)}/download`,
  symbols: (id: string) => request<ProjectSymbols>('GET', `${p(id)}/symbols`),
  synctexToPdf: (id: string, jobId: string, file: string, line: number) =>
    request<SynctexForward>('GET', `${p(id)}/compile/${jobId}/synctex/pdf?file=${encodeURIComponent(file)}&line=${line}`),
  synctexToSource: (id: string, jobId: string, page: number, x: number, y: number) =>
    request<SynctexReverse>('GET', `${p(id)}/compile/${jobId}/synctex/source?page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`),
  texts: (id: string) => request<{ path: string; content: string }[]>('GET', `${p(id)}/texts`),
  search: (id: string, q: SearchQuery) => request<{ results: SearchMatch[]; truncated: boolean }>('POST', `${p(id)}/search`, q),
  replaceAll: (id: string, q: SearchQuery & { replacement: string; paths?: string[] }) =>
    request<{ replaced: number; files: number }>('POST', `${p(id)}/replace`, q),
  citationSearch: (id: string, q: string) =>
    request<{ results: CitationSearchResult[]; errors: string[] }>('GET', `${p(id)}/citations/search?q=${encodeURIComponent(q)}`),
  addCitation: (id: string, r: CitationSearchResult) => request<AddCitationResult>('POST', `${p(id)}/citations`, r),
  addBibliography: (id: string) => request<{ mainFile: string; bib: string }>('POST', `${p(id)}/citations/bibliography`, {}),

  versions: (id: string) => request<VersionSummary[]>('GET', `${p(id)}/versions`),
  createVersion: (id: string, label?: string) => request<{ id: string }>('POST', `${p(id)}/versions`, { label }),
  versionDiff: (id: string, vid: string) => request<VersionDiff>('GET', `${p(id)}/versions/${vid}/diff`),
  restoreVersion: (id: string, vid: string, paths?: string[], label?: string) =>
    request<{ changed: number; safetyVersionId: string }>('POST', `${p(id)}/versions/${vid}/restore`, { paths, label }),
  tokens: () => request<ApiTokenSummary[]>('GET', '/api/tokens'),
  createToken: (name: string, projectId: string | null) =>
    request<{ token: string; summary: ApiTokenSummary }>('POST', '/api/tokens', { name, projectId }),
  revokeToken: (tokenId: string) => request('DELETE', `/api/tokens/${tokenId}`),
  localAgents: () => request<{ enabled: boolean; url: string; agents: LocalAgentStatus[] }>('GET', '/api/agent-setup/local'),
  setupLocalAgents: () => request<{ url: string; agents: LocalAgentStatus[] }>('POST', '/api/agent-setup/local', {}),
  mcpInfo: () => request<{ url: string }>('GET', '/api/mcp/info'),
  addMember: (id: string, email: string, role: 'editor' | 'viewer') => request('POST', `${p(id)}/members`, { email, role }),
  members: (id: string) => request<{ userId: string; email: string; name: string; role: 'owner' | 'editor' | 'viewer' }[]>('GET', `${p(id)}/members`),
  removeMember: (id: string, userId: string) => request('DELETE', `${p(id)}/members/${userId}`),
  editLog: (id: string, fileId?: string) => request<EditLogEntry[]>('GET', `${p(id)}/edit-log${fileId ? `?fileId=${fileId}` : ''}`),

  files: (id: string) => request<FileEntry[]>('GET', `${p(id)}/files`),
  createFile: (id: string, path: string, content = '') => request<FileEntry>('POST', `${p(id)}/files`, { path, content }),
  upload: (id: string, files: FileList | File[], dir = '') => {
    const fd = new FormData();
    if (dir) fd.append('dir', dir);
    for (const f of Array.from(files)) fd.append('file', f, f.name);
    return request<FileEntry[]>('POST', `${p(id)}/upload`, fd);
  },
  renameFile: (id: string, fileId: string, path: string) => request('PATCH', `${p(id)}/files/${fileId}`, { path }),
  deleteFile: (id: string, fileId: string) => request('DELETE', `${p(id)}/files/${fileId}`),
  rawFileUrl: (id: string, fileId: string) => `${p(id)}/files/${fileId}/raw`,
  /** 显式创建的文件夹（可为空）；文件路径中隐含的目录不在其中 */
  folders: (id: string) => request<string[]>('GET', `${p(id)}/folders`),
  createFolder: (id: string, path: string) => request<{ path: string; created: boolean }>('POST', `${p(id)}/folders`, { path }),
  renameFolder: (id: string, from: string, to: string) => request<{ ok: true; moved: number }>('PATCH', `${p(id)}/folders`, { from, to }),
  deleteFolder: (id: string, path: string) =>
    request<{ ok: true; deleted: number }>('DELETE', `${p(id)}/folders?path=${encodeURIComponent(path)}`),

  compile: (id: string) => request<CompileResult>('POST', `${p(id)}/compile`, {}),
  latestCompile: (id: string) => request<CompileResult | null>('GET', `${p(id)}/compile/latest`),

  agentBackends: () => request<{ backends: ChatBackend[]; bridges: BridgeInfo[] }>('GET', '/api/agent/backends'),
  bridges: () => request<{ bridges: BridgeInfo[] }>('GET', '/api/agent/bridges'),
  threads: (id: string) => request<ThreadSummary[]>('GET', `${p(id)}/agent/threads`),
  thread: (id: string, threadId: string) =>
    request<{ items: ChatItem[]; runningRunId: string | null }>('GET', `${p(id)}/agent/threads/${threadId}`),
  stopRun: (id: string, runId: string) => request('POST', `${p(id)}/agent/runs/${runId}/stop`),
  revertRun: (id: string, runId: string) => request('POST', `${p(id)}/agent/runs/${runId}/revert`),
};

/** 发送聊天消息，逐个回调 SSE 事件，直到流结束 */
export async function streamChat(
  projectId: string,
  body: { threadId?: string; message: string; context: AgentContext; lang?: 'zh-CN' | 'en'; backend?: ChatBackend },
  onEvent: (e: AgentEvent) => void,
): Promise<void> {
  const res = await fetch(`${p(projectId)}/agent/chat`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? `请求失败（${res.status}）`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (data) onEvent(JSON.parse(data) as AgentEvent);
    }
  }
}

/** 选中文字 AI：流式返回改写结果 */
export async function streamTransform(
  projectId: string,
  body: { action: TransformAction; text: string; instruction?: string; before?: string; after?: string; lang: 'zh-CN' | 'en' },
  onEvent: (e: TransformEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${p(projectId)}/ai/transform`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? `请求失败（${res.status}）`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, idx).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(idx + 2);
      if (line) onEvent(JSON.parse(line.slice(6)) as TransformEvent);
    }
  }
}

/** 编辑记录（元数据） */
export interface EditLogEntry {
  id: number;
  fileId: string;
  path: string | null;
  userId: string | null;
  userName: string | null;
  source: 'editor' | 'server';
  origin: string | null;
  insertedChars: number;
  deletedChars: number;
  insertedLines: number;
  deletedLines: number;
  fromLine: number | null;
  toLine: number | null;
  startedAt: string;
  endedAt: string;
}
