import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { searchPanelOpen } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import {
  Bold, ChevronDown, Hash, ImagePlus, IndentDecrease, IndentIncrease, Italic, Link2, List, ListOrdered, Omega,
  Quote, Redo2, Search, Sigma, SquareFunction, Table, Undo2,
} from 'lucide-react';
import { useState } from 'react';
import { useT } from '../lib/i18n';
import {
  indentDecrease, indentIncrease, insertRef, insertTable, toggleBold, toggleBulletList, toggleItalic,
  toggleNumberedList, toggleSearch, wrapInDisplayMath, wrapInHref, wrapInInlineMath,
} from '../lib/overleaf/features/source-editor/extensions/toolbar/commands';
import { findCurrentSectionHeadingLevel, setSectionHeadingLevel } from '../lib/overleaf/features/source-editor/extensions/toolbar/sections';
import { ancestorListType } from '../lib/overleaf/features/source-editor/extensions/toolbar/lists';
import { Dropdown, IconButton, modKey } from './ui';

const LEVELS = ['text', 'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'] as const;

interface Props {
  /** 获取当前编辑器视图；工具栏随光标变化重新渲染（由父组件传入 tick） */
  getView: () => EditorView | null;
  tick: number;
  readOnly: boolean;
  onInsertFigure: () => void;
  onCite: () => void;
  symbolsOpen: boolean;
  onToggleSymbols: () => void;
}

/** 编辑器格式工具栏（命令移植自 Overleaf extensions/toolbar） */
export function EditorToolbar({ getView, readOnly, onInsertFigure, onCite, symbolsOpen, onToggleSymbols }: Props) {
  const t = useT();
  const view = getView();
  const run = (cmd: (v: EditorView) => boolean | void) => () => {
    const v = getView();
    if (!v) return;
    cmd(v);
    v.focus();
  };
  const state = view?.state;
  const section = state ? findCurrentSectionHeadingLevel(state)?.level ?? 'text' : 'text';
  const listType = state ? ancestorListType(state) : null;
  const disabled = !view || readOnly;

  return (
    <div className="editor-toolbar" onMouseDown={(e) => e.target !== e.currentTarget && e.preventDefault()}>
      <IconButton icon={Undo2} label={`${t('toolbar.undo')} (${modKey}+Z)`} size={16} disabled={disabled || !state || undoDepth(state) === 0} onClick={run(undo)} />
      <IconButton icon={Redo2} label={`${t('toolbar.redo')} (${modKey}+Shift+Z)`} size={16} disabled={disabled || !state || redoDepth(state) === 0} onClick={run(redo)} />
      <span className="tb-sep" />

      <Dropdown
        trigger={(_o, toggle) => (
          <button className="tb-select" onClick={toggle} disabled={disabled} title={t('toolbar.heading')}>
            <span>{t(`toolbar.level.${(LEVELS as readonly string[]).includes(section) ? (section as (typeof LEVELS)[number]) : 'text'}`)}</span>
            <ChevronDown size={13} />
          </button>
        )}
      >
        {(close) =>
          LEVELS.map((lv) => (
            <button
              key={lv}
              className={`menu-item heading-${lv} ${section === lv ? 'current' : ''}`}
              onClick={() => {
                close();
                const v = getView();
                if (v) {
                  setSectionHeadingLevel(v, lv);
                  v.focus();
                }
              }}
            >
              <span className="menu-label">{t(`toolbar.level.${lv}` as const)}</span>
            </button>
          ))
        }
      </Dropdown>
      <span className="tb-sep" />

      <IconButton icon={Bold} label={`${t('toolbar.bold')} (${modKey}+B)`} size={16} disabled={disabled} onClick={run(toggleBold)} />
      <IconButton icon={Italic} label={`${t('toolbar.italic')} (${modKey}+I)`} size={16} disabled={disabled} onClick={run(toggleItalic)} />
      <span className="tb-sep" />
      <IconButton icon={Sigma} label={t('toolbar.inlineMath')} size={16} disabled={disabled} onClick={run(wrapInInlineMath)} />
      <IconButton icon={SquareFunction} label={t('toolbar.displayMath')} size={16} disabled={disabled} onClick={run(wrapInDisplayMath)} />
      <IconButton icon={Omega} label={t('toolbar.symbols')} size={16} active={symbolsOpen} disabled={disabled} onClick={onToggleSymbols} />
      <span className="tb-sep" />
      <IconButton icon={Link2} label={t('toolbar.link')} size={16} disabled={disabled} onClick={run(wrapInHref)} />
      <IconButton icon={Hash} label={t('toolbar.ref')} size={16} disabled={disabled} onClick={run(insertRef)} />
      <IconButton icon={Quote} label={t('toolbar.cite')} size={16} disabled={disabled} onClick={onCite} />
      <span className="tb-sep" />
      <IconButton icon={ImagePlus} label={t('toolbar.figure')} size={16} disabled={disabled} onClick={onInsertFigure} />
      <TablePicker disabled={disabled} onPick={(cols, rows) => run((v) => insertTable(v, cols, rows))()} />
      <span className="tb-sep" />
      <IconButton icon={List} label={t('toolbar.bulletList')} size={16} active={listType === 'itemize'} disabled={disabled} onClick={run(toggleBulletList)} />
      <IconButton icon={ListOrdered} label={t('toolbar.numberedList')} size={16} active={listType === 'enumerate'} disabled={disabled} onClick={run(toggleNumberedList)} />
      <IconButton icon={IndentDecrease} label={t('toolbar.outdent')} size={16} disabled={disabled || !listType} onClick={run(indentDecrease)} />
      <IconButton icon={IndentIncrease} label={t('toolbar.indent')} size={16} disabled={disabled || !listType} onClick={run(indentIncrease)} />
      <span className="spacer" />
      <IconButton
        icon={Search}
        label={`${t('toolbar.find')} (${modKey}+F)`}
        size={16}
        active={!!state && searchPanelOpen(state)}
        disabled={!view}
        onClick={run(toggleSearch)}
      />
    </div>
  );
}

/** 表格尺寸选择：鼠标划过网格选择列数 × 行数 */
function TablePicker({ disabled, onPick }: { disabled: boolean; onPick: (cols: number, rows: number) => void }) {
  const t = useT();
  const [hover, setHover] = useState<[number, number]>([0, 0]);
  const MAX = 10;
  return (
    <Dropdown
      trigger={(_o, toggle) => <IconButton icon={Table} label={t('toolbar.table')} size={16} disabled={disabled} onClick={toggle} />}
    >
      {(close) => (
        <div className="table-picker" onMouseLeave={() => setHover([0, 0])}>
          <div className="table-picker-label">
            {hover[0] ? t('toolbar.tableSize', { cols: hover[0], rows: hover[1] }) : t('toolbar.tablePick')}
          </div>
          <div className="table-picker-grid" style={{ gridTemplateColumns: `repeat(${MAX}, 1fr)` }}>
            {Array.from({ length: MAX * MAX }, (_, i) => {
              const c = (i % MAX) + 1;
              const r = Math.floor(i / MAX) + 1;
              return (
                <span
                  key={i}
                  className={`tp-cell ${c <= hover[0] && r <= hover[1] ? 'on' : ''}`}
                  onMouseEnter={() => setHover([c, r])}
                  onClick={() => {
                    close();
                    onPick(c, r);
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </Dropdown>
  );
}
