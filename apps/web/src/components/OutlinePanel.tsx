import { ChevronDown, ChevronRight, ListTree } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useT } from '../lib/i18n';
import type { OutlineEntry } from '../lib/latexLanguage';
import { nestOutline, type Outline } from '../lib/overleaf/features/source-editor/utils/tree-operations/outline';

interface Props {
  outline: OutlineEntry[];
  cursorLine: number;
  open: boolean;
  onToggle: () => void;
  onJump: (line: number) => void;
}

/** 文件大纲：当前文件的章节结构，点击跳转；高亮光标所在章节（参照 Overleaf 的 File outline） */
export function OutlinePanel({ outline, cursorLine, open, onToggle, onJump }: Props) {
  const t = useT();
  const tree = useMemo(() => nestOutline(outline), [outline]);
  // 光标所在的章节 = 起始行不超过光标行的最后一个条目
  const activeLine = useMemo(() => {
    let line = -1;
    for (const o of outline) if (o.line <= cursorLine) line = o.line;
    return line;
  }, [outline, cursorLine]);

  return (
    <div className={`outline-panel ${open ? 'open' : ''}`}>
      <div className="panel-head clickable" onClick={onToggle}>
        <span className="panel-title with-icon">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <ListTree size={14} /> {t('outline.title')}
        </span>
      </div>
      {open && (
        <div className="outline-body">
          {tree.length === 0 ? (
            <div className="muted small pad">{t('outline.empty')}</div>
          ) : (
            <OutlineList items={tree} depth={0} activeLine={activeLine} onJump={onJump} />
          )}
        </div>
      )}
    </div>
  );
}

function OutlineList({ items, depth, activeLine, onJump }: { items: Outline[]; depth: number; activeLine: number; onJump: (line: number) => void }) {
  return (
    <ul className="outline-list">
      {items.map((item) => (
        <OutlineItem key={`${item.line}-${item.title}`} item={item} depth={depth} activeLine={activeLine} onJump={onJump} />
      ))}
    </ul>
  );
}

function OutlineItem({ item, depth, activeLine, onJump }: { item: Outline; depth: number; activeLine: number; onJump: (line: number) => void }) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const hasChildren = !!item.children?.length;
  return (
    <li>
      <div
        className={`outline-row ${item.line === activeLine ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onJump(item.line)}
        title={t('outline.line', { line: item.line })}
      >
        <span
          className="outline-caret"
          onClick={(e) => {
            if (!hasChildren) return;
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          {hasChildren ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
        </span>
        <span className="outline-title">{item.title || t('outline.untitled')}</span>
      </div>
      {hasChildren && expanded && <OutlineList items={item.children!} depth={depth + 1} activeLine={activeLine} onJump={onJump} />}
    </li>
  );
}
