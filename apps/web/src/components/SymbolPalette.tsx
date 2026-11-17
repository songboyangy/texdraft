import katex from 'katex';
import { Search, X } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useT } from '../lib/i18n';
import { SYMBOL_CATEGORIES, type SymbolCategory, type SymbolDef } from '../lib/symbols';
import { IconButton } from './ui';

const SymbolGlyph = memo(function SymbolGlyph({ command }: { command: string }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(command, { throwOnError: false, strict: 'ignore' });
    } catch {
      return command;
    }
  }, [command]);
  return <span className="symbol-glyph" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** 符号面板：按类别浏览或搜索（中英文关键词），点击插入到光标处 */
export function SymbolPalette({ onInsert, onClose }: { onInsert: (command: string) => void; onClose: () => void }) {
  const t = useT();
  const [cat, setCat] = useState<SymbolCategory['id']>('greek');
  const [query, setQuery] = useState('');

  const shown: SymbolDef[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SYMBOL_CATEGORIES.find((c) => c.id === cat)!.symbols;
    return SYMBOL_CATEGORIES.flatMap((c) => c.symbols).filter(([cmd, kw]) => cmd.toLowerCase().includes(q) || kw.toLowerCase().includes(q));
  }, [cat, query]);

  return (
    <div className="symbol-palette">
      <div className="symbol-head">
        <div className="segmented small">
          {SYMBOL_CATEGORIES.map((c) => (
            <button key={c.id} className={!query && cat === c.id ? 'on' : ''} onClick={() => { setCat(c.id); setQuery(''); }}>
              {t(`symbols.${c.id}` as const)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="search-input small">
          <Search size={13} />
          <input placeholder={t('symbols.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <IconButton icon={X} label={t('common.close')} onClick={onClose} size={15} />
      </div>
      <div className="symbol-grid">
        {shown.map(([cmd, kw, pkg]) => (
          <button
            key={cmd}
            className="symbol-cell"
            title={`${cmd}${pkg ? `  (\\usepackage{${pkg}})` : ''}\n${kw}`}
            onClick={() => onInsert(cmd)}
          >
            <SymbolGlyph command={cmd} />
          </button>
        ))}
        {shown.length === 0 && <div className="muted small pad">{t('symbols.noMatch')}</div>}
      </div>
    </div>
  );
}
