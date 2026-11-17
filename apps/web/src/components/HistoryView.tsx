import type { VersionDiff, VersionKind, VersionSummary } from '@texdraft/shared';
import { Bookmark, BookmarkPlus, Clock3, History, ListOrdered, Loader2, RotateCcw, Sparkles, Undo2, X } from 'lucide-react';
import { EditLogDialog } from './EditLogDialog';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useI18n } from '../lib/i18n';
import { fileIcon } from './FileTree';
import { IconButton } from './ui';

const KIND_ICON: Record<VersionKind, LucideIcon> = { checkpoint: Sparkles, manual: Bookmark, auto: Clock3, restore: Undo2 };

/** 检查点标签形如 “AI: 指令” / “Claude Code: 指令” / “MCP: 令牌名”，拆成执行者与指令 */
function parseCheckpointLabel(label: string | null) {
  const m = /^(AI|Claude Code|Codex|Gemini|MCP): ?([\s\S]*)$/.exec(label ?? '');
  return m ? { actor: m[1], detail: m[2].trim() } : { actor: 'AI', detail: label ?? '' };
}

const basename = (p: string) => p.split('/').pop() ?? p;

/** 解析 unified diff，得到带新旧行号的行 */
function parsePatch(patch: string) {
  const rows: { type: 'hunk' | 'add' | 'del' | 'ctx'; text: string; old?: number; new?: number }[] = [];
  let o = 0;
  let n = 0;
  for (const line of patch.split('\n').slice(4)) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      rows.push({ type: 'hunk', text: line });
    } else if (line.startsWith('+')) rows.push({ type: 'add', text: line.slice(1), new: n++ });
    else if (line.startsWith('-')) rows.push({ type: 'del', text: line.slice(1), old: o++ });
    else if (line.startsWith(' ')) rows.push({ type: 'ctx', text: line.slice(1), old: o++, new: n++ });
    else if (line.startsWith('\\')) continue;
  }
  return rows;
}

