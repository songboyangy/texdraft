import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { countProjectWords, type WordCountData } from '../lib/wordCount';
import { IconButton } from './ui';

/** 字数统计（客户端统计，逻辑移植自 Overleaf；中文按 Intl.Segmenter 分词，并单独给出字符数） */
export function WordCountDialog({ projectId, mainFile, onClose }: { projectId: string; mainFile: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<WordCountData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .texts(projectId)
      .then((texts) => setData(countProjectWords(texts, mainFile, locale)))
      .catch((e) => setError((e as Error).message));
  }, [projectId, mainFile, locale]);

  const fmt = (n: number) => n.toLocaleString(locale);
  const rows: [string, number, number][] = data
    ? [
        [t('wordcount.text'), data.textWords, data.textCharacters],
        [t('wordcount.headers'), data.headWords, data.headCharacters],
        [t('wordcount.abstract'), data.abstractWords, data.abstractCharacters],
        [t('wordcount.captions'), data.captionWords, data.captionCharacters],
        [t('wordcount.footnotes'), data.footnoteWords, data.footnoteCharacters],
        [t('wordcount.other'), data.otherWords, data.otherCharacters],
      ]
    : [];
  const totalWords = rows.reduce((s, r) => s + r[1], 0);
  const totalChars = rows.reduce((s, r) => s + r[2], 0);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog">
        <div className="modal-head">
          <div className="modal-title">{t('wordcount.title')}</div>
          <IconButton icon={X} label={t('common.close')} onClick={onClose} />
        </div>
        <p className="muted small">{t('wordcount.scope', { file: mainFile })}</p>
        {error && <div className="form-error">{error}</div>}
        {!data && !error && <div className="muted pad">{t('common.loading')}</div>}
        {data && (
          <>
            <div className="stat-cards">
              <div className="stat-card">
                <div className="stat-value">{fmt(totalWords)}</div>
                <div className="stat-label">{t('wordcount.totalWords')}</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{fmt(totalChars)}</div>
                <div className="stat-label">{t('wordcount.totalChars')}</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{fmt(data.headers)}</div>
                <div className="stat-label">{t('wordcount.headings')}</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{fmt(data.mathInline + data.mathDisplay)}</div>
                <div className="stat-label">{t('wordcount.math', { inline: data.mathInline, display: data.mathDisplay })}</div>
              </div>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th />
                  <th className="num">{t('wordcount.words')}</th>
                  <th className="num">{t('wordcount.characters')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, w, c]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="num">{fmt(w)}</td>
                    <td className="num">{fmt(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">{t('wordcount.note')}</p>
          </>
        )}
      </div>
    </div>
  );
}
