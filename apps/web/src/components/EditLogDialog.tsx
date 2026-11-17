import { ListOrdered, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type EditLogEntry } from '../lib/api';
import { formatRelative, useI18n } from '../lib/i18n';
import { IconButton } from './ui';

/** 服务端来源 → 给人看的说明 */
function originLabel(origin: string | null, t: ReturnType<typeof useI18n>['t']) {
  if (!origin) return t('editLog.origin.server');
  if (origin.startsWith('agent:mcp:')) return t('editLog.origin.mcp');
  if (origin.startsWith('agent:')) return t('editLog.origin.agent');
  if (origin.startsWith('revert:')) return t('editLog.origin.revert');
  if (origin.startsWith('restore:')) return t('editLog.origin.restore');
  if (origin === 'upload') return t('editLog.origin.upload');
  if (origin === 'citation') return t('editLog.origin.citation');
  if (origin === 'replace-all') return t('editLog.origin.replace');
  if (origin === 'copy-project' || origin === 'mcp-copy') return t('editLog.origin.copy');
  if (origin.startsWith('mcp-apply-patch')) return t('editLog.origin.patch');
  return origin;
}

/** 浏览器上报的操作类型（CodeMirror userEvent）→ 说明 */
function opLabel(events: string, t: ReturnType<typeof useI18n>['t']) {
  return events
    .split(',')
    .map((e) => {
      if (e === 'delete.line') return t('editLog.op.deleteLine');
      if (e.startsWith('delete.cut')) return t('editLog.op.cut');
      if (e.startsWith('delete.selection')) return t('editLog.op.deleteSelection');
      if (e.startsWith('delete')) return t('editLog.op.delete');
      if (e === 'undo' || e === 'redo') return t(`editLog.op.${e}` as 'editLog.op.undo');
      if (e.startsWith('input.paste')) return t('editLog.op.paste');
      if (e.startsWith('input.ai')) return t('editLog.op.ai');
      if (e.startsWith('input') || e.startsWith('move')) return t('editLog.op.input');
      return e;
    })
    .join('、');
}

/** 编辑记录：谁、何时、通过什么方式改了哪个文件的哪几行（只有元数据，没有内容） */
export function EditLogDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<EditLogEntry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.editLog(projectId).then(setRows, (e) => setError((e as Error).message));
  }, [projectId]);

  const lines = (r: EditLogEntry) =>
    r.fromLine == null ? '' : r.fromLine === r.toLine ? t('editLog.line', { n: r.fromLine }) : t('editLog.lines', { from: r.fromLine, to: r.toLine ?? r.fromLine });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide edit-log-dialog" role="dialog">
        <div className="modal-head">
          <div className="modal-title with-icon">
            <ListOrdered size={17} /> {t('editLog.title')}
          </div>
          <IconButton icon={X} label={t('common.close')} onClick={onClose} />
        </div>
        <p className="muted small">{t('editLog.desc')}</p>
        {error && <div className="form-error">{error}</div>}
        {!rows && !error && (
          <div className="muted small">
            <Loader2 size={14} className="spin" /> {t('common.loading')}
          </div>
        )}
        {rows && rows.length === 0 && <div className="muted small">{t('editLog.empty')}</div>}
        {rows && rows.length > 0 && (
          <div className="edit-log-list">
            {rows.map((r) => (
              <div key={r.id} className="edit-log-row">
                <span className="edit-log-time" title={new Date(r.endedAt).toLocaleString(locale)}>
                  {formatRelative(r.endedAt, locale)}
                </span>
                <span className={`edit-log-who ${r.source}`} title={r.source === 'editor' && r.origin ? r.origin : undefined}>
                  {r.source === 'editor' ? r.userName ?? t('editLog.unknownUser') : originLabel(r.origin, t)}
                  {r.source === 'editor' && r.origin && <span className="edit-log-op"> · {opLabel(r.origin, t)}</span>}
                </span>
                <span className="edit-log-where">
                  {r.path ?? t('editLog.deletedFile')}
                  {lines(r) && <span className="muted"> · {lines(r)}</span>}
                </span>
                <span className="edit-log-delta">
                  {r.insertedChars > 0 && <span className="add">+{r.insertedChars}</span>}
                  {r.deletedChars > 0 && <span className="del">−{r.deletedChars}</span>}
                  {(r.insertedLines > 0 || r.deletedLines > 0) && (
                    <span className="muted"> {t('editLog.lineDelta', { add: r.insertedLines, del: r.deletedLines })}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
