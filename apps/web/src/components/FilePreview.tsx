import type { FileEntry } from '@texdraft/shared';
import { Download } from 'lucide-react';
import { useT } from '../lib/i18n';
import { PdfViewer } from './PdfViewer';

const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 二进制文件（图片 / PDF 等）在中间面板直接预览 */
export function FilePreview({ file, url }: { file: FileEntry; url: string }) {
  const t = useT();
  if (/\.pdf$/i.test(file.path)) return <PdfViewer url={url} />;
  return (
    <div className="file-preview">
      {IMAGE.test(file.path) ? (
        <img src={url} alt={file.path} />
      ) : (
        <div className="muted">{t('preview.unsupported')}</div>
      )}
      <div className="file-preview-meta muted small">
        {file.path} · {formatSize(file.size)} ·{' '}
        <a href={url} download={file.path.split('/').pop()}>
          <Download size={12} className="inline-icon" /> {t('common.download')}
        </a>
      </div>
    </div>
  );
}
