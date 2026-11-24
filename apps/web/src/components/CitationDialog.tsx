import type { CitationSearchResult, ProjectSymbols } from '@texdraft/shared';
import type { EditorView } from '@codemirror/view';
import { BookMarked, ExternalLink, Globe, Library, Loader2, Plus, Quote, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { IconButton } from './ui';

type Tab = 'project' | 'online';

/** 在光标处插入引用：光标已在 \cite{…} 中则追加键，否则插入新的 \cite{key} */
export function insertCitationKey(view: EditorView, key: string) {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const inside = /\\(?:cite[a-zA-Z]*|parencite|textcite|autocite|footcite|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/.exec(before);
  let insert: string;
  if (inside) {
    const typed = inside[1];
    insert = typed.trim() === '' || typed.trimEnd().endsWith(',') ? key : `,${key}`;
  } else {
    insert = `\\cite{${key}}`;
  }
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, userEvent: 'input.cite' });
  view.focus();
}

function authorsLine(authors: string[], etAl: string) {
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')} ${etAl}`;
}

export function CitationDialog({
  projectId,
  view,
  getSymbols,
  onClose,
  onToast,
}: {
  projectId: string;
  view: EditorView;
  getSymbols: () => Promise<ProjectSymbols | null>;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('project');
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<ProjectSymbols['citations']>([]);
  const [online, setOnline] = useState<CitationSearchResult[] | null>(null);
  const [onlineErrors, setOnlineErrors] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [needsBib, setNeedsBib] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getSymbols().then((s) => {
      const list = s?.citations ?? [];
      setLocal(list);
      if (!list.length) setTab('online');
    });
  }, [getSymbols]);
  useEffect(() => input.current?.focus(), [tab]);

  const localShown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return local;
    return local.filter((c) => [c.key, c.title, c.author].some((v) => v?.toLowerCase().includes(q)));
  }, [local, query]);

  const searchOnline = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setError('');
    try {
      const r = await api.citationSearch(projectId, q);
      setOnline(r.results);
      setOnlineErrors(r.errors);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const citeLocal = (key: string) => {
    insertCitationKey(view, key);
    onClose();
  };

  const citeOnline = async (r: CitationSearchResult) => {
    setAdding(r.id);
    setError('');
    try {
      const res = await api.addCitation(projectId, r);
      insertCitationKey(view, res.key);
      onToast(res.added ? t('cite.added', { key: res.key, file: res.bibPath }) : t('cite.exists', { key: res.key }));
      if (res.needsBibliography) setNeedsBib(true);
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(null);
    }
  };

  const addBibliography = async () => {
    try {
      const r = await api.addBibliography(projectId);
      onToast(t('cite.bibAdded', { file: r.mainFile }));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide cite-dialog" role="dialog">
        <div className="modal-head">
          <div className="modal-title with-icon">
            <Quote size={17} /> {t('cite.title')}
          </div>
          <IconButton icon={X} label={t('common.close')} onClick={onClose} />
        </div>

        <div className="segmented">
          <button className={tab === 'project' ? 'on' : ''} onClick={() => setTab('project')}>
            <Library size={14} /> {t('cite.project')} {local.length > 0 && <span className="count-badge">{local.length}</span>}
          </button>
          <button className={tab === 'online' ? 'on' : ''} onClick={() => setTab('online')}>
            <Globe size={14} /> {t('cite.online')}
          </button>
        </div>

        <div className="search-row">
          <label className="search-input grow">
            <Search size={15} />
            <input
              ref={input}
              value={query}
              placeholder={tab === 'project' ? t('cite.filterPlaceholder') : t('cite.searchPlaceholder')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (tab === 'online') searchOnline();
                  else if (localShown[0]) citeLocal(localShown[0].key);
                }
              }}
            />
          </label>
          {tab === 'online' && (
            <button className="btn primary" onClick={searchOnline} disabled={searching || query.trim().length < 2}>
              {searching ? <Loader2 size={15} className="spin" /> : <Search size={15} />} {t('cite.search')}
            </button>
          )}
        </div>

        {needsBib && (
          <div className="notice">
            <BookMarked size={16} />
            <span>{t('cite.needsBib')}</span>
            <span className="spacer" />
            <button className="btn small" onClick={addBibliography}>
              {t('cite.addBib')}
            </button>
            <button className="btn small ghost" onClick={onClose}>
              {t('cite.later')}
            </button>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}

        <div className="cite-results">
          {tab === 'project' ? (
            localShown.length === 0 ? (
              <div className="cite-empty">
                {local.length === 0 ? t('cite.noLocal') : t('cite.noMatch')}
                {local.length === 0 && (
                  <button className="link" onClick={() => setTab('online')}>
                    {t('cite.goOnline')}
                  </button>
                )}
              </div>
            ) : (
              localShown.map((c) => (
                <button key={c.key} className="cite-row" onClick={() => citeLocal(c.key)}>
                  <div className="cite-main">
                    <div className="cite-title">{c.title || c.key}</div>
                    <div className="cite-meta">
                      <code>{c.key}</code>
                      {c.author && <span>{c.author}</span>}
                    </div>
                  </div>
                  <span className="cite-action">
                    <Quote size={13} /> {t('cite.cite')}
                  </span>
                </button>
              ))
            )
          ) : online === null ? (
            <div className="cite-empty">{t('cite.onlineHint')}</div>
          ) : online.length === 0 ? (
            <div className="cite-empty">{onlineErrors.length ? t('cite.onlineFailed', { error: onlineErrors.join('; ') }) : t('cite.noMatch')}</div>
          ) : (
            online.map((r) => (
              <div key={`${r.source}:${r.id}`} className="cite-row">
                <div className="cite-main">
                  <div className="cite-title">
                    {r.title}
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noreferrer" className="cite-link" title={r.url} onClick={(e) => e.stopPropagation()}>
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                  <div className="cite-meta">
                    <span className={`source-badge ${r.source}`}>{r.source === 'arxiv' ? 'arXiv' : r.source === 'openalex' ? 'OpenAlex' : 'Crossref'}</span>
                    {r.year && <span>{r.year}</span>}
                    {r.authors.length > 0 && <span>{authorsLine(r.authors, t('cite.etAl'))}</span>}
                    {r.venue && r.source !== 'arxiv' && <span className="cite-venue">{r.venue}</span>}
                  </div>
                </div>
                <button className="btn small" disabled={adding !== null} onClick={() => citeOnline(r)}>
                  {adding === r.id ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} {t('cite.addAndCite')}
                </button>
              </div>
            ))
          )}
        </div>
        {tab === 'online' && onlineErrors.length > 0 && online && online.length > 0 && (
          <div className="muted small">{t('cite.partialFailure', { error: onlineErrors.join('; ') })}</div>
        )}
      </div>
    </div>
  );
}
