import type { User } from '@texdraft/shared';
import { createContext, useContext } from 'react';

export const UserContext = createContext<{ user: User; setUser: (u: User | null) => void } | null>(null);

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser outside provider');
  return ctx;
}

const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5f3dc4'];

/** 根据用户 id 生成稳定的协作光标颜色 */
export function userColor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}
