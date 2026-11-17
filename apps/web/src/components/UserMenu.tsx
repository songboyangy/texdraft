import { Code2, KeyRound, Languages, LogOut, Minus, Plus, ShieldCheck, Type, WrapText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { LOCALES, useI18n } from '../lib/i18n';
import { FONT_SIZES, updateSettings, useSettings } from '../lib/settings';
import { useSiteConfig } from '../lib/siteConfig';
import { userColor, useUser } from '../lib/user';
import { Avatar, Dropdown, MenuDivider, MenuItem, MenuLabel } from './ui';

/** 右上角用户菜单：语言、编辑器偏好、退出 */
export function UserMenu({ showEditorSettings = false }: { showEditorSettings?: boolean }) {
  const { user, setUser } = useUser();
  const { locale, setLocale, t } = useI18n();
  const settings = useSettings();
  const idx = FONT_SIZES.indexOf(settings.editorFontSize);
  const navigate = useNavigate();
  const site = useSiteConfig();

  return (
    <Dropdown
      align="right"
      trigger={(_open, toggle) => (
        <button className="avatar-btn" onClick={toggle} title={user.name}>
          <Avatar name={user.name} color={userColor(user.id)} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-user">
            <Avatar name={user.name} color={userColor(user.id)} size={32} />
            <div>
              <div className="menu-user-name">{user.name}</div>
              <div className="menu-user-email">{user.email}</div>
            </div>
          </div>
          <MenuDivider />
          <MenuItem icon={KeyRound} onClick={() => { close(); navigate('/account'); }}>
            {t('menu.account')}
          </MenuItem>
          {user.isAdmin && (
            <MenuItem icon={ShieldCheck} onClick={() => { close(); navigate('/admin'); }}>
              {t('menu.admin')}
            </MenuItem>
          )}
          {site?.sourceUrl && (
            <MenuItem icon={Code2} onClick={() => { close(); window.open(site.sourceUrl!, '_blank', 'noopener'); }}>
              {t('menu.source')}
            </MenuItem>
          )}
          <MenuDivider />
          <MenuLabel>
            <Languages size={13} /> {t('settings.language')}
          </MenuLabel>
          {LOCALES.map((l) => (
            <MenuItem key={l.value} checked={locale === l.value} onClick={() => setLocale(l.value)}>
              {l.label}
            </MenuItem>
          ))}
          {showEditorSettings && (
            <>
              <MenuDivider />
              <MenuLabel>
                <Type size={13} /> {t('settings.editor')}
              </MenuLabel>
              <div className="menu-row">
                <span>{t('settings.fontSize')}</span>
                <span className="spacer" />
                <button className="stepper" disabled={idx <= 0} onClick={() => updateSettings({ editorFontSize: FONT_SIZES[idx - 1] })}>
                  <Minus size={13} />
                </button>
                <span className="stepper-value">{settings.editorFontSize}px</span>
                <button
                  className="stepper"
                  disabled={idx >= FONT_SIZES.length - 1}
                  onClick={() => updateSettings({ editorFontSize: FONT_SIZES[idx + 1] })}
                >
                  <Plus size={13} />
                </button>
              </div>
              <MenuItem icon={WrapText} checked={settings.lineWrapping} onClick={() => updateSettings({ lineWrapping: !settings.lineWrapping })}>
                {t('settings.lineWrapping')}
              </MenuItem>
            </>
          )}
          <MenuDivider />
          <MenuItem
            icon={LogOut}
            onClick={() => {
              close();
              api.logout().then(() => setUser(null));
            }}
          >
            {t('auth.logout')}
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}
