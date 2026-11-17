import type { PdfRect } from '@texdraft/shared';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Download, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useT } from '../lib/i18n';
import { IconButton } from './ui';

GlobalWorkerOptions.workerSrc = workerUrl;

type Zoom = 'fit' | number;

export interface PdfViewerHandle {
  /** 滚动到指定页并高亮矩形（PDF bp 坐标，原点左上） */
  showRects(page: number, rects: PdfRect[]): void;
}

interface Props {
  url?: string;
  /** 双击 PDF：返回页码与 bp 坐标（用于 SyncTeX 反向跳转） */
  onDoubleClick?: (page: number, x: number, y: number) => void;
  /** 工具栏左侧的额外按钮 */
  toolbarExtra?: React.ReactNode;
  ref?: Ref<PdfViewerHandle>;
}

const ZOOM_KEY = 'tp.pdfZoom';

export function PdfViewer({ url, onDoubleClick, toolbarExtra, ref }: Props) {
  const t = useT();
  const container = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [zoom, setZoom] = useState<Zoom>(() => {
    const v = localStorage.getItem(ZOOM_KEY);
    return v && v !== 'fit' ? Number(v) : 'fit';
  });
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  /** 每页 CSS 像素 / bp 的比例 */
  const scales = useRef<number[]>([]);
  const pending = useRef<{ page: number; rects: PdfRect[] } | null>(null);

  useEffect(() => localStorage.setItem(ZOOM_KEY, String(zoom)), [zoom]);

  const highlight = (page: number, rects: PdfRect[]) => {
    const el = container.current;
    const wrap = pagesRef.current?.children[page - 1] as HTMLElement | undefined;
    const scale = scales.current[page - 1];
    if (!el || !wrap || !scale) {
      pending.current = { page, rects };
      return;
    }
    wrap.querySelectorAll('.pdf-highlight').forEach((n) => n.remove());
    for (const r of rects) {
      const div = document.createElement('div');
      div.className = 'pdf-highlight';
      Object.assign(div.style, {
        left: `${r.x * scale - 2}px`, top: `${r.y * scale - 2}px`,
        width: `${r.w * scale + 4}px`, height: `${r.h * scale + 4}px`,
      });
      wrap.appendChild(div);
    }
    const top = rects.length ? Math.min(...rects.map((r) => r.y)) * scale : 0;
    el.scrollTo({ top: wrap.offsetTop + top - el.clientHeight / 3, behavior: 'smooth' });
    setTimeout(() => wrap.querySelectorAll('.pdf-highlight').forEach((n) => n.classList.add('fade')), 1600);
    setTimeout(() => wrap.querySelectorAll('.pdf-highlight').forEach((n) => n.remove()), 2600);
  };

  useImperativeHandle(ref, () => ({ showRects: highlight }));

  // 加载 PDF（新文档渲染出来之前保留旧文档，避免预览闪白）
  const loaded = useRef<ReturnType<typeof getDocument> | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    // cMapUrl / standardFontDataUrl：中文等 CID 字体需要 CMap 才能显示文字（文件由 vite 插件随前端一起发布）
    const task = getDocument({ url, withCredentials: true, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/' });
    task.promise.then(
      (d) => {
        if (cancelled) {
          task.destroy();
          return;
        }
        setError('');
        const prev = loaded.current;
        loaded.current = task;
        setDoc(d);
        if (prev) setTimeout(() => prev.destroy(), 5000);
      },
      (e) => !cancelled && setError(String(e?.message ?? e)),
    );
    return () => {
      cancelled = true;
    };
  }, [url]);
  useEffect(() => () => void loaded.current?.destroy(), []);

  // 跟踪容器宽度（适应宽度模式；拖动分隔条时防抖）
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => setWidth(el.clientWidth), 120);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  // 渲染所有页面；重新编译后保持相对滚动位置
  useEffect(() => {
    const el = container.current;
    const pagesEl = pagesRef.current;
    if (!doc || !el || !pagesEl || width === 0) return;
    let cancelled = false;
    const ratio = el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0;

    (async () => {
      const dpr = window.devicePixelRatio || 1;
      const wraps: HTMLElement[] = [];
      const nextScales: number[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = zoom === 'fit' ? Math.max(0.2, (width - 32) / base.width) : zoom;
        const viewport = page.getViewport({ scale: scale * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        await page.render({ canvas, viewport }).promise;
        if (cancelled) return;
        const wrap = document.createElement('div');
        wrap.className = 'pdf-page';
        wrap.dataset.page = String(i);
        wrap.appendChild(canvas);
        wraps.push(wrap);
        nextScales.push(scale);
      }
      // 全部渲染完再替换，避免闪烁
      pagesEl.replaceChildren(...wraps);
      scales.current = nextScales;
      el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
      if (pending.current) {
        const p = pending.current;
        pending.current = null;
        highlight(p.page, p.rects);
      }
    })().catch((e) => !cancelled && setError(String(e?.message ?? e)));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, zoom, width]);

  const handleDblClick = (e: React.MouseEvent) => {
    const wrap = (e.target as HTMLElement).closest('.pdf-page') as HTMLElement | null;
    if (!wrap || !onDoubleClick) return;
    const page = Number(wrap.dataset.page);
    const scale = scales.current[page - 1];
    const rect = wrap.getBoundingClientRect();
    onDoubleClick(page, (e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
  };

  const current = zoom === 'fit' ? null : zoom;
  const effective = current ?? scales.current[0] ?? 1;
  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <span className="spacer" />
        <IconButton icon={ZoomOut} label={t('pdf.zoomOut')} size={15} onClick={() => setZoom(Math.max(0.3, +(effective - 0.1).toFixed(2)))} />
        <span className="zoom-label">{Math.round(effective * 100)}%</span>
        <IconButton icon={ZoomIn} label={t('pdf.zoomIn')} size={15} onClick={() => setZoom(Math.min(4, +(effective + 0.1).toFixed(2)))} />
        <IconButton icon={Maximize2} label={t('pdf.fitWidth')} size={15} active={zoom === 'fit'} onClick={() => setZoom('fit')} />
        {url && (
          <a className="icon-btn ghost" href={url} download="output.pdf" title={t('pdf.download')}>
            <Download size={15} strokeWidth={1.9} />
          </a>
        )}
        {/* 放在最右侧（例如收起 PDF 栏的按钮） */}
        {toolbarExtra}
      </div>
      <div className="pdf-scroll" ref={container} onDoubleClick={handleDblClick}>
        {!url && <div className="pdf-empty muted">{t('pdf.empty')}</div>}
        {error && <div className="error-text pad">{t('pdf.loadFailed', { error })}</div>}
        <div ref={pagesRef} className="pdf-pages" title={onDoubleClick ? t('pdf.dblclickHint') : undefined} />
      </div>
    </div>
  );
}
