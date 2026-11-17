import { EventEmitter } from 'node:events';
import type { ProjectEvent } from '@texdraft/shared';

/**
 * 项目级事件总线。单进程用 EventEmitter；多实例部署时替换为 Redis Pub/Sub。
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publishProjectEvent(projectId: string, event: ProjectEvent) {
  bus.emit(projectId, event);
}

export function subscribeProjectEvents(projectId: string, fn: (e: ProjectEvent) => void): () => void {
  bus.on(projectId, fn);
  return () => bus.off(projectId, fn);
}
