import { HocuspocusProvider } from '@hocuspocus/provider';
import { indentWithTab } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { yCollab, ySyncAnnotation } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { ProjectSymbols } from '@texdraft/shared';
import { latexCompletion } from '../lib/latexCompletion';
import { extractOutline, latexLanguage, type OutlineEntry } from '../lib/latexLanguage';
import { mathPreview } from '../lib/mathPreview';
import { SelectionAI } from './SelectionAI';
import { useT } from '../lib/i18n';
import { useSettings } from '../lib/settings';
import { toggleBold, toggleItalic } from '../lib/overleaf/features/source-editor/extensions/toolbar/commands';
import { Prec } from '@codemirror/state';

export interface CodeEditorHandle {
  goToLine(line: number): void;
  getSelection(): string;
  getCursorLine(): number;
  focus(): void;
  /** 底层 CodeMirror 视图（工具栏命令使用） */
  view(): EditorView | null;
}

/** 上报编辑操作类型（不等待结果、失败忽略） */
function reportEditHint(projectId: string, fileId: string, event: string) {
  fetch(`/api/projects/${projectId}/edit-log/hint`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId, event }),
  }).catch(() => {});
}

interface Props {
  fileId: string;
  projectId: string;
  /** 是否启用选中文字 AI 菜单 */
  aiEnabled?: boolean;
  /** 文件路径，用于选择语言模式 */
  path: string;
  readOnly: boolean;
  user: { name: string; color: string };
  onStatus?: (s: 'connecting' | 'synced' | 'offline') => void;
  /** 补全用的项目符号（带缓存的获取函数） */
  getSymbols?: () => Promise<ProjectSymbols | null>;
  /** 本地用户修改了文档（不含协作者/AI 的远程修改） */
  onLocalChange?: () => void;
  /** 文档大纲（仅 LaTeX 文件；文档变化后防抖更新） */
  onOutline?: (outline: OutlineEntry[]) => void;
  /** 光标所在行（用于大纲高亮） */
  onCursorLine?: (line: number) => void;
  ref?: Ref<CodeEditorHandle>;
}

// ---- 远程修改（协作者或 AI）短暂高亮 ----
const addFlash = StateEffect.define<{ from: number; to: number }[]>();
const clearFlash = StateEffect.define<null>();
const flashMark = Decoration.mark({ class: 'cm-remote-change' });
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addFlash)) deco = deco.update({ add: e.value.map((r) => flashMark.range(r.from, r.to)), sort: true });
      if (e.is(clearFlash)) deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function remoteFlash(): Extension {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return [
    flashField,
    EditorView.updateListener.of((u) => {
      const remote = u.transactions.filter((tr) => tr.annotation(ySyncAnnotation) && tr.docChanged);
      if (!remote.length) return;
      const ranges: { from: number; to: number }[] = [];
      for (const tr of remote) {
        tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
          if (toB > fromB) ranges.push({ from: fromB, to: toB });
        });
      }
      if (!ranges.length) return;
      // 在下一个微任务派发，避免在 update 中嵌套 dispatch
      queueMicrotask(() => u.view.dispatch({ effects: addFlash.of(ranges) }));
      clearTimeout(timer);
      timer = setTimeout(() => u.view.dispatch({ effects: clearFlash.of(null) }), 2500);
    }),
  ];
}

const theme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
  '.cm-content': { padding: '10px 0' },
  '.cm-gutters': { background: 'var(--editor-gutter)', borderRight: '1px solid var(--border-subtle)', color: 'var(--text-faint)' },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--text-muted)' },
  '.cm-activeLine': { background: 'var(--editor-active-line)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'var(--editor-selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--brand)', borderLeftWidth: '2px' },
  '.cm-foldPlaceholder': { background: 'var(--surface-sunken)', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: '4px', padding: '0 6px' },
  '.cm-panels': { background: 'var(--surface)', borderColor: 'var(--border)' },
});

