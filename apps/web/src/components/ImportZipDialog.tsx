import { FileArchive, FolderUp, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { IconButton } from './ui';

const MAX_BYTES = 50 * 1024 * 1024; // 与服务端 maxUploadBytes 一致

const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';
const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** 上传项目：把 zip 拖进虚线框或点击选择，然后点「上传」导入为新项目 */
export function ImportZipDialog({ onClose, onImport }: { onClose: () => void; onImport: (file: File) => Promise<void> }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const pick = (files: FileList | null | undefined) => {
    const f = files?.[0];
    if (!f) return;
    if (files!.length > 1) return setError(t('importZip.oneFile'));
    if (!isZip(f)) return setError(t('importZip.notZip', { name: f.name }));
    if (f.size > MAX_BYTES) return setError(t('importZip.tooBig', { size: sizeText(f.size) }));
    setError('');
    setFile(f);
  };

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      await onImport(file);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal import-zip-dialog" role="dialog" aria-labelledby="import-zip-title">
        <div className="modal-head">
          <div className="modal-title with-icon" id="import-zip-title">
            <FolderUp size={17} /> {t('importZip.title')}
          </div>
          <IconButton icon={X} label={t('common.close')} onClick={onClose} disabled={busy} />
        </div>
        <p className="muted small import-zip-desc">{t('projects.importHint')}</p>

        <button
          type="button"
          className={`dropzone ${over ? 'over' : ''} ${file ? 'has-file' : ''}`}
          disabled={busy}
          onClick={() => input.current?.click()}
          onDragEnter={(e) => (e.preventDefault(), setOver(true))}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (!busy) pick(e.dataTransfer.files);
          }}
        >
          <FileArchive size={30} className="dropzone-icon" />
          {file ? (
            <>
              <strong className="dropzone-name">{file.name}</strong>
              <span className="muted small">
                {sizeText(file.size)} · {t('importZip.change')}
              </span>
            </>
          ) : (
            <>
              <strong>{t('importZip.dropTitle')}</strong>
              <span className="muted small">{t('importZip.dropDesc')}</span>
            </>
          )}
        </button>
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = '';
          }}
        />
        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={upload} disabled={!file || busy}>
            {busy ? <Loader2 size={14} className="spin" /> : null} {busy ? t('projects.importing') : t('importZip.upload')}
          </button>
        </div>
      </div>
    </div>
  );
}
