import type { AiSettingsInput, AiSettingsView } from '@texdraft/shared';
import { Bot, Check, CircleCheck, ExternalLink, KeyRound, Loader2, PlugZap, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useI18n } from '../lib/i18n';

/** 账号设置中的「AI 模型」：自己的服务预设、模型、Key（加密保存）、测试连接与今日用量 */
/** embedded：放在对话框里时去掉卡片外框与标题（由对话框提供）；startOpen：直接展开「自己的 Key」表单 */
export function AiSettingsCard({ embedded = false, startOpen = false }: { embedded?: boolean; startOpen?: boolean } = {}) {
  const { t, locale } = useI18n();
  const dialog = useDialog();
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [form, setForm] = useState<AiSettingsInput>({ preset: 'deepseek', model: '' });
  const [apiKey, setApiKey] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  /** 「自己的 Key」表单：已保存过或没有服务器模型时直接展开，否则收起，避免和当前生效的模型混淆 */
  const [formOpen, setFormOpen] = useState(startOpen);

  const load = (v: AiSettingsView) => {
    setView(v);
    const s = v.settings;
    setForm(
      s
        ? { preset: s.preset, provider: s.provider as AiSettingsInput['provider'], baseUrl: s.baseUrl, model: s.model, maxTokens: s.maxTokens, vision: s.vision, contextWindow: s.contextWindow }
        : { preset: 'deepseek', model: v.presets.find((p) => p.id === 'deepseek')?.models[0] ?? '' },
    );
    setApiKey('');
  };
  useEffect(() => {
    api.ai.settings().then(load, (e) => setNotice({ ok: false, text: (e as Error).message }));
  }, []);

  const preset = useMemo(() => view?.presets.find((p) => p.id === form.preset), [view, form.preset]);
  if (!view) return <section className="admin-card account-form">{t('common.loading')}</section>;

  const presets = view.presets.filter((p) => p.id !== 'custom' || view.customBaseUrlAllowed || view.settings?.preset === 'custom');
  const fmt = (n: number) => n.toLocaleString(locale);
  const money = (v: number) => `${view?.shared.credit?.currency ?? '¥'}${v.toFixed(2)}`;
  const payload = (): AiSettingsInput => ({ ...form, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });

  const run = async (kind: 'save' | 'test') => {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'test') {
        const r = await api.ai.test(payload());
        setNotice(r.ok ? { ok: true, text: t('ai.testOk', { ms: r.latencyMs, reply: r.reply || '—' }) } : { ok: false, text: t('ai.testFail', { error: r.error ?? '' }) });
      } else {
        load(await api.ai.save(payload()));
        setNotice({ ok: true, text: t('ai.saved') });
      }
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await dialog.confirm(t('ai.removeConfirm'), { danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    load(await api.ai.remove());
    setNotice(null);
  };

  const s = view.settings;
  const showForm = formOpen || !!s || !view.shared.available;
  const sharedUsed = view.usage.shared.inputTokens + view.usage.shared.outputTokens;
  const ownUsed = view.usage.own.inputTokens + view.usage.own.outputTokens;
  return (
    <section className={`admin-card account-form ai-card ${embedded ? 'embedded' : ''}`}>
      <div className="admin-card-title with-icon" hidden={embedded}>
        <Bot size={16} /> {t('ai.title')}
      </div>
      <p className="muted small">{t('ai.subtitle')}</p>
      <div className="ai-current">
        <div className="ai-current-label">
          <CircleCheck size={14} /> {t('ai.currentLabel')}
        </div>
        <div className="ai-current-model">
          {s
            ? t('ai.currentOwn', { provider: view.presets.find((p) => p.id === s.preset)?.name ?? s.preset, model: s.model })
            : view.shared.available
              ? t('ai.currentShared', { model: view.shared.model })
              : t('ai.currentNone')}
        </div>
      </div>
      <div className="form-note">
        {s ? t('ai.usingOwn') : view.shared.available ? t('ai.usingShared', { model: view.shared.model }) : t('ai.noShared')}
        {!s && view.shared.available && view.shared.credit && (
          <>
            {' '}
            {view.shared.credit.spent >= view.shared.credit.limit
              ? t('ai.creditUsedUp', { limit: money(view.shared.credit.limit) })
              : t('ai.credit', { limit: money(view.shared.credit.limit), used: money(Math.min(view.shared.credit.spent, view.shared.credit.limit)) })}
          </>
        )}
        {!s && view.shared.available && view.shared.dailyTokens > 0 && <> {t('ai.sharedLimit', { limit: fmt(view.shared.dailyTokens), used: fmt(sharedUsed) })}</>}
      </div>
      {!s && view.shared.available && view.shared.credit && view.shared.credit.limit > 0 && (
        <div className="credit-bar" title={`${money(view.shared.credit.spent)} / ${money(view.shared.credit.limit)}`}>
          <div style={{ width: `${Math.min(100, (view.shared.credit.spent / view.shared.credit.limit) * 100)}%` }} />
        </div>
      )}

      {!showForm ? (
        <button type="button" className="btn" onClick={() => setFormOpen(true)}>
          <KeyRound size={14} /> {t('ai.useOwnKey')}
        </button>
      ) : (
      <div className="ai-own-form">
      <div className="ai-own-title">{s ? t('ai.ownTitleSaved') : t('ai.ownTitle')}</div>
      {!s && <p className="muted small">{t('ai.ownHint')}</p>}
      <label className="field">
        <span>{t('ai.preset')}</span>
        <select
          value={form.preset}
          onChange={(e) => {
            const p = view.presets.find((x) => x.id === e.target.value);
            setForm({ preset: e.target.value, model: p?.models[0] ?? '', provider: p?.provider, baseUrl: p?.id === 'custom' ? '' : null });
          }}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === 'custom' ? t('ai.protocol') + ' / ' + t('ai.baseUrl') : p.name}
            </option>
          ))}
        </select>
      </label>

      {form.preset === 'custom' && (
        <>
          <label className="field">
            <span>{t('ai.protocol')}</span>
            <select value={form.provider ?? 'openai'} onChange={(e) => setForm({ ...form, provider: e.target.value as AiSettingsInput['provider'] })}>
              {(['openai', 'compatible', 'anthropic'] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`ai.protocol.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('ai.baseUrl')}</span>
            <input value={form.baseUrl ?? ''} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://…/v1" />
          </label>
        </>
      )}

      <label className="field">
        <span>{t('ai.model')}</span>
        <input
          list="ai-model-suggestions"
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
          placeholder={t('ai.modelPlaceholder', { example: preset?.models[0] ?? 'gpt-5' })}
        />
        <datalist id="ai-model-suggestions">
          {preset?.models.map((m) => <option key={m} value={m} />)}
        </datalist>
      </label>

      <label className="field">
        <span>
          {t('ai.apiKey')}
          {preset?.keyUrl && (
            <a className="field-link" href={preset.keyUrl} target="_blank" rel="noreferrer">
              {t('ai.getKey')} <ExternalLink size={11} />
            </a>
          )}
        </span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={s?.hasKey ? (s.keyReadable ? t('ai.keySaved', { hint: s.keyHint ?? '' }) : t('ai.keyUnreadable')) : 'sk-…'}
        />
      </label>

      <button type="button" className="link small" onClick={() => setAdvanced(!advanced)}>
        {t('ai.advanced')} {advanced ? '▴' : '▾'}
      </button>
      {advanced && (
        <div className="ai-advanced">
          <label className="field">
            <span>{t('ai.maxTokens')}</span>
            <input type="number" min={256} value={form.maxTokens ?? ''} placeholder={t('ai.default', { value: preset?.maxTokens ?? '' })} onChange={(e) => setForm({ ...form, maxTokens: e.target.value ? Number(e.target.value) : null })} />
          </label>
          <label className="field">
            <span>{t('ai.contextWindow')}</span>
            <input type="number" min={8000} value={form.contextWindow ?? ''} placeholder={t('ai.default', { value: preset?.contextWindow ?? '' })} onChange={(e) => setForm({ ...form, contextWindow: e.target.value ? Number(e.target.value) : null })} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={form.vision ?? preset?.vision ?? false} onChange={(e) => setForm({ ...form, vision: e.target.checked })} />
            <span>{t('ai.vision')}</span>
          </label>
        </div>
      )}

      {notice && <div className={notice.ok ? 'form-note ok' : 'form-error'}>{notice.ok ? <Check size={13} /> : <X size={13} />} {notice.text}</div>}
      <div className="btn-row">
        <button type="button" className="btn" disabled={!!busy || !form.model.trim()} onClick={() => run('test')}>
          {busy === 'test' ? <Loader2 size={14} className="spin" /> : <PlugZap size={14} />} {busy === 'test' ? t('ai.testing') : t('ai.test')}
        </button>
        <button type="button" className="btn primary" disabled={!!busy || !form.model.trim()} onClick={() => run('save')}>
          {busy === 'save' ? <Loader2 size={14} className="spin" /> : <Check size={14} />} {t('ai.save')}
        </button>
        {s && (
          <button type="button" className="btn ghost" onClick={remove}>
            <Trash2 size={14} /> {t('ai.remove')}
          </button>
        )}
      </div>
      </div>
      )}
      <p className="muted small">{t('ai.usageToday', { own: fmt(ownUsed), shared: fmt(sharedUsed) })}</p>
    </section>
  );
}
