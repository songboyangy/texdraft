import type { AgentContext, AgentEvent, AiSettingsView, ChatBackend, ChatItem, CompileResult, FileChangeSummary, ThreadSummary } from '@texdraft/shared';
import { ArrowUp, BookmarkPlus, BookOpenText, Bot, Bug, KeyRound, Laptop, PanelRightClose, PenLine, Check, ChevronDown, ChevronRight, Copy, Eye, FileDiff, FilePen, FilePlus2, FileSearch, FolderPlus, FolderTree, History, Info, ListTree, Loader2, Lock, MessageSquarePlus, Move, Network, Play, Quote, Replace, RotateCcw, ScanText, Search, Settings2, Sparkles, Square, Stethoscope, Terminal, Trash2, Upload, Wand2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, streamChat } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { formatRelative, useI18n } from '../lib/i18n';
import { AiSettingsCard } from './AiSettingsCard';
import { Dropdown, IconButton } from './ui';

interface Props {
  projectId: string;
  getContext: () => AgentContext;
  onOpenFile: (path: string, line?: number) => void;
  /** 最近一次编译结果（决定快捷操作是「修复编译错误」还是「解释当前文档」） */
  compile: CompileResult | null;
  /** 收起 AI 栏 */
  onCollapse?: () => void;
}

const BACKEND_KEY = 'tp.chatBackend';
const BACKEND_LABEL: Record<ChatBackend, string> = { builtin: 'TeXdraft AI', claude: 'Claude Code', codex: 'Codex', 'bridge-claude': 'Claude Code', 'bridge-codex': 'Codex' };
const BACKEND_ICON: Record<ChatBackend, LucideIcon> = { builtin: Sparkles, claude: Terminal, codex: Terminal, 'bridge-claude': Laptop, 'bridge-codex': Laptop };
const isBridge = (b: ChatBackend) => b.startsWith('bridge-');

const TOOL_ICON: Record<string, LucideIcon> = {
  list_files: FolderTree,
  read_file: FileSearch,
  grep: Search,
  str_replace: FilePen,
  write_file: FilePlus2,
  delete_file: Trash2,
  move_file: Move,
  create_folder: FolderPlus,
  move_folder: Move,
  delete_folder: Trash2,
  compile: Play,
  search_citations: Search,
  add_citation: FilePlus2,
  get_compile_result: Play,
  list_projects: FolderTree,
  get_pdf_pages: Eye,
  get_compile_diagnostics: Stethoscope,
  apply_patch: FileDiff,
  replace_in_project: Replace,
  copy_file: Copy,
  upload_file: Upload,
  get_outline: ListTree,
  get_project_dependencies: Network,
  get_citation_context: Quote,
  get_file_diff: FileDiff,
  list_versions: History,
  save_version: BookmarkPlus,
  get_project: Info,
  update_project: Settings2,
};

