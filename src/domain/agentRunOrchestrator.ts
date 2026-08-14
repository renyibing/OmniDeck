import type { AgentPlannerUsage } from './agentPlannerProvider';
import type { TaskInstance } from './types';

export type AgentRunStepResult = 'CONTINUE' | 'FINISHED' | 'WAITING_APPROVAL' | 'STOPPED';

export interface AgentRunStepContext {
  task: TaskInstance;
  stepIndex: number;
  signal: AbortSignal;
}

export interface AgentRunOrchestratorOptions {
  task: TaskInstance;
  maxSteps: number;
  plannerProviderId: string;
  shouldContinue: () => boolean;
  runStep: (context: AgentRunStepContext) => Promise<AgentRunStepResult>;
  onMaxSteps: (stepIndex: number) => Promise<void> | void;
  now?: () => number;
}

export class AgentRunOrchestrator {
  private readonly now: () => number;

  constructor(private readonly options: AgentRunOrchestratorOptions) {
    this.now = options.now ?? Date.now;
  }

  async run(signal: AbortSignal): Promise<AgentRunStepResult> {
    beginTaskRun(this.options.task, this.options.maxSteps, this.options.plannerProviderId, this.now());
    while (this.options.shouldContinue() && currentStepIndex(this.options.task) < this.options.maxSteps) {
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const result = await this.options.runStep({ task: this.options.task, stepIndex: currentStepIndex(this.options.task), signal });
      if (result !== 'CONTINUE') return result;
    }
    if (this.options.shouldContinue()) {
      await this.options.onMaxSteps(currentStepIndex(this.options.task));
      return 'STOPPED';
    }
    return 'STOPPED';
  }
}

export function beginTaskRun(task: TaskInstance, maxSteps: number, plannerProviderId: string, now = Date.now()): void {
  task.maxSteps ??= maxSteps;
  task.currentStepIndex ??= 0;
  task.completedSteps ??= 0;
  task.runStartedAt ??= now;
  task.runEndedAt = undefined;
  task.plannerProviderId = plannerProviderId;
  task.latencyMs ??= { plannerMs: 0, actionMs: 0, verificationMs: 0, totalStepMs: 0, totalRunMs: 0 };
  task.tokenUsage ??= { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: null, known: false };
}

export function finishTaskRun(task: TaskInstance, now = Date.now()): void {
  task.runEndedAt = task.runEndedAt ?? now;
  task.latencyMs ??= { plannerMs: 0, actionMs: 0, verificationMs: 0, totalStepMs: 0, totalRunMs: 0 };
  task.latencyMs.totalRunMs = task.runStartedAt ? Math.max(0, task.runEndedAt - task.runStartedAt) : task.latencyMs.totalRunMs;
}

export function recordTaskObservation(task: TaskInstance, stepIndex: number, observedAt = Date.now()): void {
  task.currentStepIndex = stepIndex;
  task.lastObservationAt = observedAt;
  task.updatedAt = observedAt;
}

export function recordTaskStepSuccess(task: TaskInstance, nextStepIndex: number, verifiedAt = Date.now()): void {
  task.currentStepIndex = nextStepIndex;
  task.completedSteps = Math.max(task.completedSteps ?? 0, nextStepIndex);
  task.lastVerificationAt = verifiedAt;
  task.updatedAt = verifiedAt;
}

export function recordTaskStepFailure(task: TaskInstance, stepIndex: number, now = Date.now()): void {
  task.failedStepIndex = stepIndex;
  task.updatedAt = now;
}

export function addTaskPlannerUsage(task: TaskInstance, usage: AgentPlannerUsage | undefined): void {
  task.tokenUsage ??= { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: null, known: false };
  if (!usage) return;
  const prompt = finiteNumber(usage.promptTokens);
  const completion = finiteNumber(usage.completionTokens);
  const total = finiteNumber(usage.totalTokens);
  const cost = finiteNumber(usage.estimatedCostUsd);
  task.tokenUsage.promptTokens += prompt;
  task.tokenUsage.completionTokens += completion;
  task.tokenUsage.totalTokens += total || prompt + completion;
  task.tokenUsage.known = task.tokenUsage.known || prompt > 0 || completion > 0 || total > 0;
  if (cost > 0) task.tokenUsage.estimatedCostUsd = (task.tokenUsage.estimatedCostUsd ?? 0) + cost;
}

export function addTaskLatency(task: TaskInstance, latency: Partial<{ plannerMs: number; actionMs: number; verificationMs: number; totalStepMs: number }>): void {
  task.latencyMs ??= { plannerMs: 0, actionMs: 0, verificationMs: 0, totalStepMs: 0, totalRunMs: 0 };
  task.latencyMs.plannerMs += finiteNumber(latency.plannerMs);
  task.latencyMs.actionMs += finiteNumber(latency.actionMs);
  task.latencyMs.verificationMs += finiteNumber(latency.verificationMs);
  task.latencyMs.totalStepMs += finiteNumber(latency.totalStepMs);
}

function currentStepIndex(task: TaskInstance): number {
  return Math.max(0, Math.trunc(task.currentStepIndex ?? 0));
}

function finiteNumber(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}
