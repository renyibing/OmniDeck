import type { ConcurrencyConfig, TaskInstance } from './types';

export interface WorkerPoolSnapshot {
  active: number;
  queued: number;
  completed: number;
}

export class AgentWorkerPool {
  private active = new Set<string>();
  private queue: TaskInstance[] = [];
  private completed = 0;

  constructor(private readonly config: ConcurrencyConfig) {}

  enqueue(task: TaskInstance): TaskInstance {
    if (this.active.has(task.id) || this.queue.some(queued => queued.id === task.id)) return task;
    if (this.active.size < this.config.maxConcurrentAI) {
      this.active.add(task.id);
      task.status = 'RUNNING';
      task.attempts += 1;
      task.startedAt = Date.now();
      task.updatedAt = task.startedAt;
      return task;
    }
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    task.status = 'WAITING';
    task.updatedAt = Date.now();
    return task;
  }

  finish(taskId: string): TaskInstance | undefined {
    if (!this.active.has(taskId)) return undefined;
    this.completed += 1;
    return this.release(taskId);
  }

  release(taskId: string): TaskInstance | undefined {
    if (!this.active.delete(taskId)) return undefined;
    const next = this.queue.shift();
    if (next) {
      this.active.add(next.id);
      next.status = 'RUNNING';
      next.attempts += 1;
      next.startedAt = Date.now();
      next.updatedAt = next.startedAt;
    }
    return next;
  }

  retry(task: TaskInstance): TaskInstance {
    if (task.attempts >= this.config.maxRetries) {
      task.status = 'FAILED';
      task.updatedAt = Date.now();
      return task;
    }
    this.cancel(task.id);
    task.status = 'WAITING';
    task.error = undefined;
    task.finishedAt = undefined;
    task.updatedAt = Date.now();
    return this.enqueue(task);
  }

  cancel(taskId: string): boolean {
    const active = this.active.delete(taskId);
    const before = this.queue.length;
    this.queue = this.queue.filter(task => task.id !== taskId);
    return active || before !== this.queue.length;
  }

  isActive(taskId: string): boolean { return this.active.has(taskId); }
  isQueued(taskId: string): boolean { return this.queue.some(task => task.id === taskId); }

  snapshot(): WorkerPoolSnapshot { return { active: this.active.size, queued: this.queue.length, completed: this.completed }; }
}

export type ResourceKind = 'AI' | 'VLM' | 'ADB' | 'IOS';

export class ResourceLimiter {
  private active: Record<ResourceKind, number> = { AI: 0, VLM: 0, ADB: 0, IOS: 0 };
  private readonly limits: Record<ResourceKind, number>;
  private readonly waiters: Record<ResourceKind, Array<{ resolve: () => void; reject: (reason?: unknown) => void; signal?: AbortSignal }>> = { AI: [], VLM: [], ADB: [], IOS: [] };

  constructor(config: ConcurrencyConfig) {
    this.limits = { AI: config.maxConcurrentAI, VLM: config.maxConcurrentVLM, ADB: config.maxConcurrentADB, IOS: config.maxConcurrentIOS };
  }

  acquire(kind: ResourceKind): boolean {
    if (this.active[kind] >= this.limits[kind]) return false;
    this.active[kind] += 1;
    return true;
  }

  acquireWait(kind: ResourceKind, signal?: AbortSignal): Promise<void> {
    if (this.acquire(kind)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      const waiter = { resolve, reject, signal };
      this.waiters[kind].push(waiter);
      signal?.addEventListener('abort', () => {
        const index = this.waiters[kind].indexOf(waiter);
        if (index >= 0) this.waiters[kind].splice(index, 1);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  release(kind: ResourceKind): void {
    this.active[kind] = Math.max(0, this.active[kind] - 1);
    while (this.waiters[kind].length) {
      const waiter = this.waiters[kind].shift()!;
      if (waiter.signal?.aborted) continue;
      this.active[kind] += 1;
      waiter.resolve();
      break;
    }
  }
  snapshot() { return { ...this.active }; }
  waiting(kind: ResourceKind): number { return this.waiters[kind].length; }
}

export class RateLimiter {
  private timestamps: number[] = [];
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  tryAcquire(now = Date.now()): boolean {
    this.timestamps = this.timestamps.filter(timestamp => now - timestamp < this.windowMs);
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(now);
    return true;
  }
}
