import type { ConcurrencyConfig, TaskInstance } from './types';
import { AgentWorkerPool, RateLimiter, ResourceLimiter } from './workerPool';

export class TaskScheduler {
  readonly workers: AgentWorkerPool;
  readonly resources: ResourceLimiter;
  readonly rateLimiter: RateLimiter;
  private batchSequence = 0;

  constructor(readonly config: ConcurrencyConfig) { this.workers = new AgentWorkerPool(config); this.resources = new ResourceLimiter(config); this.rateLimiter = new RateLimiter(config.rateLimitPerMinute ?? 60); }

  getScreenshotAnalysisFlow() {
    return ['TRIGGER_SCREENSHOT', 'VLM_ANALYZE', 'DEVICE_ACTION', 'WAIT_FOR_UI_CHANGE', 'TRIGGER_SCREENSHOT'] as const;
  }

  createBatch(goal: string, deviceIds: string[], priority = 1): TaskInstance[] {
    return this.createInstances(goal, deviceIds, priority).map(task => this.workers.enqueue(task));
  }

  createInstances(goal: string, deviceIds: string[], priority = 1): TaskInstance[] {
    const batchId = `batch-${Date.now()}-${++this.batchSequence}`;
    return deviceIds.map((deviceId, index) => {
      const now = Date.now();
      return { id: `${batchId}-${index + 1}`, batchId, deviceId, goal, status: 'WAITING', priority, attempts: 0, createdAt: now, updatedAt: now };
    });
  }
}
