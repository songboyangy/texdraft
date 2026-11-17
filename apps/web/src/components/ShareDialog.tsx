import { Eye, Loader2, PenLine, Share2, Trash2, UserPlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useI18n } from '../lib/i18n';
import { userColor } from '../lib/user';
import { Avatar, IconButton } from './ui';

type Member = { userId: string; email: string; name: string; role: 'owner' | 'editor' | 'viewer' };

/** 邀请协作者：说明两种权限分别能做什么、对方需要先注册；下方列出成员，可改权限或移除 */
export function ShareDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useDialog();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api.members(projectId).then(setMembers, () => setMembers([]));
  useEffect(() => {
    load();
  }, [projectId]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.addMember(projectId, addr, role);
      setNotice({ ok: true, text: t(role === 'editor' ? 'share.addedEditor' : 'share.addedViewer', { email: addr }) });
      setEmail('');
      await load();
    } catch (err) {
      setNotice({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const change = async (m: Member, r: 'editor' | 'viewer') => {
    await api.addMember(projectId, m.email, r).catch((err) => dialog.alert(t('share.failed'), (err as Error).message));
    load();
  };
  const remove = async (m: Member) => {
    if (!(await dialog.confirm(t('share.removeConfirm', { name: m.name }), { danger: true, confirmText: t('share.remove') }))) return;
    await api.removeMember(projectId, m.userId).catch((err) => dialog.alert(t('share.failed'), (err as Error).message));
    load();
  };

  const roles = [
    { value: 'editor' as const, icon: PenLine, label: t('role.editor'), desc: t('share.editorDesc') },
    { value: 'viewer' as const, icon: Eye, label: t('role.viewer'), desc: t('share.viewerDesc') },
  ];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-dialog" role="dialog">
        <div className="modal-head">
          <div className="modal-title with-icon">
            <Share2 size={17} /> {t('share.title')}
          </div>
          <IconButton icon={X} label={t('common.close')} onClick={onClose} />
        </div>

        <form className="share-form" onSubmit={invite}>
          <label className="field">
            <span>{t('share.emailLabel')}</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('share.emailPlaceholder')} autoFocus required />
          </label>
          <div className="share-roles" role="radiogroup">
            {roles.map((r) => (
              <button type="button" key={r.value} role="radio" aria-checked={role === r.value} className={`share-role ${role === r.value ? 'on' : ''}`} onClick={() => setRole(r.value)}>
                <r.icon size={15} />
                <span>
                  <strong>{r.label}</strong>
                  <small>{r.desc}</small>
                </span>
              </button>
            ))}
          </div>
          <p className="muted small">{t('share.needsAccount')}</p>
          {notice && <div className={notice.ok ? 'form-note ok' : 'form-error'}>{notice.text}</div>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              {t('common.close')}
            </button>
            <button className="btn primary" disabled={busy || !email.trim()}>
              {busy ? <Loader2 size={14} className="spin" /> : <UserPlus size={14} />} {t('share.invite')}
            </button>
          </div>
        </form>

        <div className="share-members">
          <div className="share-members-title">{t('share.members')}</div>
          {members === null && <div className="muted small">{t('common.loading')}</div>}
          {members?.map((m) => (
            <div key={m.userId} className="share-member">
              <Avatar name={m.name} color={userColor(m.userId)} size={26} />
              <span className="share-member-text">
                <span>{m.name}</span>
                <span className="muted small">{m.email}</span>
              </span>
              {m.role === 'owner' ? (
                <span className="muted small">{t('role.owner')}</span>
              ) : (
                <>
                  <select value={m.role} onChange={(e) => change(m, e.target.value as 'editor' | 'viewer')}>
                    <option value="editor">{t('role.editor')}</option>
                    <option value="viewer">{t('role.viewer')}</option>
                  </select>
                  <IconButton icon={Trash2} label={t('share.remove')} size={14} onClick={() => remove(m)} />
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
