import { Info, X } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { useSiteConfig } from '../lib/siteConfig';

const KEY = 'texdraft:demo-notice-dismissed';

/** 体验站提示条（DEMO_NOTICE / PUBLIC_DEMO）：本次会话内可以关闭 */
export function DemoBanner() {
  const { t } = useI18n();
  const site = useSiteConfig();
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  if (!site?.notice || hidden) return null;
  const close = () => {
    setHidden(true);
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      /* 隐私模式等：只在本页隐藏 */
    }
  };
  return (
    <div className="demo-banner" role="note">
      <Info size={14} />
      <span>{site.notice === 'default' ? t('demo.notice') : site.notice}</span>
      {site.sourceUrl && (
        <a href={site.sourceUrl} target="_blank" rel="noreferrer">
          {t('demo.source')}
        </a>
      )}
      <button className="demo-banner-close" onClick={close} aria-label={t('common.close')}>
        <X size={14} />
      </button>
    </div>
  );
}
