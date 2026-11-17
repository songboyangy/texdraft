import type { TransformAction } from '@texdraft/shared';
import type { EditorView } from '@codemirror/view';
import {
  ArrowDownToLine, BookOpenText, Check, ChevronDown, Copy, CornerDownLeft, Expand, Languages, Loader2, RefreshCw,
  Shrink, Sparkles, SpellCheck2, Wand2, X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamTransform } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Dropdown } from './ui';

interface Range {
  from: number;
  to: number;
  text: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'menu'; range: Range }
  | { kind: 'running' | 'done' | 'error'; range: Range; action: TransformAction; instruction?: string; output: string; error?: string };

const MIN_CHARS = 2;

/**
 * 选中文字后的 AI 浮动菜单（润色 / 翻译 / 精简 / 扩写 / 语法 / 解释 / 自定义），
 * 结果流式显示，用户确认后才写入文档（替换选区或插入到下方）。
 */
export function SelectionAI({
  view,
  projectId,
  container,
  subscribe,
}: {
  view: EditorView;
  projectId: string;
  container: HTMLElement;
  subscribe: (fn: () => void) => () => void;
}) {
  const { t, locale } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [instruction, setInstruction] = useState('');
  const [copied, setCopied] = useState(false);
  const dragging = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const box = useRef<HTMLDivElement>(null);

  /** 根据当前选区更新菜单状态（结果卡片打开时不受选区变化影响） */
  const syncSelection = useCallback(() => {
    if (dragging.current) return;
    const cur = phaseRef.current;
    if (cur.kind === 'running' || cur.kind === 'done' || cur.kind === 'error') return;
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (sel.empty || text.trim().length < MIN_CHARS || view.state.readOnly) {
      if (cur.kind !== 'idle') setPhase({ kind: 'idle' });
      return;
    }
    if (cur.kind === 'menu' && cur.range.from === sel.from && cur.range.to === sel.to) return;
    setPhase({ kind: 'menu', range: { from: sel.from, to: sel.to, text } });
  }, [view]);

  // 订阅编辑器更新；拖选过程中不弹出，松开鼠标后再判断
  useEffect(() => {
    const unsub = subscribe(syncSelection);
    const onDown = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      dragging.current = true;
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setTimeout(syncSelection, 0);
    };
    view.dom.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    return () => {
      unsub();
      view.dom.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
    };
  }, [view, subscribe, syncSelection]);

  // 定位：选区末尾下方；空间不足时放到选区上方
  const reposition = useCallback(() => {
    const p = phaseRef.current;
    if (p.kind === 'idle') return setPos(null);
    const end = view.coordsAtPos(p.range.to);
    const start = view.coordsAtPos(p.range.from);
    if (!end || !start) return setPos(null);
    const rect = container.getBoundingClientRect();
    const height = box.current?.offsetHeight ?? 40;
    const width = box.current?.offsetWidth ?? 320;
    let top = end.bottom - rect.top + 6;
    let above = false;
    if (top + height > rect.height - 8 && start.top - rect.top - height - 6 > 0) {
      top = start.top - rect.top - height - 6;
      above = true;
    }
    const left = Math.max(8, Math.min(end.left - rect.left - 24, rect.width - width - 8));
    setPos({ left, top, above });
  }, [view, container]);

  useLayoutEffect(reposition, [phase, reposition]);
  useEffect(() => {
    const el = view.scrollDOM;
    el.addEventListener('scroll', reposition);
    window.addEventListener('resize', reposition);
    return () => {
      el.removeEventListener('scroll', reposition);
      window.removeEventListener('resize', reposition);
    };
  }, [view, reposition]);

  const close = useCallback(() => {
    abort.current?.abort();
    setPhase({ kind: 'idle' });
    setInstruction('');
    view.focus();
  }, [view]);

  useEffect(() => {
    if (phase.kind === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase.kind, close]);
  useEffect(() => () => abort.current?.abort(), []);

  const run = async (action: TransformAction, range: Range, instr?: string) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const doc = view.state.doc;
    const before = doc.sliceString(Math.max(0, range.from - 1500), range.from);
    const after = doc.sliceString(range.to, Math.min(doc.length, range.to + 800));
    setPhase({ kind: 'running', range, action, instruction: instr, output: '' });
    try {
      await streamTransform(
        projectId,
        { action, text: range.text, instruction: instr, before, after, lang: locale },
        (e) => {
          setPhase((p) => {
            if (p.kind !== 'running') return p;
            if (e.type === 'delta') return { ...p, output: p.output + e.text };
            if (e.type === 'done') return { ...p, kind: 'done', output: e.text };
            return { ...p, kind: 'error', error: e.message };
          });
        },
        ctrl.signal,
      );
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setPhase((p) => (p.kind === 'running' ? { ...p, kind: 'error', error: (err as Error).message } : p));
    }
  };

  /** 找回原选区位置（等待期间文档可能被协作者或 AI 修改） */
  const locate = (range: Range): { from: number; to: number } | null => {
    const doc = view.state.doc;
    if (range.to <= doc.length && doc.sliceString(range.from, range.to) === range.text) return range;
    const lo = Math.max(0, range.from - 3000);
    const window = doc.sliceString(lo, Math.min(doc.length, range.to + 3000));
    const idx = window.indexOf(range.text);
    return idx >= 0 ? { from: lo + idx, to: lo + idx + range.text.length } : null;
  };

  const apply = (mode: 'replace' | 'below') => {
    if (phase.kind !== 'done') return;
    const at = locate(phase.range);
    if (!at) {
      setPhase({ ...phase, kind: 'error', error: t('ai.rangeChanged') });
      return;
    }
    const text = phase.output;
    if (mode === 'replace') {
      view.dispatch({ changes: { from: at.from, to: at.to, insert: text }, selection: { anchor: at.from, head: at.from + text.length }, userEvent: 'input.ai' });
    } else {
      const lineEnd = view.state.doc.lineAt(at.to).to;
      const insert = `\n\n${text}`;
      view.dispatch({ changes: { from: lineEnd, insert }, selection: { anchor: lineEnd + 2, head: lineEnd + insert.length }, userEvent: 'input.ai' });
    }
    setPhase({ kind: 'idle' });
    setInstruction('');
    view.focus();
  };

  if (phase.kind === 'idle' || !pos) {
    // 首次渲染需要先挂载以测量尺寸
    if (phase.kind === 'idle') return null;
  }

  const ACTIONS: { action: TransformAction; icon: typeof Wand2; label: string }[] = [
    { action: 'polish', icon: Wand2, label: t('ai.polish') },
    { action: 'translate', icon: Languages, label: t('ai.translate') },
    { action: 'shorten', icon: Shrink, label: t('ai.shorten') },
  ];
  const MORE: { action: TransformAction; icon: typeof Wand2; label: string }[] = [
    { action: 'expand', icon: Expand, label: t('ai.expand') },
    { action: 'grammar', icon: SpellCheck2, label: t('ai.grammar') },
    { action: 'explain', icon: BookOpenText, label: t('ai.explain') },
  ];
  const actionLabel = (a: TransformAction) =>
    [...ACTIONS, ...MORE].find((x) => x.action === a)?.label ?? t('ai.custom');

  const style = pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 };

  if (phase.kind === 'menu') {
    return (
      <div ref={box} className="sel-ai-menu" style={style} onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
        <span className="sel-ai-badge">
          <Sparkles size={13} />
        </span>
        {ACTIONS.map((a) => (
          <button key={a.action} className="sel-ai-btn" onClick={() => run(a.action, phase.range)}>
            <a.icon size={14} /> {a.label}
          </button>
        ))}
        <Dropdown
          trigger={(_o, toggle) => (
            <button className="sel-ai-btn" onClick={toggle}>
              {t('common.more')} <ChevronDown size={13} />
            </button>
          )}
        >
          {(closeMenu) =>
            MORE.map((a) => (
              <button key={a.action} className="menu-item" onClick={() => (closeMenu(), run(a.action, phase.range))}>
                <span className="menu-icon">
                  <a.icon size={15} />
                </span>
                <span className="menu-label">{a.label}</span>
              </button>
            ))
          }
        </Dropdown>
        <span className="sel-ai-sep" />
        <input
          className="sel-ai-input"
          placeholder={t('ai.askPlaceholder')}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && instruction.trim()) {
              e.preventDefault();
              run('custom', phase.range, instruction.trim());
            }
          }}
        />
        {instruction.trim() && (
          <button className="sel-ai-go" onClick={() => run('custom', phase.range, instruction.trim())} aria-label={t('chat.send')}>
            <CornerDownLeft size={13} />
          </button>
        )}
      </div>
    );
  }

  const running = phase.kind === 'running';
  const explain = phase.action === 'explain';
  return (
    <div ref={box} className={`sel-ai-card ${pos?.above ? 'above' : ''}`} style={style}>
      <div className="sel-ai-head">
        <Sparkles size={14} />
        <span className="sel-ai-title">{phase.action === 'custom' ? phase.instruction : actionLabel(phase.action)}</span>
        {running && <Loader2 size={13} className="spin" />}
        <span className="spacer" />
        <button className="icon-btn" onClick={close} aria-label={t('common.close')}>
          <X size={15} />
        </button>
      </div>
      <div className="sel-ai-body">
        {phase.kind === 'error' ? (
          <div className="form-error">{phase.error}</div>
        ) : explain ? (
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{phase.output || '…'}</ReactMarkdown>
          </div>
        ) : (
          <pre className="sel-ai-output">{phase.output || (running ? t('ai.generating') : '')}</pre>
        )}
      </div>
      <div className="sel-ai-foot">
        {!explain && (
          <>
            <button className="btn primary small" disabled={phase.kind !== 'done'} onClick={() => apply('replace')}>
              <Check size={13} /> {t('ai.replace')}
            </button>
            <button className="btn small" disabled={phase.kind !== 'done'} onClick={() => apply('below')}>
              <ArrowDownToLine size={13} /> {t('ai.insertBelow')}
            </button>
          </>
        )}
        <button
          className="btn small ghost"
          disabled={!phase.output}
          onClick={() => {
            navigator.clipboard?.writeText(phase.output);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? t('ai.copied') : t('ai.copy')}
        </button>
        <span className="spacer" />
        <button className="btn small ghost" disabled={running} onClick={() => run(phase.action, phase.range, phase.instruction)}>
          <RefreshCw size={13} /> {t('ai.retry')}
        </button>
      </div>
    </div>
  );
}
