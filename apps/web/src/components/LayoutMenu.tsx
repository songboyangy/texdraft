import { BookOpen, Check, Code2, Columns3, LayoutDashboard, PanelLeft, PanelRight, PenLine, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import type { Layout } from '../lib/useLayout';
import { Dropdown, MenuDivider, MenuLabel } from './ui';

type Patch = Partial<Layout>;

/** 预设布局：一次切换几块面板，比单独开关每块面板更好理解 */
const PRESETS: { id: string; icon: LucideIcon; patch: Patch }[] = [
  { id: 'edit', icon: PenLine, patch: { showSidebar: true, showEditor: true, showPreview: true, showChat: false, split: 0.5 } },
  { id: 'read', icon: BookOpen, patch: { showSidebar: false, showEditor: false, showPreview: true, showChat: false } },
  { id: 'ai', icon: Sparkles, patch: { showSidebar: false, showEditor: true, showPreview: true, showChat: true, split: 0.5 } },
  { id: 'all', icon: Columns3, patch: { showSidebar: true, showEditor: true, showPreview: true, showChat: true } },
];

const matches = (l: Layout, p: Patch) => p.showSidebar === l.showSidebar && p.showEditor === l.showEditor && p.showPreview === l.showPreview && p.showChat === l.showChat;

/** 顶栏的「布局」菜单：预设（专注编辑 / 阅读 PDF / AI 修改 / 全部显示）+ 单独开关每块面板 */
export function LayoutMenu({ layout, update }: { layout: Layout; update: (p: Patch) => void }) {
  const { t } = useI18n();
  const current = PRESETS.find((p) => matches(layout, p.patch));
  const label = (id: string) => t(`layout.preset.${id}` as 'layout.preset.edit');
  const panes: { key: 'showSidebar' | 'showEditor' | 'showPreview' | 'showChat'; icon: LucideIcon; label: string }[] = [
    { key: 'showSidebar', icon: PanelLeft, label: t('layout.sidebar') },
    { key: 'showEditor', icon: Code2, label: t('layout.editor') },
    { key: 'showPreview', icon: PanelRight, label: t('layout.preview') },
    { key: 'showChat', icon: Sparkles, label: t('layout.ai') },
  ];
  return (
    <Dropdown
      align="right"
      trigger={(_open, toggle) => (
        <button className="ide-btn layout-btn" data-tour="layout" onClick={toggle} title={t('layout.menu')}>
          <LayoutDashboard size={14} /> {current ? label(current.id) : t('layout.menu')}
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuLabel>{t('layout.presets')}</MenuLabel>
          {PRESETS.map((p) => (
            <button key={p.id} className={`menu-item ${current?.id === p.id ? 'current' : ''}`} onClick={() => (close(), update(p.patch))}>
              <span className="menu-icon">
                <p.icon size={15} />
              </span>
              <span className="menu-label">
                {label(p.id)}
                <span className="menu-desc">{t(`layout.preset.${p.id}.desc` as 'layout.preset.edit.desc')}</span>
              </span>
              {current?.id === p.id && <Check size={14} />}
            </button>
          ))}
          <MenuDivider />
          <MenuLabel>{t('layout.panes')}</MenuLabel>
          {panes.map((p) => (
            <button
              key={p.key}
              className="menu-item"
              // 源码与 PDF 至少保留一个
              onClick={() => update(p.key === 'showEditor' && layout.showEditor && !layout.showPreview ? { showEditor: false, showPreview: true } : p.key === 'showPreview' && layout.showPreview && !layout.showEditor ? { showPreview: false, showEditor: true } : { [p.key]: !layout[p.key] })}
            >
              <span className="menu-icon">
                <p.icon size={15} />
              </span>
              <span className="menu-label">{p.label}</span>
              {layout[p.key] && <Check size={14} />}
            </button>
          ))}
        </>
      )}
    </Dropdown>
  );
}
