import type { SearchMatch } from '@texdraft/shared';
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, Search, WholeWord } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useT } from '../lib/i18n';
import { fileIcon } from './FileTree';

/** 全项目搜索 / 替换（侧边栏“搜索”标签页） */
export function ProjectSearch({
  projectId,
  canEdit,
  onOpen,
}: {
  projectId: string;
  canEdit: boolean;
  onOpen: (path: string, line: number) => void;
}) {
  const t = useT();
  const dialog = useDialog();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [opts, setOpts] = useState({ caseSensitive: false, wholeWord: false, regex: false });
  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const run = async (q = query) => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api.search(projectId, { query: q, ...opts });
      setResults(r.results);
      setTruncated(r.truncated);
    } catch (e) {
      setError((e as Error).message);
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  // 输入停顿后自动搜索
  useEffect(() => {
    const h = setTimeout(() => run(), 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts]);

  const grouped = useMemo(() => {
    const m = new Map<string, SearchMatch[]>();
    for (const r of results ?? []) {
      if (!m.has(r.path)) m.set(r.path, []);
      m.get(r.path)!.push(r);
    }
    return [...m];
  }, [results]);

  const replaceAll = async () => {
    if (!results?.length) return;
    const ok = await dialog.confirm(t('search.replaceConfirm', { count: results.length, files: grouped.length }), {
      message: t('search.replaceWarning', { query, replacement }),
      confirmText: t('search.replaceAll'),
    });
    if (!ok) return;
    try {
      const r = await api.replaceAll(projectId, { query, replacement, ...opts });
      await dialog.alert(t('search.replaced', { count: r.replaced, files: r.files }));
      run();
    } catch (e) {
      dialog.alert(t('search.replaceFailed'), (e as Error).message);
    }
  };

  const Toggle = ({ k, icon: Icon, label }: { k: keyof typeof opts; icon: typeof Regex; label: string }) => (
    <button className={`opt-toggle ${opts[k] ? 'on' : ''}`} title={label} aria-pressed={opts[k]} onClick={() => setOpts((o) => ({ ...o, [k]: !o[k] }))}>
      <Icon size={15} />
    </button>
  );

  return (
    <div className="project-search">
      <div className="search-form">
        <div className="search-row">
          {canEdit && (
            <button className="opt-toggle" onClick={() => setShowReplace(!showReplace)} title={t('search.toggleReplace')}>
              {showReplace ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          <label className="search-input grow">
            <Search size={14} />
            <input
              ref={input}
              placeholder={t('search.placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && run()}
            />
            <Toggle k="caseSensitive" icon={CaseSensitive} label={t('search.caseSensitive')} />
            <Toggle k="wholeWord" icon={WholeWord} label={t('search.wholeWord')} />
            <Toggle k="regex" icon={Regex} label={t('search.regex')} />
          </label>
        </div>
        {showReplace && canEdit && (
          <div className="search-row indent">
            <label className="search-input grow">
              <Replace size={14} />
              <input placeholder={t('search.replacePlaceholder')} value={replacement} onChange={(e) => setReplacement(e.target.value)} />
            </label>
            <button className="btn small" disabled={!results?.length} onClick={replaceAll}>
              {t('search.replaceAll')}
            </button>
          </div>
        )}
      </div>
      <div className="search-summary muted small">
        {error ? (
          <span className="error-text">{error}</span>
        ) : busy ? (
          t('search.searching')
        ) : results ? (
          t('search.summary', { count: results.length, files: grouped.length }) + (truncated ? ` ${t('search.truncated')}` : '')
        ) : (
          t('search.hint')
        )}
      </div>
      <div className="search-results">
        {grouped.map(([path, matches]) => {
          const open = !collapsed.has(path);
          const { Icon, cls } = fileIcon(path);
          return (
            <div key={path} className="search-group">
              <div
                className="search-file"
                onClick={() =>
                  setCollapsed((s) => {
                    const n = new Set(s);
                    if (open) n.add(path);
                    else n.delete(path);
                    return n;
                  })
                }
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Icon size={14} className={`file-icon ${cls}`} />
                <span className="search-path">{path}</span>
                <span className="count-badge">{matches.length}</span>
              </div>
              {open &&
                matches.map((m, i) => (
                  <div key={i} className="search-hit" onClick={() => onOpen(m.path, m.line)} title={`${m.path}:${m.line}`}>
                    <span className="hit-line">{m.line}</span>
                    <span className="hit-text">
                      {m.preview.slice(0, m.previewOffset)}
                      <mark>{m.preview.slice(m.previewOffset, m.previewOffset + m.length)}</mark>
                      {m.preview.slice(m.previewOffset + m.length)}
                    </span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
