import { ArrowLeft, ArrowRight, Check, Play, Plug, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';

/**
 * 新手引导：逐步高亮编辑器的各个区域并说明用法。高亮只是视觉上的（阴影压暗其余区域），
 * 页面照常可以操作；部分步骤带「帮我试一下」按钮。目标元素用 data-tour="…" 标记，找不到的步骤自动跳过。
 */

export const TOUR_DONE_KEY = 'tp.tour.done.v1';

export interface TourActions {
  /** 编译项目 */
  compile: () => void;
  /** 让 AI 执行一条指令（发到聊天面板） */
  askAi: (text: string) => void;
  /** 打开「连接 ChatGPT / AI Agent」说明 */
  openAgents: () => void;
}

interface Step {
  id: string;
  /** data-tour 的值；不设置 = 居中显示的说明卡片 */
  target?: string;
  action?: 'compile' | 'ai' | 'agents';
}

const STEPS: Step[] = [
  { id: 'welcome' },
  { id: 'files', target: 'files' },
  { id: 'editor', target: 'editor' },
  { id: 'compile', target: 'compile', action: 'compile' },
  { id: 'pdf', target: 'pdf' },
  { id: 'ai', target: 'ai', action: 'ai' },
  { id: 'select', target: 'editor' },
  { id: 'quota', target: 'quota' },
  { id: 'agents', target: 'more', action: 'agents' },
  { id: 'history', target: 'history' },
  { id: 'share', target: 'share' },
  { id: 'layout', target: 'layout' },
  { id: 'done' },
];

const PAD = 6;
const CARD_W = 340;
const GAP = 14;

const findTarget = (name?: string) => (name ? (document.querySelector(`[data-tour="${name}"]`) as HTMLElement | null) : null);

export function Tour({ onClose, actions }: { onClose: (completed: boolean) => void; actions: TourActions }) {
  const { t } = useI18n();
  // 只保留当前页面上存在的步骤（例如不是所有者时没有「共享」）
  const steps = useMemo(() => STEPS.filter((s) => !s.target || findTarget(s.target)), []);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [actionDone, setActionDone] = useState<string | null>(null);
  const step = steps[i];
  const k = (suffix: string) => t(`tour.${step.id}.${suffix}` as 'tour.welcome.title');

  const measure = useCallback(() => {
    const el = findTarget(step.target);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step.target]);
  useLayoutEffect(() => {
    measure();
  }, [measure]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    const h = setInterval(measure, 500); // 面板展开、PDF 加载等引起的布局变化
    return () => {
      window.removeEventListener('resize', measure);
      clearInterval(h);
    };
  }, [measure]);

  const finish = (completed: boolean) => onClose(completed);
  const next = () => (i + 1 < steps.length ? setI(i + 1) : finish(true));
  const prev = () => i > 0 && setI(i - 1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const runAction = () => {
    if (step.action === 'compile') actions.compile();
    if (step.action === 'ai') actions.askAi(t('tour.ai.prompt'));
    if (step.action === 'agents') actions.openAgents();
    setActionDone(step.id);
  };

  // 卡片位置：优先放在目标右侧 / 左侧 / 下方 / 上方中空间足够的一侧，并限制在视口内
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let style: React.CSSProperties = { left: (vw - CARD_W) / 2, top: vh * 0.28, width: CARD_W };
  if (rect) {
    const cardH = 220;
    const w = Math.min(CARD_W, vw - 24);
    let left: number;
    let top: number;
    if (rect.right + GAP + w <= vw - 12) {
      left = rect.right + GAP;
      top = rect.top + 8;
    } else if (rect.left - GAP - w >= 12) {
      left = rect.left - GAP - w;
      top = rect.top + 8;
    } else if (rect.bottom + GAP + cardH <= vh - 12) {
      left = rect.left + rect.width / 2 - w / 2;
      top = rect.bottom + GAP;
    } else {
      left = rect.left + rect.width / 2 - w / 2;
      top = Math.max(12, rect.top - GAP - cardH);
    }
    // 目标很大（例如整个编辑区）时，卡片放在目标内部靠上的位置
    if (rect.width > vw * 0.45 && rect.height > vh * 0.5 && !(rect.right + GAP + w <= vw - 12) && !(rect.left - GAP - w >= 12)) {
      left = rect.left + rect.width / 2 - w / 2;
      top = rect.top + 60;
    }
    style = { left: Math.max(12, Math.min(left, vw - w - 12)), top: Math.max(12, Math.min(top, vh - cardH - 12)), width: w };
  }

  return (
    <div className="tour-layer" aria-live="polite">
      {rect ? (
        <div
          className="tour-spotlight"
          style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
        />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-card" style={style} role="dialog" aria-label={k('title')}>
        <div className="tour-card-head">
          <span className="tour-step">
            {i + 1} / {steps.length}
          </span>
          <button className="tour-close" onClick={() => finish(false)} aria-label={t('tour.skip')} title={t('tour.skip')}>
            <X size={14} />
          </button>
        </div>
        <div className="tour-title">{k('title')}</div>
        <div className="tour-body">{k('body')}</div>
        {step.action && (
          <button className="btn small tour-action" onClick={runAction} disabled={actionDone === step.id}>
            {actionDone === step.id ? <Check size={13} /> : step.action === 'ai' ? <Sparkles size={13} /> : step.action === 'agents' ? <Plug size={13} /> : <Play size={13} />}{' '}
            {actionDone === step.id ? k('actionDone') : k('action')}
          </button>
        )}
        <div className="tour-nav">
          {i > 0 ? (
            <button className="btn ghost small" onClick={prev}>
              <ArrowLeft size={13} /> {t('tour.prev')}
            </button>
          ) : (
            <button className="btn ghost small" onClick={() => finish(false)}>
              {t('tour.skip')}
            </button>
          )}
          <span className="spacer" />
          <button className="btn primary small" onClick={next}>
            {i + 1 < steps.length ? (
              <>
                {i === 0 ? t('tour.start') : t('tour.next')} <ArrowRight size={13} />
              </>
            ) : (
              <>
                <Check size={13} /> {t('tour.finish')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
