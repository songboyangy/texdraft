import type { ProjectEvent } from '@texdraft/shared';
import { useEffect, useRef } from 'react';

/** 订阅项目事件（文件树变化、编译开始/结束），断线自动重连（EventSource 内置） */
export function useProjectEvents(projectId: string, onEvent: (e: ProjectEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const es = new EventSource(`/api/projects/${projectId}/events`, { withCredentials: true });
    es.onmessage = (msg) => {
      try {
        handler.current(JSON.parse(msg.data));
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [projectId]);
}
