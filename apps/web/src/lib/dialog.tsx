import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from './i18n';

/**
 * 页面内对话框，替代 window.prompt / confirm / alert
 * （VS Code 内置浏览器等 webview 环境会屏蔽原生弹窗）。
 */

interface Choice<T extends string> { value: T; label: string; primary?: boolean; danger?: boolean }

type Request =
  | { kind: 'prompt'; title: string; defaultValue: string; placeholder?: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; message?: string; danger?: boolean; confirmText?: string; resolve: (v: boolean) => void }
  | { kind: 'alert'; title: string; message?: string; resolve: () => void }
  | { kind: 'choose'; title: string; message?: string; choices: Choice<string>[]; resolve: (v: string | null) => void };

interface DialogApi {
  prompt(title: string, defaultValue?: string, placeholder?: string): Promise<string | null>;
  confirm(title: string, opts?: { message?: string; danger?: boolean; confirmText?: string }): Promise<boolean>;
  alert(title: string, message?: string): Promise<void>;
  choose<T extends string>(title: string, choices: Choice<T>[], message?: string): Promise<T | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog outside DialogProvider');
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Request[]>([]);
  const push = useCallback((r: Request) => setQueue((q) => [...q, r]), []);
  const pop = useCallback(() => setQueue((q) => q.slice(1)), []);

  const api = useRef<DialogApi>({
    prompt: (title, defaultValue = '', placeholder) =>
      new Promise((resolve) => push({ kind: 'prompt', title, defaultValue, placeholder, resolve })),
    confirm: (title, opts = {}) => new Promise((resolve) => push({ kind: 'confirm', title, ...opts, resolve })),
    alert: (title, message) => new Promise((resolve) => push({ kind: 'alert', title, message, resolve })),
    choose: (title, choices, message) =>
      new Promise((resolve) =>
        push({ kind: 'choose', title, message, choices, resolve: resolve as (v: string | null) => void }),
      ),
  }).current;

  const current = queue[0];
  return (
    <DialogContext.Provider value={api}>
      {children}
      {current && <DialogView key={queue.length + current.title} req={current} done={pop} />}
    </DialogContext.Provider>
  );
}

function DialogView({ req, done }: { req: Request; done: () => void }) {
  const t = useT();
  const [value, setValue] = useState(req.kind === 'prompt' ? req.defaultValue : '');
  const input = useRef<HTMLInputElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (req.kind === 'prompt') {
      input.current?.focus();
      input.current?.select();
    } else okBtn.current?.focus();
  }, [req.kind]);

  const cancel = () => {
    if (req.kind === 'prompt' || req.kind === 'choose') req.resolve(null);
    else if (req.kind === 'confirm') req.resolve(false);
    else req.resolve();
    done();
  };
  const ok = () => {
    if (req.kind === 'prompt') req.resolve(value);
    else if (req.kind === 'confirm') req.resolve(true);
    else if (req.kind === 'alert') req.resolve();
    done();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        className="modal"
        role="dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
          if (e.key === 'Enter' && req.kind !== 'choose' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            ok();
          }
        }}
      >
        <div className="modal-title">{req.title}</div>
        {'message' in req && req.message && <div className="modal-message">{req.message}</div>}
        {req.kind === 'prompt' && (
          <input
            ref={input}
            className="modal-input"
            value={value}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="modal-actions">
          {req.kind === 'choose' ? (
            <>
              <button className="btn ghost" onClick={cancel}>{t('common.cancel')}</button>
              {req.choices.map((c, i) => (
                <button
                  key={c.value}
                  ref={i === 0 ? okBtn : undefined}
                  className={`btn ${c.primary ? 'primary' : c.danger ? 'danger' : ''}`}
                  onClick={() => {
                    req.resolve(c.value);
                    done();
                  }}
                >
                  {c.label}
                </button>
              ))}
            </>
          ) : (
            <>
              {req.kind !== 'alert' && <button className="btn ghost" onClick={cancel}>{t('common.cancel')}</button>}
              <button
                ref={okBtn}
                className={`btn ${req.kind === 'confirm' && req.danger ? 'danger' : 'primary'}`}
                onClick={ok}
                disabled={req.kind === 'prompt' && !value.trim()}
              >
                {req.kind === 'confirm' ? req.confirmText ?? t('common.ok') : t('common.ok')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
