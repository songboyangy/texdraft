import type { CompileResult, FileEntry, ProjectDetail, ProjectSymbols } from '@texdraft/shared';
import {
  ChevronDown, Code2, Crosshair, GraduationCap, PanelLeftClose, PanelRightClose, Download, FileText as FileTextIcon, Files, FileX2, Loader2, MoreHorizontal, PanelLeft,
  History, PanelRight, Plug, Play, ScrollText, Search, Share2, Sparkles, Type, X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChatPanel } from '../components/ChatPanel';
import { LayoutMenu } from '../components/LayoutMenu';
import { ShareDialog } from '../components/ShareDialog';
import { TOUR_DONE_KEY, Tour } from '../components/Tour';
import { CitationDialog } from '../components/CitationDialog';
import { HistoryView } from '../components/HistoryView';
import { LocalAgentDialog } from '../components/LocalAgentDialog';
import { CodeEditor, type CodeEditorHandle } from '../components/CodeEditor';
import { Diagnostics, statusLabel } from '../components/Diagnostics';
import { EditorToolbar } from '../components/EditorToolbar';
import { FigureDialog } from '../components/FigureDialog';
import { FilePreview } from '../components/FilePreview';
import { FileTree, fileIcon } from '../components/FileTree';
import { Logo } from '../components/Logo';
import { OutlinePanel } from '../components/OutlinePanel';
import { PdfViewer, type PdfViewerHandle } from '../components/PdfViewer';
import { ProjectSearch } from '../components/ProjectSearch';
import { SymbolPalette } from '../components/SymbolPalette';
import { Dropdown, IconButton, MenuDivider, MenuItem, MenuLabel, modKey } from '../components/ui';
import { UserMenu } from '../components/UserMenu';
import { WordCountDialog } from '../components/WordCountDialog';
import { api } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useI18n } from '../lib/i18n';
import { isInMath, type OutlineEntry } from '../lib/latexLanguage';
import { LIMITS, clamp, useDrag, useLayout } from '../lib/useLayout';
import { useProjectEvents } from '../lib/useProjectEvents';
import { userColor, useUser } from '../lib/user';

const AUTO_COMPILE_KEY = 'tp.autoCompile';
const AUTO_COMPILE_DELAY = 2000;
type SidebarTab = 'files' | 'search';

