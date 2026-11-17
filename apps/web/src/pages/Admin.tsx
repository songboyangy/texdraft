import type { AdminAiPolicy, AdminUser, InviteSummary, RegistrationMode } from '@texdraft/shared';
import { ArrowLeft, Check, Coins, Copy, KeyRound, Link2, MoreHorizontal, ShieldCheck, Ticket, UserX, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AiSettingsCard } from '../components/AiSettingsCard';
import { Logo } from '../components/Logo';
import { UserMenu } from '../components/UserMenu';
import { Avatar, Dropdown, MenuItem } from '../components/ui';
import { api } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { formatRelative, useI18n } from '../lib/i18n';
import { userColor, useUser } from '../lib/user';

function PageShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="projects-page">
      <header className="app-header">
        <Logo />
        <span className="spacer" />
        <UserMenu />
      </header>
      <main className="projects-main admin-main">
        <Link to="/" className="back-link">
          <ArrowLeft size={14} /> {t('projects.title')}
        </Link>
        <div className="projects-head">
          <div>
            <h1>{title}</h1>
            <p className="muted">{subtitle}</p>
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}

/** 只显示一次的秘密（临时密码 / 邀请链接），带复制按钮 */
function SecretNotice({ title, hint, value, onClose }: { title: string; hint: string; value: string; onClose: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret-notice">
      <div className="secret-head">
        <strong>{title}</strong>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
          <X size={15} />
        </button>
      </div>
      <p className="muted small">{hint}</p>
      <div className="secret-row">
        <code>{value}</code>
        <button
          className="btn small"
          onClick={() => {
            navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? t('admin.copied') : t('admin.copy')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function AccountPage() {
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setDone(false);
    if (next !== confirm) return setError(t('account.mismatch'));
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell title={t('account.title')} subtitle={t('account.subtitle')}>
      <form className="admin-card account-form" onSubmit={submit}>
        <label className="field">
          <span>{t('account.current')}</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </label>
        <label className="field">
          <span>{t('account.next')}</span>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} placeholder={t('auth.passwordRule')} autoComplete="new-password" />
        </label>
        <label className="field">
          <span>{t('account.confirm')}</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" />
        </label>
        {error && <div className="form-error">{error}</div>}
        {done && <div className="form-note">{t('account.saved')}</div>}
        <div>
          <button className="btn primary" disabled={busy}>
            <KeyRound size={15} /> {t('account.save')}
          </button>
        </div>
      </form>
      <AiSettingsCard />
    </PageShell>
  );
}

// ---------------------------------------------------------------------------

export function AdminPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'users' | 'invites'>('users');
  const [registration, setRegistration] = useState<RegistrationMode | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.admin.settings().then((s) => setRegistration(s.registration), (e) => setError(e.message));
  }, []);

  const changeMode = async (mode: RegistrationMode) => {
    try {
      setRegistration((await api.admin.updateSettings({ registration: mode })).registration);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const modes: RegistrationMode[] = ['open', 'invite', 'closed'];
  return (
    <PageShell title={t('admin.title')} subtitle={t('admin.subtitle')}>
      <section className="admin-card">
        <div className="admin-card-title">{t('admin.registration')}</div>
        <div className="reg-modes">
          {modes.map((m) => (
            <button key={m} className={`reg-mode ${registration === m ? 'on' : ''}`} onClick={() => changeMode(m)} disabled={registration === null}>
              <span className="reg-mode-name">{t(`admin.reg.${m}`)}</span>
              <span className="reg-mode-desc">{t(`admin.reg.${m}.desc`)}</span>
            </button>
          ))}
        </div>
      </section>
      {error && <div className="form-error">{error}</div>}
      <div className="projects-toolbar">
        <div className="segmented">
          <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>
            <Users size={14} /> {t('admin.tabUsers')}
          </button>
          <button className={tab === 'invites' ? 'on' : ''} onClick={() => setTab('invites')}>
            <Ticket size={14} /> {t('admin.tabInvites')}
          </button>
        </div>
      </div>
      {tab === 'users' ? <UsersTab /> : <InvitesTab registration={registration} />}
    </PageShell>
  );
}

function UsersTab() {
  const { t, locale } = useI18n();
  const dialog = useDialog();
  const { user: me } = useUser();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [policy, setPolicy] = useState<AdminAiPolicy | null>(null);
  const [secret, setSecret] = useState<{ name: string; password: string } | null>(null);

  const load = () =>
    api.admin.users().then(
      (r) => {
        setUsers(r.users);
        setPolicy(r.ai);
      },
      (e) => dialog.alert(t('common.failed'), e.message),
    );
  useEffect(() => {
    load();
  }, []);

  const money = (v: number) => `${policy?.currency ?? '¥'}${v.toFixed(2)}`;
  /** 该用户的服务器 AI 总额度；null = 不限 */
  const creditOf = (u: AdminUser) => u.aiCredit ?? policy?.defaultCredit ?? null;

  const setCredit = async (u: AdminUser) => {
    const current = u.aiCredit ?? '';
    const v = await dialog.prompt(
      t('admin.creditPrompt', { name: u.name, default: policy?.defaultCredit != null ? money(policy.defaultCredit) : t('admin.creditUnlimited') }),
      String(current),
      t('admin.creditPlaceholder'),
    );
    if (v === null) return;
    const trimmed = v.trim();
    const n = Number(trimmed);
    if (trimmed && (!Number.isFinite(n) || n < 0)) {
      dialog.alert(t('common.failed'), t('admin.creditInvalid'));
      return;
    }
    act(() => api.admin.updateUser(u.id, { aiCredit: trimmed ? n : null }));
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      dialog.alert(t('common.failed'), (e as Error).message);
    }
  };

  const disable = async (u: AdminUser) => {
    const ok = await dialog.confirm(t('admin.disableConfirm', { name: u.name }), { message: t('admin.disableWarning'), danger: true, confirmText: t('admin.disable') });
    if (ok) act(() => api.admin.updateUser(u.id, { disabled: true }));
  };

  const reset = async (u: AdminUser) => {
    const ok = await dialog.confirm(t('admin.resetConfirm', { name: u.name }), { message: t('admin.resetWarning'), confirmText: t('admin.resetPassword') });
    if (!ok) return;
    act(async () => setSecret({ name: u.name, password: (await api.admin.resetPassword(u.id)).password }));
  };

  return (
    <>
      {secret && (
        <SecretNotice title={t('admin.tempPassword')} hint={t('admin.tempPasswordHint', { name: secret.name })} value={secret.password} onClose={() => setSecret(null)} />
      )}
      <div className="project-list">
        <div className="project-row admin-user-row head">
          <span>{t('admin.colUser')}</span>
          <span>{t('admin.colRole')}</span>
          <span>{t('admin.colProjects')}</span>
          <span>{t('admin.colAi')}</span>
          <span>{t('admin.colJoined')}</span>
          <span />
        </div>
        {users === null && <div className="muted pad">{t('common.loading')}</div>}
        {users?.map((u) => (
          <div key={u.id} className={`project-row admin-user-row ${u.disabled ? 'disabled' : ''}`}>
            <span className="admin-user-cell">
              <Avatar name={u.name} color={userColor(u.id)} size={28} />
              <span className="admin-user-text">
                <span className="project-title">
                  {u.name}
                  {u.id === me.id && <span className="muted"> （{t('admin.you')}）</span>}
                </span>
                <span className="muted small">{u.email}</span>
              </span>
            </span>
            <span>
              {u.disabled ? (
                <span className="badge deleted">{t('admin.disabled')}</span>
              ) : u.isAdmin ? (
                <span className="badge created">
                  <ShieldCheck size={11} /> {t('admin.roleAdmin')}
                </span>
              ) : (
                <span className="muted">{t('admin.roleUser')}</span>
              )}
            </span>
            <span className="muted">{u.ownedProjects}</span>
            <span className="muted admin-ai-cell">
              <span>
                {u.aiTokensToday.toLocaleString(locale)}
                {u.ownAiKey && <span className="badge"> {t('admin.ownKey')}</span>}
              </span>
              {!u.isAdmin && (u.aiSpent > 0 || creditOf(u) !== null) && (
                <span className={`small ${creditOf(u) !== null && u.aiSpent >= creditOf(u)! ? 'credit-out' : ''}`}>
                  {creditOf(u) === null ? t('admin.creditSpent', { spent: money(u.aiSpent) }) : `${money(u.aiSpent)} / ${money(creditOf(u)!)}`}
                  {u.aiCredit !== null && ' *'}
                </span>
              )}
            </span>
            <span className="muted">{formatRelative(u.createdAt, locale)}</span>
            <span>
              {u.id !== me.id && (
                <Dropdown
                  align="right"
                  trigger={(_o, toggle) => (
                    <button className="icon-btn" onClick={toggle} aria-label={t('common.more')}>
                      <MoreHorizontal size={16} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      {!u.disabled && (
                        <MenuItem icon={ShieldCheck} onClick={() => { close(); act(() => api.admin.updateUser(u.id, { isAdmin: !u.isAdmin })); }}>
                          {u.isAdmin ? t('admin.removeAdmin') : t('admin.makeAdmin')}
                        </MenuItem>
                      )}
                      {!u.isAdmin && (
                        <MenuItem icon={Coins} onClick={() => { close(); setCredit(u); }}>
                          {t('admin.setCredit')}
                        </MenuItem>
                      )}
                      <MenuItem icon={KeyRound} onClick={() => { close(); reset(u); }}>
                        {t('admin.resetPassword')}
                      </MenuItem>
                      {u.disabled ? (
                        <MenuItem icon={Check} onClick={() => { close(); act(() => api.admin.updateUser(u.id, { disabled: false })); }}>
                          {t('admin.enable')}
                        </MenuItem>
                      ) : (
                        <MenuItem icon={UserX} danger onClick={() => { close(); disable(u); }}>
                          {t('admin.disable')}
                        </MenuItem>
                      )}
                    </>
                  )}
                </Dropdown>
              )}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function InvitesTab({ registration }: { registration: RegistrationMode | null }) {
  const { t, locale } = useI18n();
  const dialog = useDialog();
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [note, setNote] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [days, setDays] = useState(7);
  const [link, setLink] = useState<string | null>(null);

  const load = () => api.admin.invites().then(setInvites, (e) => dialog.alert(t('common.failed'), e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.admin.createInvite({ note: note.trim() || undefined, maxUses, expiresInDays: days });
      setLink(`${location.origin}/?invite=${encodeURIComponent(r.code)}`);
      setNote('');
      await load();
    } catch (err) {
      dialog.alert(t('common.failed'), (err as Error).message);
    }
  };

  return (
    <>
      {registration && registration !== 'invite' && <div className="form-note">{t('admin.inviteModeHint')}</div>}
      <form className="admin-card invite-form" onSubmit={create}>
        <label className="field grow">
          <span>{t('admin.inviteNote')}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} />
        </label>
        <label className="field narrow">
          <span>{t('admin.inviteUses')}</span>
          <input type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value) || 1)} />
        </label>
        <label className="field narrow">
          <span>{t('admin.inviteDays')}</span>
          <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value) || 7)} />
        </label>
        <button className="btn primary">
          <Link2 size={15} /> {t('admin.newInvite')}
        </button>
      </form>
      {link && <SecretNotice title={t('admin.inviteCreated')} hint={t('admin.inviteCreatedHint')} value={link} onClose={() => setLink(null)} />}
      <div className="project-list">
        {invites === null && <div className="muted pad">{t('common.loading')}</div>}
        {invites?.length === 0 && <div className="muted pad">{t('admin.noInvites')}</div>}
        {invites?.map((inv) => (
          <div key={inv.id} className={`project-row admin-invite-row ${inv.status !== 'active' ? 'disabled' : ''}`}>
            <span className="admin-user-text">
              <span className="project-title">
                <code>{inv.prefix}…</code> {inv.note}
              </span>
              <span className="muted small">{formatRelative(inv.createdAt, locale)}</span>
            </span>
            <span className={`badge ${inv.status === 'active' ? 'created' : inv.status === 'revoked' ? 'deleted' : ''}`}>{t(`admin.invite.${inv.status}`)}</span>
            <span className="muted">{t('admin.inviteUsage', { uses: inv.uses, max: inv.maxUses })}</span>
            <span className="muted">{inv.expiresAt ? t('admin.inviteExpires', { date: new Date(inv.expiresAt).toLocaleDateString(locale) }) : t('admin.inviteNoExpiry')}</span>
            <span>
              {inv.status === 'active' && (
                <button className="btn small ghost" onClick={async () => { await api.admin.revokeInvite(inv.id).catch((e) => dialog.alert(t('common.failed'), e.message)); load(); }}>
                  {t('admin.revoke')}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
