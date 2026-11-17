/** TeXdraft 标志：圆角方块中的 “T” 与一道指向右上的轨迹 */
export function Logo({ size = 22, light = false, withText = true }: { size?: number; light?: boolean; withText?: boolean }) {
  return (
    <span className={`logo ${light ? 'light' : ''}`}>
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <defs>
          <linearGradient id="tp-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#1fb57a" />
            <stop offset="1" stopColor="#0d7a55" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill="url(#tp-g)" />
        <path d="M9 10h14M16 10v13" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        <path d="M20.5 22.5l4-4" stroke="#c9f5df" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      {withText && <span className="logo-text" style={{ fontSize: size * 0.72 }}>TeXdraft</span>}
    </span>
  );
}
