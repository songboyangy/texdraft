import type { AuthConfig } from '@texdraft/shared';
import { useEffect, useState } from 'react';
import { api } from './api';

/** 站点配置（注册方式、体验站提示、源码地址、人机验证）：公开接口，整个页面只请求一次 */
const FALLBACK: AuthConfig = { registration: 'open', firstUser: false, demo: false, sourceUrl: null, notice: null, turnstileSiteKey: null };
let cached: Promise<AuthConfig> | null = null;

export function loadSiteConfig(refresh = false): Promise<AuthConfig> {
  if (!cached || refresh) cached = api.authConfig().catch(() => FALLBACK);
  return cached;
}

export function useSiteConfig(): AuthConfig | null {
  const [c, setC] = useState<AuthConfig | null>(null);
  useEffect(() => {
    let alive = true;
    loadSiteConfig().then((v) => alive && setC(v));
    return () => {
      alive = false;
    };
  }, []);
  return c;
}
