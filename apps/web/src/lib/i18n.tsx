import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { messages, type Locale, type MessageKey } from './locales';

/**
 * 轻量国际化：中文 / English。
 *  - 默认跟随浏览器语言，用户选择后保存在 localStorage
 *  - t('key', { name }) 支持 {name} 占位符
 *  - 词条定义在 ./locales.ts，test/i18n.test.mts 会检查所有 t() 调用的 key 在两种语言中都存在
 */

const STORAGE_KEY = 'tp.locale';
export const LOCALES: { value: Locale; label: string }[] = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
];

function detectLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'zh-CN' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export type TFunction = (key: MessageKey, vars?: Record<string, string | number>) => string;

function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>) {
  let s: string = messages[locale][key] ?? messages.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

const I18nContext = createContext<{ locale: Locale; setLocale: (l: Locale) => void; t: TFunction } | null>(null);

/** 组件外使用（如 lib 中的工具函数）：读取当前语言 */
let currentLocale: Locale = typeof localStorage !== 'undefined' ? detectLocale() : 'zh-CN';
export const tStatic: TFunction = (key, vars) => translate(currentLocale, key, vars);
export const getLocale = () => currentLocale;

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const setLocale = useCallback((l: Locale) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLocaleState(l);
  }, []);
  useEffect(() => {
    currentLocale = locale;
    document.documentElement.lang = locale;
  }, [locale]);
  const t = useCallback<TFunction>((key, vars) => translate(locale, key, vars), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

export function useT() {
  return useI18n().t;
}

/** 相对时间（“3 分钟前” / “3 minutes ago”） */
export function formatRelative(iso: string, locale: Locale) {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString(locale);
}
