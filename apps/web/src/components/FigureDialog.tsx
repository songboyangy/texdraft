import { snippet } from '@codemirror/autocomplete';
import type { FileEntry } from '@texdraft/shared';
import type { EditorView } from '@codemirror/view';
import { Image as ImageIcon, Upload, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { ensureEmptyLine } from '../lib/overleaf/features/source-editor/extensions/toolbar/commands';
import { IconButton } from './ui';

const IMAGE = /\.(png|jpe?g|pdf|eps|svg|gif)$/i;

/** 插入图片：从项目中选择或上传，设置宽度、标题、标签后插入 figure 环境 */
export function FigureDialog({
  projectId,
  files,
  view,
  onClose,
  onUploaded,
}: {
  projectId: string;
  files: FileEntry[];
  view: EditorView;
  onClose: () => void;
  onUploaded: () => Promise<unknown>;
}) {
  const t = useT();
  const images = useMemo(() => files.filter((f) => f.kind === 'binary' && IMAGE.test(f.path)), [files]);
  const [selected, setSelected] = useState(images[0]?.path ?? '');
  const [width, setWidth] = useState(0.8);
  const [caption, setCaption] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = async (list: FileList) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.upload(projectId, list, 'figures');
      await onUploaded();
      if (res[0]) setSelected(res[0].path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const insert = () => {
    if (!selected) return;
    const base = selected.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const lbl = (label.trim() || `fig:${base}`).replace(/[{}]/g, '');
    const esc = (s: string) => s.replace(/[{}$#]/g, (c) => `\\${c}`);
    const { state, dispatch } = view;
    const { pos, suffix } = ensureEmptyLine(state, state.selection.main);
    const tpl =
      `\n\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=${width === 1 ? '' : width}\\linewidth]{${esc(selected)}}\n` +
      `\t\\caption{\${${esc(caption) || t('figure.captionPlaceholder')}}}\n\t\\label{${esc(lbl)}}\n\\end{figure}\n${suffix}`;
    snippet(tpl)({ state, dispatch }, { label: 'figure' }, pos, pos);
    view.focus();
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog">
        <div className="modal-head">
          <div className="modal-title">{t('figure.title')}</div>
          <IconButton icon={X} label={t('common.close')} onClick={onClose} />
        </div>
        <div className="figure-picker">
          {images.map((f) => (
            <button key={f.id} className={`figure-thumb ${selected === f.path ? 'on' : ''}`} onClick={() => setSelected(f.path)} title={f.path}>
              {/\.(png|jpe?g|gif|svg)$/i.test(f.path) ? (
                <img src={api.rawFileUrl(projectId, f.id)} alt="" loading="lazy" />
              ) : (
                <ImageIcon size={28} />
              )}
              <span>{f.path}</span>
            </button>
          ))}
          <button className="figure-thumb upload" onClick={() => fileInput.current?.click()} disabled={busy}>
            <Upload size={22} />
            <span>{busy ? t('common.uploading') : t('figure.upload')}</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,.pdf,.eps"
            hidden
            onChange={(e) => {
              if (e.target.files?.length) upload(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        {images.length === 0 && <p className="muted small">{t('figure.noImages')}</p>}
        <div className="form-grid">
          <label className="field">
            <span>{t('figure.width')}</span>
            <div className="range-row">
              <input type="range" min={0.1} max={1} step={0.05} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
              <span className="range-value">{Math.round(width * 100)}%</span>
            </div>
          </label>
          <label className="field">
            <span>{t('figure.label')}</span>
            <input value={label} placeholder={selected ? `fig:${selected.replace(/^.*\//, '').replace(/\.[^.]+$/, '')}` : 'fig:…'} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="field full">
            <span>{t('figure.caption')}</span>
            <input value={caption} placeholder={t('figure.captionPlaceholder')} onChange={(e) => setCaption(e.target.value)} />
          </label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={insert} disabled={!selected}>
            {t('figure.insert')}
          </button>
        </div>
      </div>
    </div>
  );
}
