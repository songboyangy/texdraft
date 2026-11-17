/**
 * 先进先出的计数信号量：限制同时运行的任务数（例如编译），多出来的排队。
 * limit <= 0 表示不限。
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  get running() {
    return this.active;
  }
  get queued() {
    return this.waiters.length;
  }

  /** 立即能运行时返回 0，否则返回排队位置（从 1 开始），并在轮到时调用 onStart */
  private acquire(): { position: number; ready: Promise<void> } {
    if (this.limit <= 0 || this.active < this.limit) {
      this.active++;
      return { position: 0, ready: Promise.resolve() };
    }
    let resolve!: () => void;
    const ready = new Promise<void>((r) => (resolve = r));
    this.waiters.push(() => {
      this.active++;
      resolve();
    });
    return { position: this.waiters.length, ready };
  }

  private release() {
    this.active--;
    this.waiters.shift()?.();
  }

  /** 在信号量内执行 fn；需要排队时先调用 onQueued(位置) */
  async run<T>(fn: () => Promise<T>, onQueued?: (position: number) => void): Promise<T> {
    const { position, ready } = this.acquire();
    if (position > 0) onQueued?.(position);
    await ready;
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