const appearanceExt = (fontSize: number, wrap: boolean): Extension => [
  EditorView.theme({ '&': { fontSize: `${fontSize}px` } }),
  wrap ? EditorView.lineWrapping : [],
];

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/collab`;
}

export function CodeEditor({ fileId, projectId, aiEnabled = false, path, readOnly, user, onStatus, getSymbols, onLocalChange, onOutline, onCursorLine, ref }: Props) {
  const cb = useRef({ getSymbols, onLocalChange, onOutline, onCursorLine });
  cb.current = { getSymbols, onLocalChange, onOutline, onCursorLine };
  const isLatex = /\.(tex|sty|cls|ltx|tikz|dtx)$/i.test(path);
  const t = useT();
  const settings = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const appearance = useRef(new Compartment());
  const container = useRef<HTMLDivElement>(null);
  const [liveView, setLiveView] = useState<EditorView | null>(null);
  /** 编辑器每次更新时通知的监听者（选中文字 AI 菜单使用） */
  const updateListeners = useRef(new Set<() => void>());
  const subscribe = useCallback((fn: () => void) => {
    updateListeners.current.add(fn);
    return () => void updateListeners.current.delete(fn);
  }, []);

  // 字号 / 自动换行：运行中切换，不重建编辑器
  useEffect(() => {
    viewRef.current?.dispatch({ effects: appearance.current.reconfigure(appearanceExt(settings.editorFontSize, settings.lineWrapping)) });
  }, [settings.editorFontSize, settings.lineWrapping]);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [error, setError] = useState('');
  const pendingLine = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    goToLine(line: number) {
      const view = viewRef.current;
      if (!view) {
        pendingLine.current = line;
        return;
      }
      const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({ selection: EditorSelection.cursor(l.from), scrollIntoView: true });
      view.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
      view.focus();
    },
    getSelection() {
      const v = viewRef.current;
      if (!v) return '';
      return v.state.selection.ranges.map((r) => v.state.sliceDoc(r.from, r.to)).join('\n');
    },
    getCursorLine() {
      const v = viewRef.current;
      return v ? v.state.doc.lineAt(v.state.selection.main.head).number : 1;
    },
    focus() {
      viewRef.current?.focus();
    },
    view() {
      return viewRef.current;
    },
  }));

  useEffect(() => {
    setError('');
    onStatus?.('connecting');
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: wsUrl(),
      name: fileId,
      document: ydoc,
      onStatus: ({ status }) => {
        if (status === 'disconnected') onStatus?.('offline');
      },
      onClose: ({ event }) => {
        if (event.code === 4401 || event.code === 4403 || event.code === 1008) setError(t('editor.noAccess'));
      },
    });
    provider.awareness?.setLocalStateField('user', { name: user.name, color: user.color, colorLight: user.color + '33' });

    let view: EditorView | null = null;
    let outlineTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleOutline = (v: EditorView, delay = 400) => {
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(() => cb.current.onOutline?.(extractOutline(v.state)), delay);
    };
    const onSynced = () => {
      onStatus?.('synced');
      if (view) return;
      const ytext = ydoc.getText('content');
      const undoManager = new Y.UndoManager(ytext); // 只撤销自己的编辑，不会撤掉 AI 或他人的修改
      view = new EditorView({
        parent: host.current!,
        state: EditorState.create({
          doc: ytext.toString(),
          extensions: [
            basicSetup,
            keymap.of([indentWithTab]),
            ...(isLatex ? [Prec.high(keymap.of([{ key: 'Mod-b', run: toggleBold }, { key: 'Mod-i', run: toggleItalic }]))] : []),
            // LaTeX：Overleaf 的 Lezer 语法（高亮、折叠、实时语法检查）+ 公式预览；其他文本文件沿用简单高亮
            ...(isLatex ? [latexLanguage(), mathPreview()] : [StreamLanguage.define(stex)]),
            appearance.current.of(appearanceExt(settingsRef.current.editorFontSize, settingsRef.current.lineWrapping)),
            EditorState.readOnly.of(readOnly),
            yCollab(ytext, provider.awareness, { undoManager }),
            remoteFlash(),
            latexCompletion(() => cb.current.getSymbols?.() ?? Promise.resolve(null)),
            EditorView.updateListener.of((u) => {
              if (u.docChanged && u.transactions.some((tr) => !tr.annotation(ySyncAnnotation))) cb.current.onLocalChange?.();
              // 本地删除跨行时，把操作类型（delete.line、delete.cut、undo…）报给服务器写进编辑记录，便于排查内容被误删
              if (u.docChanged) {
                for (const tr of u.transactions) {
                  if (tr.annotation(ySyncAnnotation) || !tr.docChanged) continue;
                  let crossesLine = false;
                  tr.changes.iterChanges((fromA, toA) => {
                    if (!crossesLine && toA > fromA && tr.startState.doc.sliceString(fromA, toA).includes('\n')) crossesLine = true;
                  });
                  if (crossesLine) reportEditHint(projectId, fileId, tr.annotation(Transaction.userEvent) ?? 'unknown');
                }
              }
              if (isLatex && u.docChanged) scheduleOutline(u.view);
              if (u.selectionSet || u.docChanged) cb.current.onCursorLine?.(u.state.doc.lineAt(u.state.selection.main.head).number);
              if (u.selectionSet || u.docChanged) updateListeners.current.forEach((fn) => fn());
            }),
            theme,
          ],
        }),
      });
      viewRef.current = view;
      setLiveView(view);
      if (isLatex) scheduleOutline(view, 0);
      else cb.current.onOutline?.([]);
      if (pendingLine.current) {
        const line = pendingLine.current;
        pendingLine.current = null;
        const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        view.dispatch({ selection: EditorSelection.cursor(l.from), effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
        // 只有明确跳转到某一行时才聚焦；刚打开文件时不抢焦点，避免页面上的按键误改第 1 行
        view.focus();
      }
    };
    provider.on('synced', onSynced);

    return () => {
      clearTimeout(outlineTimer);
      provider.off('synced', onSynced);
      view?.destroy();
      viewRef.current = null;
      setLiveView(null);
      provider.destroy();
      ydoc.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, readOnly]);

  return (
    <div className="code-editor" ref={container}>
      {error && <div className="editor-error">{error}</div>}
      <div ref={host} className="cm-host" />
      {aiEnabled && !readOnly && liveView && container.current && (
        <SelectionAI view={liveView} projectId={projectId} container={container.current} subscribe={subscribe} />
      )}
    </div>
  );
}