export function ChatPanel({ projectId, getContext, onOpenFile, compile, onCollapse }: Props) {
  const { t, locale } = useI18n();
  const dialog = useDialog();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [backends, setBackends] = useState<ChatBackend[]>(['builtin']);
  const [backend, setBackendState] = useState<ChatBackend>(() => (localStorage.getItem(BACKEND_KEY) as ChatBackend) || 'builtin');
  const setBackend = (b: ChatBackend) => {
    setBackendState(b);
    localStorage.setItem(BACKEND_KEY, b);
  };
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  /** 本页面发起的运行（由 SSE 驱动，不需要轮询） */
  const localRun = useRef<string | null>(null);

  // 快捷操作随当前状态变化：有编译错误时优先修复，否则解释文档；润色需要先选中文字
  const hasErrors = !!compile?.diagnostics.some((d) => d.level === 'error');
  const [hint, setHint] = useState('');
  const quickActions: { icon: LucideIcon; label: string; text: string; needsSelection?: boolean }[] = [
    hasErrors
      ? { icon: Bug, label: t('chat.qa.fix'), text: t('chat.qa.fixPrompt') }
      : { icon: BookOpenText, label: t('chat.qa.explain'), text: t('chat.qa.explainPrompt') },
    { icon: PenLine, label: t('chat.qa.rewrite'), text: t('chat.qa.rewritePrompt') },
    { icon: Wand2, label: t('chat.qa.polish'), text: t('chat.qa.polishPrompt'), needsSelection: true },
    { icon: ScanText, label: t('chat.qa.review'), text: t('chat.qa.reviewPrompt') },
  ];
  const runQuick = (q: (typeof quickActions)[number]) => {
    if (q.needsSelection && !getContext().selection?.trim()) {
      setHint(t('chat.qa.selectFirst'));
      return;
    }
    setHint('');
    send(q.text);
  };

  // AI 额度：输入框旁显示当前模型与剩余免费额度，避免用到一半才发现限制
  const [ai, setAi] = useState<AiSettingsView | null>(null);
  const loadAi = useCallback(() => api.ai.settings().then(setAi, () => {}), []);
  // 「配置自己的 Key」：在当前页面弹出设置，关闭后刷新额度
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const closeAiSettings = () => {
    setAiSettingsOpen(false);
    loadAi();
  };
  useEffect(() => {
    loadAi();
    // 从「账号设置」（新标签页）配置完 Key 回来时刷新
    window.addEventListener('focus', loadAi);
    return () => window.removeEventListener('focus', loadAi);
  }, [loadAi]);

  const loadThreads = useCallback(() => api.threads(projectId).then(setThreads).catch(() => {}), [projectId]);
  useEffect(() => {
    loadThreads();
  }, [loadThreads]);
  // 可用后端：电脑上的桥接随时可能连上或断开，回到页面时与每 15 秒刷新一次
  const [bridges, setBridges] = useState<{ hostname: string; agents: { id: string }[] }[]>([]);
  useEffect(() => {
    const load = () =>
      api.agentBackends().then((r) => {
        setBackends(r.backends);
        setBridges(r.bridges ?? []);
        setBackendState((b) => (r.backends.includes(b) ? b : 'builtin'));
      }, () => {});
    load();
    const h = setInterval(load, 15_000);
    window.addEventListener('focus', load);
    return () => {
      clearInterval(h);
      window.removeEventListener('focus', load);
    };
  }, []);
  const backendMeta = (b: ChatBackend) => {
    if (b === 'builtin') return t('chat.backendBuiltin');
    if (!isBridge(b)) return t('chat.backendLocal');
    const host = bridges.find((x) => x.agents.some((a) => `bridge-${a.id}` === b))?.hostname;
    return host ? t('chat.backendBridgeHost', { host }) : t('chat.backendBridge');
  };
  /** 已有对话的后端固定为创建时的后端 */
  const threadBackend = threads.find((th) => th.id === threadId)?.backend;
  const activeBackend: ChatBackend = threadId && threadBackend ? threadBackend : backend;

  const openThread = useCallback(
    async (id: string | undefined) => {
      setThreadId(id);
      setError('');
      if (!id) {
        setItems([]);
        setRunning(false);
        return;
      }
      const th = await api.thread(projectId, id);
      setItems(th.items);
      setRunId(th.runningRunId);
      setRunning(!!th.runningRunId);
    },
    [projectId],
  );

  // 从历史中打开的、仍在后台运行的对话：轮询直到结束
  useEffect(() => {
    if (!running || !threadId || !runId || localRun.current === runId) return;
    const h = setInterval(async () => {
      const r = await api.thread(projectId, threadId).catch(() => null);
      if (!r) return;
      setItems(r.items);
      if (!r.runningRunId) {
        setRunning(false);
        setRunId(null);
      }
    }, 2000);
    return () => clearInterval(h);
  }, [running, threadId, runId, projectId]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, running]);

  // 输入框高度自适应
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  const applyEvent = (e: AgentEvent) => {
    setItems((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      switch (e.type) {
        case 'text_delta':
          if (last?.kind === 'assistant') next[next.length - 1] = { ...last, text: last.text + e.text };
          else next.push({ kind: 'assistant', text: e.text });
          break;
        case 'progress':
          if (last?.kind === 'progress') next[next.length - 1] = { ...last, text: last.text + e.text };
          else next.push({ kind: 'progress', text: e.text });
          break;
        case 'tool_start':
          next.push({ kind: 'tool', id: e.id, name: e.name, summary: '' });
          break;
        case 'tool_input':
        case 'tool_end': {
          const i = next.findIndex((x) => x.kind === 'tool' && x.id === e.id);
          if (i >= 0) {
            const tool = next[i] as Extract<ChatItem, { kind: 'tool' }>;
            next[i] = e.type === 'tool_input' ? { ...tool, summary: e.summary } : { ...tool, ok: e.ok, result: e.summary };
          }
          break;
        }
        case 'run_finished':
          if (e.runId) next.push({ kind: 'run_summary', runId: e.runId, status: e.status, changes: e.changes, reverted: false });
          if (e.error) next.push({ kind: 'assistant', text: `⚠️ ${e.error}` });
          break;
      }
      return next;
    });
    if (e.type === 'run_started') {
      setRunId(e.runId);
      localRun.current = e.runId;
      if (!threadId) {
        setThreadId(e.threadId);
        loadThreads();
      }
    }
    if (e.type === 'run_finished') {
      setRunning(false);
      setRunId(null);
      loadThreads();
    }
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || running) return;
    setInput('');
    setError('');
    setRunning(true);
    stick.current = true;
    setItems((prev) => [...prev, { kind: 'user', text: message }]);
    try {
      await streamChat(projectId, { threadId, message, context: getContext(), lang: locale, backend: activeBackend }, applyEvent);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
      loadAi();
    }
  };

  // 新手引导的「帮我试一下」：从外部发一条指令
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onSend = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (typeof text === 'string') sendRef.current(text);
    };
    window.addEventListener('texdraft:chat-send', onSend);
    return () => window.removeEventListener('texdraft:chat-send', onSend);
  }, []);

  const stop = async () => {
    if (runId) await api.stopRun(projectId, runId).catch(() => {});
  };

  const revert = async (rid: string) => {
    const ok = await dialog.confirm(t('chat.revertConfirm'), { message: t('chat.revertWarning'), danger: true, confirmText: t('chat.revert') });
    if (!ok) return;
    try {
      await api.revertRun(projectId, rid);
      setItems((prev) => prev.map((x) => (x.kind === 'run_summary' && x.runId === rid ? { ...x, reverted: true } : x)));
    } catch (err) {
      dialog.alert(t('chat.revertFailed'), (err as Error).message);
    }
  };

  const currentTitle = threads.find((th) => th.id === threadId)?.title ?? t('chat.newChat');

  return (
    <div className="chat-panel">
      <div className="panel-head">
        <span className="panel-title with-icon ai">
          <Sparkles size={14} /> {t('chat.title')}
        </span>
        {/* 本地 Agent 的入口放在显眼处：未连接时引导连接，已连接时一键切换过去 */}
        {(() => {
          const local = backends.filter(isBridge);
          if (!local.length) {
            return (
              <button className="local-chip" onClick={() => window.dispatchEvent(new Event('texdraft:open-agents'))}>
                <Laptop size={12} /> {t('chat.connectComputer')}
              </button>
            );
          }
          const names = local.map((b) => BACKEND_LABEL[b]);
          const target = local.includes(activeBackend) ? activeBackend : local[0];
          return (
            <button
              className={`local-chip on ${isBridge(activeBackend) ? 'active' : ''}`}
              title={t('chat.useLocal', { agents: names.join(' / ') })}
              disabled={running}
              onClick={() => {
                if (threadId && !isBridge(activeBackend)) openThread(undefined);
                setBackend(target);
              }}
            >
              <span className="dot" /> {t('chat.localConnected', { agent: BACKEND_LABEL[target] })}
            </button>
          );
        })()}
        <span className="spacer" />
        <Dropdown
          align="right"
          className="thread-dropdown"
          trigger={(_o, toggle) => (
            <button className="thread-btn" onClick={toggle} disabled={running} title={t('chat.history')}>
              <History size={14} />
              <span className="thread-btn-title">{currentTitle}</span>
              <ChevronDown size={13} />
            </button>
          )}
        >
          {(close) => (
            <div className="thread-menu">
              <button className="menu-item" onClick={() => (close(), openThread(undefined))}>
                <span className="menu-icon">
                  <MessageSquarePlus size={15} />
                </span>
                <span className="menu-label">{t('chat.newChat')}</span>
              </button>
              {threads.length > 0 && <div className="menu-divider" />}
              {threads.map((th) => (
                <button key={th.id} className={`menu-item ${th.id === threadId ? 'current' : ''}`} onClick={() => (close(), openThread(th.id))}>
                  <span className="menu-icon">{th.id === threadId ? <Check size={15} /> : null}</span>
                  <span className="menu-label">{th.title}</span>
                  {th.backend !== 'builtin' && (
                    <span className="backend-tag">
                      {BACKEND_LABEL[th.backend]}
                      {isBridge(th.backend) ? ` · ${t('chat.myComputer')}` : ''}
                    </span>
                  )}
                  <span className="menu-meta">{formatRelative(th.updatedAt, locale)}</span>
                </button>
              ))}
            </div>
          )}
        </Dropdown>
        <IconButton icon={MessageSquarePlus} label={t('chat.newChat')} size={15} disabled={running} onClick={() => openThread(undefined)} />
        {onCollapse && <IconButton icon={PanelRightClose} label={t('layout.collapse')} size={15} className="pane-collapse" onClick={onCollapse} />}
      </div>

      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <Sparkles size={22} />
            </div>
            <h3>{t('chat.emptyTitle')}</h3>
            <p>
              {activeBackend === 'builtin'
                ? t('chat.emptyDesc')
                : isBridge(activeBackend)
                  ? t('chat.bridgeDesc', { agent: BACKEND_LABEL[activeBackend] })
                  : t('chat.cliDesc', { agent: BACKEND_LABEL[activeBackend] })}
            </p>
            <div className="chat-suggestions">
              {quickActions.map((q) => (
                <button key={q.label} className="suggestion" onClick={() => runQuick(q)}>
                  <q.icon size={15} />
                  <span>{q.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((it, i) => (
          <ChatItemView key={i} item={it} onOpenFile={onOpenFile} onRevert={revert} />
        ))}
        {running && (
          <div className="typing">
            <Loader2 size={14} className="spin" /> {t('chat.working')}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>

      <div className="chat-composer">
        {items.length > 0 && (
          <div className="quick-actions">
            {quickActions.map((q) => (
              <button key={q.label} className="chip" disabled={running} onClick={() => runQuick(q)}>
                <q.icon size={13} /> {q.label}
              </button>
            ))}
          </div>
        )}
        {hint && (
          <div className="chat-hint">
            <Info size={13} /> {hint}
            <button className="link" onClick={() => setHint('')}>
              <X size={12} />
            </button>
          </div>
        )}
        <div className={`composer-box ${running ? 'busy' : ''}`}>
          <textarea
            ref={textarea}
            value={input}
            placeholder={t('chat.placeholder')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={2}
          />
          <div className="composer-bar">
            {!threadId || backends.length > 1 || activeBackend !== 'builtin' ? (
              <Dropdown
                className="backend-dropdown"
                trigger={(_o, toggle) => {
                  const Icon = BACKEND_ICON[activeBackend];
                  const locked = !!threadId;
                  return (
                    <button
                      className={`backend-btn ${activeBackend !== 'builtin' ? 'cli' : ''}`}
                      onClick={locked ? undefined : toggle}
                      disabled={running}
                      title={locked ? t('chat.backendLocked') : t('chat.backendPick')}
                    >
                      <Icon size={13} /> {BACKEND_LABEL[activeBackend]}
                      {isBridge(activeBackend) && <span className="backend-where">{t('chat.myComputer')}</span>}
                      {locked ? <Lock size={11} /> : <ChevronDown size={12} />}
                    </button>
                  );
                }}
              >
                {(close) => (
                  <>
                    {backends.map((b) => {
                      const Icon = BACKEND_ICON[b];
                      return (
                        <button key={b} className={`menu-item ${b === backend ? 'current' : ''}`} onClick={() => (close(), setBackend(b))}>
                          <span className="menu-icon">
                            <Icon size={15} />
                          </span>
                          {/* 两行：第一行工具名与状态（优先完整显示），第二行设备名等（过长省略） */}
                          <span className="menu-label backend-item">
                            <span className="backend-line1">
                              {BACKEND_LABEL[b]}
                              {isBridge(b) && <span className="backend-online"> · {t('chat.online')}</span>}
                            </span>
                            <span className="backend-line2">{backendMeta(b)}</span>
                          </span>
                        </button>
                      );
                    })}
                    <div className="menu-divider" />
                    <button className="menu-item" onClick={() => (close(), window.dispatchEvent(new Event('texdraft:open-agents')))}>
                      <span className="menu-icon">
                        <Laptop size={15} />
                      </span>
                      <span className="menu-label">{backends.some(isBridge) ? t('chat.bridgeManage') : t('chat.bridgeSetup')}</span>
                    </button>
                  </>
                )}
              </Dropdown>
            ) : (
              <span className="muted small">{t('chat.contextHint')}</span>
            )}
            <span className="spacer" />
            {running ? (
              <button className="send-btn stop" onClick={stop} title={t('chat.stop')}>
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button className="send-btn" onClick={() => send(input)} disabled={!input.trim()} title={t('chat.send')}>
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
        {activeBackend === 'builtin' && ai && <AiQuota view={ai} onConfigure={() => setAiSettingsOpen(true)} />}
        {aiSettingsOpen &&
          createPortal(
          <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeAiSettings()}>
            <div className="modal ai-settings-dialog" role="dialog">
              <div className="modal-head">
                <div className="modal-title with-icon">
                  <Bot size={17} /> {t('ai.title')}
                </div>
                <IconButton icon={X} label={t('common.close')} onClick={closeAiSettings} />
              </div>
              <AiSettingsCard embedded startOpen />
            </div>
          </div>,
            document.body,
          )}
      </div>
    </div>
  );
}

/** 输入框下方的一行：当前模型、剩余免费额度与「配置自己的 Key」入口（在新标签页打开账号设置） */
function AiQuota({ view, onConfigure }: { view: AiSettingsView; onConfigure: () => void }) {
  const { t } = useI18n();
  const credit = view.shared.credit;
  const money = (v: number) => `${credit?.currency ?? '¥'}${v.toFixed(2)}`;
  const link = (
    <button type="button" className="quota-link" onClick={onConfigure}>
      <KeyRound size={11} /> {view.settings ? t('chat.quota.manage') : t('chat.quota.ownKey')}
    </button>
  );
  if (view.settings) {
    return (
      <div className="chat-quota" data-tour="quota">
        <span>{t('chat.quota.own', { model: view.settings.model })}</span>
        {link}
      </div>
    );
  }
  if (!view.shared.available) {
    return (
      <div className="chat-quota warn" data-tour="quota">
        <span>{t('chat.quota.none')}</span>
        {link}
      </div>
    );
  }
  if (credit) {
    const left = Math.max(0, credit.limit - credit.spent);
    return (
      <div className={`chat-quota ${left <= 0 ? 'warn' : ''}`} data-tour="quota">
        <span>{left <= 0 ? t('chat.quota.usedUp', { limit: money(credit.limit) }) : t('chat.quota.left', { left: money(left), limit: money(credit.limit) })}</span>
        {link}
      </div>
    );
  }
  return (
    <div className="chat-quota" data-tour="quota">
      <span>{t('chat.quota.shared', { model: view.shared.model })}</span>
      {link}
    </div>
  );
}

function ChatItemView({
  item,
  onOpenFile,
  onRevert,
}: {
  item: ChatItem;
  onOpenFile: Props['onOpenFile'];
  onRevert: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>;
    case 'assistant':
      return (
        <div className="msg assistant">
          <span className="ai-avatar">
            <Sparkles size={13} />
          </span>
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
          </div>
        </div>
      );
    case 'progress':
      return <div className="msg progress">{item.text}</div>;
    case 'tool': {
      const state = item.ok === undefined ? 'pending' : item.ok ? 'ok' : 'fail';
      const Icon = TOOL_ICON[item.name] ?? FilePen;
      const known = item.name in TOOL_ICON;
      return (
        <div className={`tool-step ${state}`}>
          <button className="tool-line" onClick={() => item.result && setOpen(!open)}>
            <span className="tool-icon">{state === 'pending' ? <Loader2 size={13} className="spin" /> : <Icon size={13} />}</span>
            <span className="tool-action">{known ? t(`tool.${item.name}` as never) : item.name}</span>
            {item.summary && <span className="tool-target">{item.summary}</span>}
            {state === 'fail' && <X size={13} className="tool-fail" />}
            {item.result && <span className="tool-caret">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>}
          </button>
          {open && item.result && <pre className="tool-result">{item.result}</pre>}
        </div>
      );
    }
    case 'run_summary':
      return <RunSummary item={item} onOpenFile={onOpenFile} onRevert={onRevert} />;
  }
}

function RunSummary({
  item,
  onOpenFile,
  onRevert,
}: {
  item: Extract<ChatItem, { kind: 'run_summary' }>;
  onOpenFile: Props['onOpenFile'];
  onRevert: (runId: string) => void;
}) {
  const { t } = useI18n();
  const statusText = item.status === 'stopped' ? t('chat.stopped') : item.status === 'error' ? t('chat.failed') : '';
  if (item.changes.length === 0) {
    return statusText ? <div className="run-note">{t('chat.noChanges', { status: statusText })}</div> : null;
  }
  const adds = item.changes.reduce((s, c) => s + c.additions, 0);
  const dels = item.changes.reduce((s, c) => s + c.deletions, 0);
  return (
    <div className={`run-summary ${item.reverted ? 'reverted' : ''}`}>
      <div className="run-head">
        <FilePen size={14} />
        <span>{t('chat.changedFiles', { count: item.changes.length })}</span>
        <span className="add">+{adds}</span>
        <span className="del">−{dels}</span>
        {statusText && <span className="muted small">· {statusText}</span>}
        <span className="spacer" />
        {item.reverted ? (
          <span className="reverted-tag">{t('chat.reverted')}</span>
        ) : (
          <button className="btn small ghost" onClick={() => onRevert(item.runId)}>
            <RotateCcw size={13} /> {t('chat.revert')}
          </button>
        )}
      </div>
      {item.changes.map((c) => (
        <ChangeRow key={c.path} change={c} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

function ChangeRow({ change, onOpenFile }: { change: FileChangeSummary; onOpenFile: Props['onOpenFile'] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const firstLine = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(change.patch)?.[1];
  return (
    <div className="change-row">
      <div className="change-line">
        <button className="change-toggle" onClick={() => setOpen(!open)} aria-label="diff">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <span className={`badge ${change.action}`}>{t(`chat.action.${change.action}` as const)}</span>
        <button
          className="link change-path"
          disabled={change.action === 'deleted'}
          onClick={() => onOpenFile(change.path, firstLine ? Number(firstLine) : undefined)}
        >
          {change.path}
        </button>
        <span className="spacer" />
        <span className="add">+{change.additions}</span>
        <span className="del">−{change.deletions}</span>
      </div>
      {open && (
        <pre className="diff">
          {change.patch
            .split('\n')
            .slice(4)
            .map((l, i) => (
              <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
                {l || ' '}
              </div>
            ))}
        </pre>
      )}
    </div>
  );
}
