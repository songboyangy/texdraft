import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 编辑器页面的四栏布局：文件树 | 编辑器 | PDF | AI。
 * 文件树与 AI 栏是固定像素宽度，编辑器与 PDF 按比例分剩余空间；均可拖动、可折叠，保存在 localStorage。
 */
export interface Layout {
  sidebar: number;
  chat: number;
  /** 编辑器占“编辑器 + PDF”区域的比例 */
  split: number;
  showSidebar: boolean;
  /** 源码编辑器（与 PDF 至少保留一个） */
  showEditor: boolean;
  showPreview: boolean;
  showChat: boolean;
  /** 编译日志面板占预览区高度的比例 */
  logHeight: number;
}

// v2：默认改为「AI 修改」布局（源码 + PDF + AI，文件栏收起成左侧竖条）；升级后每个人先看到一次新的默认布局
const KEY = 'tp.layout.v2';
const DEFAULT: Layout = { sidebar: 190, chat: 380, split: 0.5, showSidebar: false, showEditor: true, showPreview: true, showChat: true, logHeight: 0.38 };

export const LIMITS = { sidebar: [140, 480], chat: [300, 760], split: [0.15, 0.85], logHeight: [0.15, 0.8] } as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

export function useLayout() {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    } catch {
      return DEFAULT;
    }
  });
  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(layout));
  }, [layout]);

  const update = useCallback((patch: Partial<Layout>) => setLayout((l) => ({ ...l, ...patch })), []);
  return { layout, update, reset: () => setLayout(DEFAULT) };
}

/**
 * 拖拽分隔条。onMove 收到相对于按下时的位移（px）；拖动期间给 body 加 class，
 * 屏蔽 iframe/canvas 等的指针事件与文本选择。
 */
export function useDrag(onMove: (dx: number, dy: number) => void, onEnd?: () => void) {
  const move = useRef(onMove);
  move.current = onMove;
  return useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      const onPointerMove = (ev: PointerEvent) => move.current(ev.clientX - startX, ev.clientY - startY);
      const onUp = () => {
        document.body.classList.remove('resizing');
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        onEnd?.();
      };
      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    },
    [onEnd],
  );
}

export { clamp };
