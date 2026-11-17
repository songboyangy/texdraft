import type { LucideIcon } from 'lucide-react';
import { Check } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** 图标按钮（带悬停提示） */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
  size = 16,
  className = '',
  variant = 'ghost',
  children,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  size?: number;
  className?: string;
  variant?: 'ghost' | 'dark';
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${variant} ${active ? 'active' : ''} ${children ? 'with-text' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <Icon size={size} strokeWidth={1.9} />
      {children}
    </button>
  );
}

/** 下拉菜单：点击触发器展开，点击外部或选择菜单项后关闭 */
export function Dropdown({
  trigger,
  children,
  align = 'left',
  className = '',
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 菜单超出视口（如窄侧栏里向左展开）时往回挪，保持完整可见
  useLayoutEffect(() => {
    const m = menuRef.current;
    if (!open || !m) return;
    const r = m.getBoundingClientRect();
    const dx = r.left < 8 ? 8 - r.left : r.right > window.innerWidth - 8 ? window.innerWidth - 8 - r.right : 0;
    if (dx) m.style[align === 'right' ? 'right' : 'left'] = `${align === 'right' ? -dx : dx}px`;
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div className={`dropdown ${className}`} ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div ref={menuRef} className={`dropdown-menu ${align}`} onClick={(e) => e.stopPropagation()}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon: Icon,
  children,
  onClick,
  shortcut,
  checked,
  danger,
  disabled,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  onClick?: () => void;
  shortcut?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={`menu-item ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled}>
      <span className="menu-icon">{checked ? <Check size={15} /> : Icon ? <Icon size={15} strokeWidth={1.9} /> : null}</span>
      <span className="menu-label">{children}</span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </button>
  );
}

export const MenuDivider = () => <div className="menu-divider" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-section">{children}</div>;

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';

/** 用户头像（姓名首字母） */
export function Avatar({ name, color, size = 26 }: { name: string; color: string; size?: number }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.45 }}>
      {initial}
    </span>
  );
}
