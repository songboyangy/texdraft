import { useSyncExternalStore } from 'react';

/** 用户偏好（保存在 localStorage，多个组件间同步） */
export interface Settings {
  editorFontSize: number;
  lineWrapping: boolean;
}

const KEY = 'tp.settings.v1';
const DEFAULTS: Settings = { editorFontSize: 14, lineWrapping: true };

let current: Settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return DEFAULTS;
  }
})();
const listeners = new Set<() => void>();

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(current));
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20];