export function HistoryView({
  projectId,
  canEdit,
  onClose,
  onToast,
}: {
  projectId: string;
  canEdit: boolean;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const { t, locale } = useI18n();
  const dialog = useDialog();
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [logOpen, setLogOpen] = useState(false);

  const loadVersions = useCallback(async () => {
    const list = await api.versions(projectId);
    setVersions(list);
    return list;
  }, [projectId]);

  useEffect(() => {
    loadVersions().then((list) => setSelected((s) => s ?? list[0]?.id ?? null), (e) => setError(e.message));
  }, [loadVersions]);

  const loadDiff = useCallback(
    async (vid: string) => {
      setDiffLoading(true);
      setError('');
      try {
        const d = await api.versionDiff(projectId, vid);
        setDiff(d);
        const changed = d.files.filter((f) => f.status !== 'unchanged');
        setFile((cur) => (cur && changed.some((f) => f.path === cur) ? cur : changed[0]?.path ?? null));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setDiffLoading(false);
      }
    },
    [projectId],
  );
  useEffect(() => {
    if (selected) loadDiff(selected);
  }, [selected, loadDiff]);

  const label = (v: VersionSummary) =>
    v.kind === 'checkpoint'
      ? t('history.beforeEdit', { actor: parseCheckpointLabel(v.label).actor })
      : v.label ||
    { checkpoint: t('history.kind.checkpoint'), manual: t('history.kind.manual'), auto: t('history.kind.auto'), restore: t('history.kind.restore') }[v.kind];

  /** 列表第二行：检查点显示指令原文 + 这次运行改了哪些文件 */
  const detail = (v: VersionSummary) => {
    if (v.kind !== 'checkpoint') return null;
    const { detail: prompt } = parseCheckpointLabel(v.label);
    const ch = v.run?.changes ?? [];
    const first = ch[0];
    return (
      <>
        {prompt && <span className="timeline-prompt">{prompt}</span>}
        {first && (
          <span className={`timeline-changes ${v.run?.reverted ? 'reverted' : ''}`}>
            {ch.length === 1 ? basename(first.path) : t('history.runFiles', { file: basename(first.path), count: ch.length })}
            {ch.length === 1 && (
              <>
                {' '}
                <span className="add">+{first.additions}</span> <span className="del">−{first.deletions}</span>
              </>
            )}
            {v.run?.reverted && ` · ${t('history.reverted')}`}
          </span>
        )}
      </>
    );
  };

  const grouped = useMemo(() => {
    const out: { day: string; items: VersionSummary[] }[] = [];
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    for (const v of versions ?? []) {
      const d = new Date(v.createdAt);
      const key = d.toDateString();
      const day = key === today ? t('history.today') : key === yesterday ? t('history.yesterday') : d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
      if (out.at(-1)?.day !== day) out.push({ day, items: [] });
      out.at(-1)!.items.push(v);
    }
    return out;
  }, [versions, locale, t]);

  const saveVersion = async () => {
    const name = await dialog.prompt(t('history.saveTitle'), '', t('history.savePlaceholder'));
    if (name === null) return;
    try {
      const r = await api.createVersion(projectId, name.trim() || undefined);
      await loadVersions();
      setSelected(r.id);
      onToast(t('history.saved'));
    } catch (e) {
      dialog.alert(t('common.failed'), (e as Error).message);
    }
  };

  const current = versions?.find((v) => v.id === selected);
  const restore = async (paths?: string[]) => {
    if (!current) return;
    const when = new Date(current.createdAt).toLocaleString(locale);
    const ok = await dialog.confirm(paths ? t('history.restoreFileConfirm', { file: paths[0] }) : t('history.restoreAllConfirm'), {
      message: t('history.restoreWarning', { when }),
      confirmText: t('history.restore'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.restoreVersion(projectId, current.id, paths, t('history.restoreLabel', { label: label(current), when }));
      onToast(t('history.restored', { count: r.changed }));
      await loadVersions();
      await loadDiff(current.id);
    } catch (e) {
      dialog.alert(t('common.failed'), (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changed = diff?.files.filter((f) => f.status !== 'unchanged') ?? [];
  const unchangedCount = (diff?.files.length ?? 0) - changed.length;
  const active = changed.find((f) => f.path === file);
  const rows = useMemo(() => (active && !active.binary ? parsePatch(active.patch) : []), [active]);

  return (
    <div className="history-view">
      <aside className="history-timeline">
        <div className="panel-head">
          <span className="panel-title with-icon">
            <History size={14} /> {t('history.title')}
          </span>
          <span className="spacer" />
          {canEdit && <IconButton icon={ListOrdered} label={t('editLog.title')} onClick={() => setLogOpen(true)} size={15} />}
          <IconButton icon={X} label={t('history.close')} onClick={onClose} size={15} />
        </div>
        {logOpen && <EditLogDialog projectId={projectId} onClose={() => setLogOpen(false)} />}
        {canEdit && (
          <div className="history-save">
            <button className="btn small block" onClick={saveVersion}>
              <BookmarkPlus size={14} /> {t('history.save')}
            </button>
          </div>
        )}
        <div className="timeline-body">
          {versions === null && <div className="muted small pad">{t('common.loading')}</div>}
          {versions?.length === 0 && <div className="muted small pad">{t('history.empty')}</div>}
          {grouped.map((g) => (
            <div key={g.day} className="timeline-group">
              <div className="timeline-day">{g.day}</div>
              {g.items.map((v) => {
                const Icon = KIND_ICON[v.kind];
                return (
                  <button key={v.id} className={`timeline-item ${v.id === selected ? 'on' : ''} kind-${v.kind}`} onClick={() => setSelected(v.id)}>
                    <span className="timeline-icon">
                      <Icon size={13} />
                    </span>
                    <span className="timeline-text">
                      <span className="timeline-label">{label(v)}</span>
                      {detail(v)}
                      <span className="timeline-meta">
                        {new Date(v.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                        {v.author && ` · ${v.author}`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      <section className="history-main">
        <div className="history-head">
          {current ? (
            <>
              <div className="history-head-text">
                <div className="history-head-title">
                  {label(current)}
                  {current.kind === 'checkpoint' && parseCheckpointLabel(current.label).detail && (
                    <span className="history-head-prompt"> · {parseCheckpointLabel(current.label).detail}</span>
                  )}
                </div>
                <div className="muted small">{t('history.compareHint', { when: new Date(current.createdAt).toLocaleString(locale) })}</div>
              </div>
              <span className="spacer" />
              {canEdit && (
                <button className="btn small" disabled={busy || changed.length === 0} onClick={() => restore()}>
                  {busy ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} {t('history.restoreAll')}
                </button>
              )}
            </>
          ) : (
            <div className="muted small">{t('history.pick')}</div>
          )}
        </div>
        {error && <div className="form-error pad">{error}</div>}
        <div className="history-body">
          <div className="history-files">
            {diffLoading && <div className="muted small pad">{t('common.loading')}</div>}
            {!diffLoading && diff && changed.length === 0 && <div className="history-same">{t('history.noChanges')}</div>}
            {changed.map((f) => {
              const { Icon, cls } = fileIcon(f.path);
              return (
                <button key={f.path} className={`history-file ${f.path === file ? 'on' : ''}`} onClick={() => setFile(f.path)}>
                  <Icon size={14} className={`file-icon ${cls}`} />
                  <span className="history-file-path">{f.path}</span>
                  <span className={`status-tag ${f.status}`}>{t(`history.status.${f.status as 'added' | 'removed' | 'modified'}`)}</span>
                  {!f.binary && (
                    <span className="history-counts">
                      <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                    </span>
                  )}
                </button>
              );
            })}
            {diff && unchangedCount > 0 && <div className="muted small pad">{t('history.unchanged', { count: unchangedCount })}</div>}
          </div>
          <div className="history-diff">
            {active ? (
              <>
                <div className="diff-head">
                  <span className="diff-path">{active.path}</span>
                  <span className="spacer" />
                  {canEdit && (
                    <button className="btn small ghost" disabled={busy} onClick={() => restore([active.path])}>
                      <RotateCcw size={13} /> {active.status === 'added' ? t('history.removeFile') : t('history.restoreFile')}
                    </button>
                  )}
                </div>
                {active.binary ? (
                  <div className="muted pad">{t('history.binaryChanged')}</div>
                ) : (
                  <div className="diff-table">
                    {rows.map((r, i) =>
                      r.type === 'hunk' ? (
                        <div key={i} className="diff-row hunk">
                          <span className="ln" />
                          <span className="ln" />
                          <span className="code">{r.text}</span>
                        </div>
                      ) : (
                        <div key={i} className={`diff-row ${r.type}`}>
                          <span className="ln">{r.old ?? ''}</span>
                          <span className="ln">{r.new ?? ''}</span>
                          <span className="code">
                            <span className="sign">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
                            {r.text || ' '}
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="history-placeholder">
                <History size={28} />
                <p>{changed.length ? t('history.pickFile') : diff ? t('history.nothingToRestore') : t('history.pick')}</p>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
