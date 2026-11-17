import type { AuthConfig, User } from '@texdraft/shared';
import { Check, LockOpen, ShieldCheck, Terminal, Waypoints } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Logo } from '../components/Logo';
import { Turnstile } from '../components/Turnstile';
import { api } from '../lib/api';
import { LOCALES, useI18n } from '../lib/i18n';
import { loadSiteConfig } from '../lib/siteConfig';

export function LoginPage({ onLogin }: { onLogin: (u: User) => void }) {
  const { t, locale, setLocale } = useI18n();
  // 邀请链接：/?invite=CODE（任意路径均可）
  const inviteFromUrl = new URLSearchParams(location.search).get('invite') ?? '';
  const [mode, setMode] = useState<'login' | 'register'>(inviteFromUrl ? 'register' : 'login');
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [invite, setInvite] = useState(inviteFromUrl);
  useEffect(() => {
    loadSiteConfig().then((c) => {
      setConfig(c);
      if (c.firstUser) setMode('register');
    });
  }, []);
  const canRegister = config?.registration !== 'closed';
  const needInvite = config?.registration === 'invite' && !config.firstUser;
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** 注册时的人机验证（启用 Turnstile 时） */
  const captcha = mode === 'register' ? config?.turnstileSiteKey ?? null : null;
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const u = mode === 'login'
        ? await api.login(email, password)
        : await api.register(email, name, password, invite.trim() || undefined, captchaToken ?? undefined);
      if (inviteFromUrl) history.replaceState(null, '', location.pathname);
      onLogin(u);
    } catch (err) {
      setError((err as Error).message);
      // 令牌只能用一次：失败后重新验证
      if (captcha) setCaptchaReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  // 三个特色：本地 Agent 原生接入、开放不锁定、权限隔离与全程留痕
  const features = [
    { icon: Waypoints, title: t('landing.f1.title'), desc: t('landing.f1.desc') },
    { icon: LockOpen, title: t('landing.f2.title'), desc: t('landing.f2.desc') },
    { icon: ShieldCheck, title: t('landing.f3.title'), desc: t('landing.f3.desc') },
  ];

  return (
    <div className="auth-page">
      <section className="auth-hero poster">
        <Logo size={30} />
        <div className="poster-head">
          <h1>
            {t('landing.headline1')}
            <br />
            {t('landing.headline2')}
          </h1>
          <div className="poster-pill">{t('landing.pill')}</div>
        </div>

        {/* 示意：本地 Agent 与 ChatGPT / Claude 两个入口，汇入同一个论文工作台 */}
        <div className="poster-diagram" aria-hidden="true">
          <div className="poster-sources">
            <div className="poster-card local">
              <div className="poster-card-head">
                <span className="poster-term">
                  <Terminal size={15} />
                </span>
                <strong>{t('landing.localTitle')}</strong>
              </div>
              <div className="poster-chips">
                <span>Claude Code</span>
                <span className="mint">Codex</span>
              </div>
              <div className="poster-caption">{t('landing.localDesc')}</div>
            </div>
            <div className="poster-card web">
              <strong>ChatGPT / Claude</strong>
              <div className="poster-chips">
                <span>{t('landing.mcpChip')}</span>
              </div>
              <div className="poster-caption">{t('landing.webDesc')}</div>
            </div>
          </div>
          <svg className="poster-flow" viewBox="0 0 400 40" preserveAspectRatio="none">
            <path d="M110 0 C110 26, 200 14, 200 40" />
            <path d="M330 0 C330 26, 200 14, 200 40" />
            <circle cx="200" cy="37" r="3.5" />
          </svg>
          <div className="poster-window">
            <div className="pw-bar">
              <i />
              <i />
              <i />
              <span>TeXdraft</span>
            </div>
            <div className="pw-body">
              <div className="pw-src">
                <code className="kw">\section{'{'}{t('landing.mockTitle')}{'}'}</code>
                <span />
                <span />
                <span className="short" />
                <code className="kw">\begin{'{'}equation{'}'}</code>
                <span className="short" />
              </div>
              <div className="pw-pdf">
                <b>{t('landing.mockTitle')}</b>
                <span />
                <mark />
                <mark className="short" />
                <span />
                <em>Attn(Q,K,V) = softmax(QKᵀ/√d)V</em>
              </div>
              <div className="pw-feed">
                <div className="pw-feed-title">{t('landing.mockFeed')}</div>
                <div className="pw-item">
                  <i className="violet" />
                  <div>
                    <b>Claude Code</b>
                    <small>{t('landing.mockItem1')}</small>
                  </div>
                </div>
                <div className="pw-item">
                  <Check size={11} className="ok" />
                  <div>
                    <b>{t('landing.mockDone')}</b>
                    <small>{t('landing.mockItem2')}</small>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <ul className="poster-features">
          {features.map((f) => (
            <li key={f.title}>
              <f.icon size={18} />
              <div>
                <div className="poster-feature-title">{f.title}</div>
                <div className="poster-feature-desc">{f.desc}</div>
              </div>
            </li>
          ))}
        </ul>
        <div className="auth-hero-foot">
          {config?.sourceUrl ? (
            <a href={config.sourceUrl} target="_blank" rel="noreferrer">
              {t('landing.footer')}
            </a>
          ) : (
            t('landing.footer')
          )}
        </div>
      </section>

      <section className="auth-form-side">
        <div className="lang-switch">
          {LOCALES.map((l) => (
            <button key={l.value} className={locale === l.value ? 'on' : ''} onClick={() => setLocale(l.value)}>
              {l.label}
            </button>
          ))}
        </div>
        <form className="auth-card" onSubmit={submit}>
          <h2>{mode === 'login' ? t('auth.welcomeBack') : t('auth.createAccount')}</h2>
          <p className="muted">{mode === 'login' ? t('auth.loginHint') : t('auth.registerHint')}</p>
          {mode === 'register' && config?.firstUser && <div className="form-note">{t('auth.firstUser')}</div>}
          <label className="field">
            <span>{t('auth.email')}</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="email" />
          </label>
          {mode === 'register' && (
            <label className="field">
              <span>{t('auth.name')}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            </label>
          )}
          <label className="field">
            <span>{t('auth.password')}</span>
            <input
              type="password"
              placeholder={mode === 'register' ? t('auth.passwordRule') : ''}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {mode === 'register' && (needInvite || inviteFromUrl) && (
            <label className="field">
              <span>{t('auth.inviteCode')}</span>
              <input value={invite} onChange={(e) => setInvite(e.target.value)} required={needInvite} placeholder={t('auth.invitePlaceholder')} autoComplete="off" />
            </label>
          )}
          {captcha && <Turnstile siteKey={captcha} onToken={setCaptchaToken} resetKey={captchaReset} lang={locale === 'en' ? 'en' : 'zh-cn'} />}
          {error && <div className="form-error">{error}</div>}
          <button className="btn primary block lg" disabled={busy || (!!captcha && !captchaToken)}>
            {busy ? t('common.loading') : mode === 'login' ? t('auth.login') : t('auth.register')}
          </button>
          {mode === 'login' && !canRegister ? (
            <div className="auth-switch muted">{t('auth.registrationClosed')}</div>
          ) : (
            !config?.firstUser && (
              <div className="auth-switch">
                {mode === 'login' ? t('auth.noAccount') : t('auth.hasAccount')}{' '}
                <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
                  {mode === 'login' ? t('auth.register') : t('auth.login')}
                </button>
              </div>
            )
          )}
        </form>
      </section>
    </div>
  );
}