export function EditorPage() {
  const { id: projectId = '' } = useParams();
  const { user } = useUser();
  const { t } = useI18n();
  const dialog = useDialog();
  const { layout, update } = useLayout();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [compile, setCompile] = useState<CompileResult | null>(null);
  const [compiling, setCompiling] = useState(false);
  /** 服务器编译繁忙时的排队位置（0 = 没有排队） */
  const [queuePos, setQueuePos] = useState(0);
  const [compileElapsed, setCompileElapsed] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [autoCompile, setAutoCompile] = useState(() => localStorage.getItem(AUTO_COMPILE_KEY) === '1');
  const [syncStatus, setSyncStatus] = useState<'connecting' | 'synced' | 'offline'>('connecting');
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState('');
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [cursorLine, setCursorLine] = useState(1);
  const [outlineOpen, setOutlineOpen] = useState(() => localStorage.getItem('tp.outlineOpen') !== '0');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files');
  const [symbolsOpen, setSymbolsOpen] = useState(false);
  const [figureOpen, setFigureOpen] = useState(false);
  const [wordCountOpen, setWordCountOpen] = useState(false);
  const [citeOpen, setCiteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentTab, setAgentTab] = useState<'web' | 'computer'>('web');
  const editor = useRef<CodeEditorHandle>(null);
  const pdf = useRef<PdfViewerHandle>(null);
  const pendingJump = useRef<number | null>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const previewPane = useRef<HTMLElement>(null);
  /** 编辑器每次更新时通知工具栏重绘（不让整页随按键重渲染） */
  const editorEvents = useRef(new EventTarget());

  const canEdit = project?.role === 'owner' || project?.role === 'editor';
  const activeFile = files.find((f) => f.id === activeId) ?? null;
  const tabsKey = `tp.tabs.${projectId}`;

  useEffect(() => localStorage.setItem(AUTO_COMPILE_KEY, autoCompile ? '1' : '0'), [autoCompile]);
  useEffect(() => localStorage.setItem('tp.outlineOpen', outlineOpen ? '1' : '0'), [outlineOpen]);
  useEffect(() => setOutline([]), [activeId]);
  useEffect(() => {
    if (openIds.length) localStorage.setItem(tabsKey, JSON.stringify({ open: openIds, active: activeId }));
  }, [openIds, activeId, tabsKey]);

  // 编译计时：超过 8 秒提示可能在下载宏包 / 字体
  useEffect(() => {
    if (!compiling) return;
    const started = Date.now();
    setCompileElapsed(0);
    let hinted = false;
    const h = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setCompileElapsed(s);
      if (s >= 8 && !hinted) {
        hinted = true;
        flash(t('compile.slowHint'));
      }
    }, 1000);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiling]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 2600);
  };

  const refreshFiles = useCallback(async () => {
    const [list, dirs] = await Promise.all([api.files(projectId), api.folders(projectId).catch(() => [] as string[])]);
    setFiles(list);
    setFolders(dirs);
    return list;
  }, [projectId]);

  /** 打开文件（加入标签页） */
  const openFile = useCallback((id: string) => {
    setOpenIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
    setActiveId(id);
  }, []);

  const closeTab = (id: string) => {
    setOpenIds((ids) => {
      const idx = ids.indexOf(id);
      const next = ids.filter((x) => x !== id);
      if (id === activeId) setActiveId(next[Math.min(idx, next.length - 1)] ?? null);
      return next;
    });
  };

  // ---------------- 补全符号（带 5 秒缓存，文件变化时失效） ----------------
  const symbols = useRef<{ at: number; data: Promise<ProjectSymbols | null> } | null>(null);
  const getSymbols = useCallback(() => {
    if (!symbols.current || Date.now() - symbols.current.at > 5000) {
      symbols.current = { at: Date.now(), data: api.symbols(projectId).catch(() => null) };
    }
    return symbols.current.data;
  }, [projectId]);

  // ---------------- 初始加载 ----------------
  useEffect(() => {
    (async () => {
      try {
        const [p, list, last, dirs] = await Promise.all([
          api.project(projectId), api.files(projectId), api.latestCompile(projectId), api.folders(projectId).catch(() => [] as string[]),
        ]);
        setProject(p);
        setFiles(list);
        setFolders(dirs);
        setCompile(last);
        // 每次打开项目都先编译一次：先显示上次的 PDF，编译完自动换成最新的
        //（项目可能在别处被改过：AI、协作者、MCP、导入 / 复制）
        setFirstCompile(true);
        // 恢复上次打开的标签页
        let saved: { open: string[]; active: string | null } | null = null;
        try {
          saved = JSON.parse(localStorage.getItem(`tp.tabs.${projectId}`) || 'null');
        } catch {
          /* ignore */
        }
        const valid = (saved?.open ?? []).filter((id) => list.some((f) => f.id === id));
        const main = list.find((f) => f.path === p.mainFile) ?? list.find((f) => f.kind === 'text');
        const open = valid.length ? valid : main ? [main.id] : [];
        setOpenIds(open);
        setActiveId(saved?.active && open.includes(saved.active) ? saved.active : open[0] ?? null);
      } catch (e) {
        setLoadError((e as Error).message);
      }
    })();
  }, [projectId]);

  // 文件被删除（例如被 AI 或协作者删掉）时关闭对应标签页
  useEffect(() => {
    if (!files.length) return;
    setOpenIds((ids) => ids.filter((id) => files.some((f) => f.id === id)));
    if (activeId && !files.some((f) => f.id === activeId)) {
      const main = files.find((f) => f.path === project?.mainFile) ?? files.find((f) => f.kind === 'text');
      setActiveId(main?.id ?? null);
      if (main) setOpenIds((ids) => (ids.includes(main.id) ? ids : [...ids, main.id]));
    }
  }, [files, activeId, project?.mainFile]);

  useProjectEvents(projectId, (e) => {
    if (e.type === 'files_changed') {
      symbols.current = null;
      refreshFiles();
      api.project(projectId).then(setProject).catch(() => {});
    }
    if (e.type === 'compile_started') setCompiling(true);
    if (e.type === 'compile_queued') setQueuePos(e.position);
    if (e.type === 'compile_finished') {
      setCompiling(false);
      setQueuePos(0);
      setCompile(e.result);
    }
  });

  // ---------------- 编译 ----------------
  const runCompile = useCallback(async (opts: { silent?: boolean } = {}) => {
    setCompiling(true);
    try {
      const r = await api.compile(projectId);
      setCompile(r);
      if (r.diagnostics.some((d) => d.level === 'error')) setShowLog(true);
    } catch (e) {
      // 自动触发的编译（打开项目时）失败时不弹窗，用户可以手动再点编译
      if (!opts.silent) dialog.alert(t('compile.requestFailed'), (e as Error).message);
    } finally {
      setCompiling(false);
      setQueuePos(0);
    }
  }, [projectId, dialog, t]);

  const [firstCompile, setFirstCompile] = useState(false);
  useEffect(() => {
    if (!firstCompile) return;
    setFirstCompile(false);
    runCompile({ silent: true });
  }, [firstCompile, runCompile]);

  const autoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onLocalChange = useCallback(() => {
    symbols.current = null;
    if (!autoCompile) return;
    clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => runCompile(), AUTO_COMPILE_DELAY);
  }, [autoCompile, runCompile]);
  useEffect(() => () => clearTimeout(autoTimer.current), []);

  // ---------------- SyncTeX ----------------
  const syncToPdf = useCallback(async () => {
    if (!compile?.ok || !activeFile || activeFile.kind !== 'text') return;
    const line = editor.current?.getCursorLine() ?? 1;
    try {
      const r = await api.synctexToPdf(projectId, compile.jobId, activeFile.path, line);
      if (!layout.showPreview) update({ showPreview: true });
      pdf.current?.showRects(r.page, r.rects);
    } catch (e) {
      flash((e as Error).message);
    }
  }, [compile, activeFile, projectId, layout.showPreview, update]);

  const onPdfDoubleClick = useCallback(
    async (page: number, x: number, y: number) => {
      if (!compile?.ok) return;
      try {
        const r = await api.synctexToSource(projectId, compile.jobId, page, x, y);
        openPathRef.current(r.file, r.line);
      } catch (e) {
        flash((e as Error).message);
      }
    },
    [compile, projectId],
  );

  // ---------------- 快捷键 ----------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 's' || e.key === 'Enter')) {
        e.preventDefault();
        runCompile();
      } else if (mod && e.altKey && e.code === 'KeyJ') {
        e.preventDefault();
        syncToPdf();
      } else if (mod && e.shiftKey && e.code === 'KeyF') {
        e.preventDefault();
        update({ showSidebar: true });
        setSidebarTab('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runCompile, syncToPdf, update]);

  /** 打开文件并跳到指定行（编译日志、AI 改动摘要、SyncTeX、搜索结果都会用到） */
  const openPath = useCallback(
    async (path: string, line?: number) => {
      let f = files.find((x) => x.path === path);
      if (!f) f = (await refreshFiles()).find((x) => x.path === path);
      if (!f) return;
      if (f.id === activeId) {
        if (line) editor.current?.goToLine(line);
      } else {
        pendingJump.current = f.kind === 'text' ? line ?? null : null;
        openFile(f.id);
      }
    },
    [files, activeId, refreshFiles, openFile],
  );
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;

  useEffect(() => {
    if (syncStatus === 'synced' && pendingJump.current) {
      editor.current?.goToLine(pendingJump.current);
      pendingJump.current = null;
    }
  }, [syncStatus, activeId]);

  const getContext = useCallback(
    () => ({
      activePath: activeFile?.path,
      cursorLine: activeFile?.kind === 'text' ? editor.current?.getCursorLine() : undefined,
      selection: (activeFile?.kind === 'text' && editor.current?.getSelection()) || undefined,
    }),
    [activeFile?.path, activeFile?.kind],
  );

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refreshFiles();
    } catch (e) {
      dialog.alert(t('common.failed'), (e as Error).message);
    }
  };

  const insertSymbol = (command: string) => {
    const view = editor.current?.view();
    if (!view) return;
    const pos = view.state.selection.main.head;
    const text = isInMath(view.state, pos) ? command : `$${command}$`;
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
  };

  const [shareOpen, setShareOpen] = useState(false);

  // ---------------- 新手引导 ----------------
  const [tourOpen, setTourOpen] = useState(false);
  const startTour = useCallback(() => {
    setHistoryOpen(false);
    // 引导要依次介绍所有面板：先全部展开
    update({ showSidebar: true, showEditor: true, showPreview: true, showChat: true });
    setTourOpen(true);
  }, [update]);
  const closeTour = () => {
    setTourOpen(false);
    try {
      localStorage.setItem(TOUR_DONE_KEY, '1');
    } catch {
      /* 隐私模式：下次还会自动出现 */
    }
  };
  // 聊天面板「在网页里用你电脑上的 Codex / Claude Code」：打开连接说明
  useEffect(() => {
    const open = () => {
      setAgentTab('computer');
      setAgentOpen(true);
    };
    window.addEventListener('texdraft:open-agents', open);
    return () => window.removeEventListener('texdraft:open-agents', open);
  }, []);

  // 打开示例项目且还没看过引导时自动开始
  useEffect(() => {
    if (!project || !project.name.startsWith('TeXdraft 示例')) return;
    let done = false;
    try {
      done = localStorage.getItem(TOUR_DONE_KEY) === '1';
    } catch {
      /* ignore */
    }
    if (!done) {
      const h = setTimeout(startTour, 800);
      return () => clearTimeout(h);
    }
  }, [project?.id]);
  const share = () => setShareOpen(true);

  // ---------------- 面板拖拽 ----------------
  const dragStart = useRef(layout);
  const beginDrag = () => (dragStart.current = layout);
  const dragSidebar = useDrag((dx) => update({ sidebar: clamp(dragStart.current.sidebar + dx, LIMITS.sidebar) }));
  const dragChat = useDrag((dx) => update({ chat: clamp(dragStart.current.chat - dx, LIMITS.chat) }));
  const dragSplit = useDrag((dx) => {
    const el = workspace.current;
    if (!el) return;
    const fixed = (layout.showSidebar ? dragStart.current.sidebar : 28) + (layout.showChat ? dragStart.current.chat : 28);
    update({ split: clamp(dragStart.current.split + dx / (el.clientWidth - fixed), LIMITS.split) });
  });
  const dragLog = useDrag((_dx, dy) => {
    const h = previewPane.current?.clientHeight ?? 600;
    update({ logHeight: clamp(dragStart.current.logHeight - dy / h, LIMITS.logHeight) });
  });

  if (loadError) {
    return (
      <div className="center-screen">
        <div className="empty-state">
          <div className="empty-icon">
            <FileX2 size={26} />
          </div>
          <h3>{t('editor.loadFailed')}</h3>
          <p className="form-error">{loadError}</p>
          <Link className="btn" to="/">
            {t('editor.backToProjects')}
          </Link>
        </div>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="center-screen muted">
        <Loader2 size={18} className="spin" /> {t('editor.loading')}
      </div>
    );
  }

  const errors = compile?.diagnostics.filter((d) => d.level === 'error').length ?? 0;
  const warnings = compile?.diagnostics.filter((d) => d.level === 'warning').length ?? 0;
  const openTabs = openIds.map((id) => files.find((f) => f.id === id)).filter(Boolean) as FileEntry[];

  // 每一栏都可以收起：收起后留一条窄竖条（RAIL），点击展开。源码与 PDF 至少保留一个
  const showEditor = layout.showEditor || !layout.showPreview;
  const RAIL = '28px';
  const cols: string[] = [];
  if (layout.showSidebar) cols.push(`${layout.sidebar}px`, '1px');
  else cols.push(RAIL);
  if (showEditor) cols.push(layout.showPreview ? `minmax(0, ${layout.split}fr)` : 'minmax(0, 1fr)');
  else cols.push(RAIL);
  if (layout.showPreview) cols.push(...(showEditor ? ['1px', `minmax(0, ${1 - layout.split}fr)`] : ['minmax(0, 1fr)']));
  else cols.push(RAIL);
  if (layout.showChat) cols.push('1px', `${layout.chat}px`);
  else cols.push(RAIL);
  const rail = (icon: typeof Files, label: string, patch: Partial<typeof layout>, tour: string) => (
    <button className="pane-rail" data-tour={tour} onClick={() => update(patch)} title={t('layout.expand', { name: label })} aria-label={t('layout.expand', { name: label })}>
      {(() => {
        const Icon = icon;
        return <Icon size={15} />;
      })()}
      <span>{label}</span>
    </button>
  );

  return (
    <div className="editor-page">
      <header className="ide-header">
        <Link to="/" className="ide-home" title={t('editor.backToProjects')}>
          <Logo size={22} withText={false} />
        </Link>
        <button
          className="ide-project-name"
          title={canEdit ? t('editor.rename') : undefined}
          onClick={async () => {
            if (!canEdit) return;
            const name = await dialog.prompt(t('editor.rename'), project.name);
            if (name) api.updateProject(projectId, { name }).then(setProject, (e) => dialog.alert(t('common.failed'), e.message));
          }}
        >
          {project.name}
        </button>
        {!canEdit && <span className="ide-badge">{t('role.viewer')}</span>}
        <span className={`sync-dot ${syncStatus}`} title={t(`sync.${syncStatus}` as const)} />
        <span className="spacer" />

        <div className="compile-group">
          <button className="compile-btn" data-tour="compile" onClick={() => runCompile()} disabled={compiling} title={`${t('compile.run')} (${modKey}+S)`}>
            {compiling ? <Loader2 size={15} className="spin" /> : <Play size={14} fill="currentColor" />}
            <span>
              {compiling && queuePos > 0
                ? t('compile.queued', { n: queuePos })
                : compiling
                  ? `${t('compile.running')}${compileElapsed >= 2 ? ` ${compileElapsed}s` : ''}`
                  : t('compile.run')}
            </span>
          </button>
          <Dropdown
            align="right"
            trigger={(_o, toggle) => (
              <button className="compile-btn caret" onClick={toggle} aria-label={t('compile.options')}>
                <ChevronDown size={14} />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem checked={autoCompile} onClick={() => setAutoCompile(!autoCompile)}>
                  {t('compile.auto')}
                </MenuItem>
                <MenuDivider />
                <MenuLabel>{t('compile.engine')}</MenuLabel>
                {(['pdflatex', 'xelatex', 'lualatex'] as const).map((eng) => (
                  <MenuItem
                    key={eng}
                    checked={project.engine === eng}
                    disabled={!canEdit}
                    onClick={() => {
                      close();
                      api.updateProject(projectId, { engine: eng }).then(setProject);
                    }}
                  >
                    {{ pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' }[eng]}
                  </MenuItem>
                ))}
                <MenuDivider />
                <MenuItem icon={ScrollText} onClick={() => (close(), setShowLog(true))} disabled={!compile}>
                  {t('compile.viewLog')}
                </MenuItem>
              </>
            )}
          </Dropdown>
        </div>
        {compile && (
          <button className={`log-pill ${errors ? 'err' : warnings ? 'warn' : 'ok'}`} onClick={() => setShowLog(!showLog)} title={t('compile.viewLog')}>
            {statusLabel(compile, t)}
            {errors > 0 && <span className="pill-count err">{errors}</span>}
            {warnings > 0 && <span className="pill-count warn">{warnings}</span>}
          </button>
        )}

        <span className="ide-sep" />
        <Dropdown
          align="right"
          trigger={(_o, toggle) => (
            <span data-tour="more">
              <IconButton icon={MoreHorizontal} label={t('common.more')} variant="dark" onClick={toggle} />
            </span>
          )}
        >
          {(close) => (
            <>
              <a className="menu-item" href={api.downloadUrl(projectId)} download onClick={close}>
                <span className="menu-icon">
                  <Download size={15} />
                </span>
                <span className="menu-label">{t('editor.downloadZip')}</span>
              </a>
              {compile?.pdfUrl && (
                <a className="menu-item" href={compile.pdfUrl} download="output.pdf" onClick={close}>
                  <span className="menu-icon">
                    <FileTextIcon size={15} />
                  </span>
                  <span className="menu-label">{t('pdf.download')}</span>
                </a>
              )}
              <MenuItem icon={Type} onClick={() => (close(), setWordCountOpen(true))}>
                {t('wordcount.title')}
              </MenuItem>
              <MenuItem icon={GraduationCap} onClick={() => (close(), startTour())}>
                {t('tour.menu')}
              </MenuItem>
              <MenuDivider />
              <MenuItem icon={Plug} onClick={() => (close(), setAgentOpen(true))}>
                {t('agent.menu')}
              </MenuItem>
            </>
          )}
        </Dropdown>
        <button className={`ide-btn ${historyOpen ? 'on' : ''}`} data-tour="history" onClick={() => setHistoryOpen(!historyOpen)} title={t('history.title')}>
          <History size={14} /> {t('history.button')}
        </button>
        {project.role === 'owner' && (
          <button className="ide-btn" data-tour="share" onClick={share}>
            <Share2 size={14} /> {t('share.button')}
          </button>
        )}
        <span className="ide-sep" />
        <LayoutMenu layout={layout} update={update} />
        <UserMenu showEditorSettings />
      </header>

      {shareOpen && <ShareDialog projectId={projectId} onClose={() => setShareOpen(false)} />}
      {tourOpen && (
        <Tour
          onClose={closeTour}
          actions={{
            compile: () => runCompile(),
            askAi: (text) => window.dispatchEvent(new CustomEvent('texdraft:chat-send', { detail: text })),
            openAgents: () => setAgentOpen(true),
          }}
        />
      )}
      {historyOpen ? (
        <HistoryView projectId={projectId} canEdit={canEdit} onClose={() => setHistoryOpen(false)} onToast={flash} />
      ) : (
      <div className="workspace" ref={workspace} style={{ gridTemplateColumns: cols.join(' ') }}>
        {layout.showSidebar ? (
          <>
            <aside className="sidebar" data-tour="files">
              <div className="sidebar-tabs">
                <button className={sidebarTab === 'files' ? 'on' : ''} onClick={() => setSidebarTab('files')}>
                  <Files size={15} /> {t('files.title')}
                </button>
                <button className={sidebarTab === 'search' ? 'on' : ''} onClick={() => setSidebarTab('search')} title={`${t('search.title')} (${modKey}+Shift+F)`}>
                  <Search size={15} /> {t('search.title')}
                </button>
                <IconButton icon={PanelLeftClose} label={t('layout.collapse')} size={14} className="pane-collapse" onClick={() => update({ showSidebar: false })} />
              </div>
              {sidebarTab === 'files' ? (
                <>
                  <FileTree
                    files={files}
                    folders={folders}
                    activeId={activeId}
                    mainFile={project.mainFile}
                    canEdit={canEdit}
                    onOpen={(f) => openFile(f.id)}
                    onCreate={(path) =>
                      act(async () => {
                        const f = await api.createFile(projectId, path);
                        openFile(f.id);
                      })
                    }
                    onUpload={(list, dir) => act(() => api.upload(projectId, list, dir))}
                    onRename={(f, to) => act(() => api.renameFile(projectId, f.id, to))}
                    onDelete={(f) => act(() => api.deleteFile(projectId, f.id))}
                    onCreateFolder={(path) => act(() => api.createFolder(projectId, path))}
                    onRenameFolder={(from, to) => act(() => api.renameFolder(projectId, from, to))}
                    onDeleteFolder={(path) => act(() => api.deleteFolder(projectId, path))}
                    onSetMain={(f) => act(async () => setProject(await api.updateProject(projectId, { mainFile: f.path })))}
                  />
                  {activeFile?.kind === 'text' && (
                    <OutlinePanel
                      outline={outline}
                      cursorLine={cursorLine}
                      open={outlineOpen}
                      onToggle={() => setOutlineOpen(!outlineOpen)}
                      onJump={(line) => editor.current?.goToLine(line)}
                    />
                  )}
                </>
              ) : (
                <ProjectSearch projectId={projectId} canEdit={canEdit} onOpen={(path, line) => openPath(path, line)} />
              )}
            </aside>
            <div className="splitter" onPointerDown={(e) => (beginDrag(), dragSidebar(e))} onDoubleClick={() => update({ sidebar: 240 })} />
          </>
        ) : (
          rail(Files, t('files.title'), { showSidebar: true }, 'files')
        )}

        {showEditor ? (
        <section className="editor-pane" data-tour="editor">
          <div className="tab-bar">
            <div className="tabs">
              {openTabs.map((f) => {
                const { Icon, cls } = fileIcon(f.path);
                return (
                  <div
                    key={f.id}
                    className={`tab ${f.id === activeId ? 'active' : ''}`}
                    onClick={() => setActiveId(f.id)}
                    onAuxClick={(e) => e.button === 1 && closeTab(f.id)}
                    title={f.path}
                  >
                    <Icon size={14} className={`file-icon ${cls}`} />
                    <span className="tab-name">{f.path.split('/').pop()}</span>
                    {f.path === project.mainFile && <span className="tab-main" />}
                    <button
                      className="tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(f.id);
                      }}
                      aria-label={t('common.close')}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
            {activeFile?.kind === 'text' && compile?.ok && (
              <IconButton icon={Crosshair} label={`${t('editor.syncToPdf')} (${modKey}+Alt+J)`} size={15} onClick={syncToPdf} />
            )}
            {layout.showPreview && <IconButton icon={PanelLeftClose} label={t('layout.collapse')} size={14} className="pane-collapse" onClick={() => update({ showEditor: false })} />}
          </div>
          {activeFile?.kind === 'text' && /\.(tex|ltx)$/i.test(activeFile.path) && (
            <ToolbarHost
              events={editorEvents.current}
              getView={() => editor.current?.view() ?? null}
              readOnly={!canEdit}
              onInsertFigure={() => setFigureOpen(true)}
              onCite={() => setCiteOpen(true)}
              symbolsOpen={symbolsOpen}
              onToggleSymbols={() => setSymbolsOpen(!symbolsOpen)}
            />
          )}
          {activeFile?.kind === 'text' ? (
            <CodeEditor
              key={activeFile.id}
              ref={editor}
              fileId={activeFile.id}
              projectId={projectId}
              aiEnabled={/\.(tex|ltx)$/i.test(activeFile.path)}
              path={activeFile.path}
              readOnly={!canEdit}
              user={{ name: user.name, color: userColor(user.id) }}
              onStatus={setSyncStatus}
              getSymbols={getSymbols}
              onLocalChange={onLocalChange}
              onOutline={setOutline}
              onCursorLine={(line) => {
                setCursorLine(line);
                editorEvents.current.dispatchEvent(new Event('update'));
              }}
            />
          ) : activeFile ? (
            <FilePreview file={activeFile} url={api.rawFileUrl(projectId, activeFile.id)} />
          ) : (
            <div className="empty-editor">
              <Files size={30} />
              <p>{t('editor.noFile')}</p>
            </div>
          )}
          {symbolsOpen && activeFile?.kind === 'text' && <SymbolPalette onInsert={insertSymbol} onClose={() => setSymbolsOpen(false)} />}
        </section>
        ) : (
          rail(Code2, t('layout.editor'), { showEditor: true }, 'editor')
        )}

        {layout.showPreview ? (
          <>
            {showEditor && <div className="splitter" onPointerDown={(e) => (beginDrag(), dragSplit(e))} onDoubleClick={() => update({ split: 0.5 })} />}
            <section className="preview-pane" ref={previewPane} data-tour="pdf">
              <div className="preview-main">
                <PdfViewer
                  ref={pdf}
                  url={compile?.pdfUrl}
                  onDoubleClick={onPdfDoubleClick}
                  toolbarExtra={<IconButton icon={PanelRightClose} label={t('layout.collapse')} size={15} className="pane-collapse" onClick={() => update(showEditor ? { showPreview: false } : { showPreview: false, showEditor: true })} />}
                />
              </div>
              {showLog && compile && (
                <>
                  <div className="splitter horizontal" onPointerDown={(e) => (beginDrag(), dragLog(e))} />
                  <div className="preview-log" style={{ height: `${layout.logHeight * 100}%` }}>
                    <Diagnostics result={compile} onJump={(file, line) => openPath(file, line)} onClose={() => setShowLog(false)} />
                  </div>
                </>
              )}
            </section>
          </>
        ) : (
          rail(FileTextIcon, t('layout.preview'), { showPreview: true }, 'pdf')
        )}

        {layout.showChat ? (
          <>
            <div className="splitter" onPointerDown={(e) => (beginDrag(), dragChat(e))} onDoubleClick={() => update({ chat: 400 })} />
            <aside className="chat-pane" data-tour="ai">
              {canEdit ? (
                <ChatPanel projectId={projectId} getContext={getContext} onOpenFile={openPath} compile={compile} onCollapse={() => update({ showChat: false })} />
              ) : (
                <div className="center muted pad">{t('chat.viewerOnly')}</div>
              )}
            </aside>
          </>
        ) : (
          rail(Sparkles, t('layout.ai'), { showChat: true }, 'ai')
        )}
      </div>

      )}

      {figureOpen && editor.current?.view() && (
        <FigureDialog
          projectId={projectId}
          files={files}
          view={editor.current.view()!}
          onClose={() => setFigureOpen(false)}
          onUploaded={refreshFiles}
        />
      )}
      {citeOpen && editor.current?.view() && (
        <CitationDialog
          projectId={projectId}
          view={editor.current.view()!}
          getSymbols={getSymbols}
          onClose={() => {
            setCiteOpen(false);
            symbols.current = null;
          }}
          onToast={flash}
        />
      )}
      {agentOpen && <LocalAgentDialog projectId={projectId} projectName={project.name} initialTab={agentTab} onClose={() => (setAgentOpen(false), setAgentTab('web'))} />}
      {wordCountOpen && <WordCountDialog projectId={projectId} mainFile={project.mainFile} onClose={() => setWordCountOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/** 工具栏宿主：订阅编辑器更新事件，只重绘工具栏本身 */
function ToolbarHost({
  events,
  ...props
}: Omit<React.ComponentProps<typeof EditorToolbar>, 'tick'> & { events: EventTarget }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let frame = 0;
    const onUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((x) => x + 1));
    };
    events.addEventListener('update', onUpdate);
    return () => {
      cancelAnimationFrame(frame);
      events.removeEventListener('update', onUpdate);
    };
  }, [events]);
  return <EditorToolbar {...props} tick={tick} />;
}
