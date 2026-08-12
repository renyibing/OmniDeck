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
    if (this.active.size < this.config.maxConcurrentAI) {
      this.active.add(task.id);
      return { ...task, status: 'RUNNING', updatedAt: Date.now() };
    }
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    return { ...task, status: 'WAITING', updatedAt: Date.now() };
  }

  finish(taskId: string): TaskInstance | undefined {
    if (!this.active.delete(taskId)) return undefined;
    this.completed += 1;
    const next = this.queue.shift();
    if (next) this.active.add(next.id);
    return next ? { ...next, status: 'RUNNING', attempts: next.attempts + 1, updatedAt: Date.now() } : undefined;
  }

  retry(task: TaskInstance): TaskInstance {
    if (task.attempts >= this.config.maxRetries) return { ...task, status: 'FAILED', updatedAt: Date.now() };
    this.active.delete(task.id);
    return this.enqueue({ ...task, attempts: task.attempts + 1, status: 'WAITING', updatedAt: Date.now() });
  }

  cancel(taskId: string): boolean {
    const active = this.active.delete(taskId);
    const before = this.queue.length;
    this.queue = this.queue.filter(task => task.id !== taskId);
    return active || before !== this.queue.length;
  }

  snapshot(): WorkerPoolSnapshot { return { active: this.active.size, queued: this.queue.length, completed: this.completed }; }
}

export type ResourceKind = 'AI' | 'VLM' | 'ADB' | 'IOS';

export class ResourceLimiter {
  private active: Record<ResourceKind, number> = { AI: 0, VLM: 0, ADB: 0, IOS: 0 };
  private readonly limits: Record<ResourceKind, number>;

  constructor(config: ConcurrencyConfig) {
    this.limits = { AI: config.maxConcurrentAI, VLM: config.maxConcurrentVLM, ADB: config.maxConcurrentADB, IOS: config.maxConcurrentIOS };
  }

  acquire(kind: ResourceKind): boolean {
    if (this.active[kind] >= this.limits[kind]) return false;
    this.active[kind] += 1;
    return true;
  }

  release(kind: ResourceKind): void { this.active[kind] = Math.max(0, this.active[kind] - 1); }
  snapshot() { return { ...this.active }; }
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
