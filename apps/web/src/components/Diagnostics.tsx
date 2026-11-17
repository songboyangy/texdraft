import type { CompileResult } from '@texdraft/shared';
import { AlertCircle, AlertTriangle, CheckCircle2, LayoutPanelTop, X } from 'lucide-react';
import { useState } from 'react';
import { useT, type TFunction } from '../lib/i18n';
import { IconButton } from './ui';

type Level = 'error' | 'warning' | 'badbox';
const ICON = { error: AlertCircle, warning: AlertTriangle, badbox: LayoutPanelTop };

export function Diagnostics({
  result,
  onJump,
  onClose,
}: {
  result: CompileResult;
  onJump: (file: string, line?: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const counts = { error: 0, warning: 0, badbox: 0 } as Record<Level, number>;
  for (const d of result.diagnostics) counts[d.level]++;
  const [filter, setFilter] = useState<Level | 'all'>('all');
  const order = { error: 0, warning: 1, badbox: 2 };
  const list = [...result.diagnostics]
    .filter((d) => filter === 'all' || d.level === filter)
    .sort((a, b) => order[a.level] - order[b.level]);

  return (
    <div className="diagnostics">
      <div className="panel-head">
        <span className="panel-title">{t('log.title')}</span>
        <span className={`status-pill ${result.status}`}>{statusLabel(result, t)}</span>
        <span className="muted small">{(result.durationMs / 1000).toFixed(1)}s</span>
        <span className="spacer" />
        <div className="segmented small">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            {t('log.all')}
          </button>
          {(['error', 'warning', 'badbox'] as Level[]).map((lv) => {
            const Icon = ICON[lv];
            return (
              <button key={lv} className={`${filter === lv ? 'on' : ''} lv-${lv}`} onClick={() => setFilter(lv)}>
                <Icon size={13} /> {counts[lv]}
              </button>
            );
          })}
        </div>
        <IconButton icon={X} label={t('common.close')} onClick={onClose} size={15} />
      </div>
      <div className="diag-list">
        {list.length === 0 && (
          <div className="diag-empty">
            <CheckCircle2 size={18} /> {t('log.clean')}
          </div>
        )}
        {list.map((d, i) => {
          const Icon = ICON[d.level];
          return (
            <div
              key={i}
              className={`diag ${d.level} ${d.file ? 'clickable' : ''}`}
              onClick={() => d.file && onJump(d.file, d.line)}
            >
              <Icon size={15} className="diag-icon" />
              <div className="diag-body">
                <div className="diag-msg">{d.message}</div>
                {d.file && (
                  <div className="diag-loc">
                    {d.file}
                    {d.line ? `:${d.line}` : ''}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {result.logTail && list.every((d) => d.level !== 'error') && !result.ok && (
          <pre className="log-tail">{result.logTail}</pre>
        )}
      </div>
    </div>
  );
}

export function statusLabel(r: CompileResult, t: TFunction) {
  return t(`compile.status.${r.status}` as const);
}
