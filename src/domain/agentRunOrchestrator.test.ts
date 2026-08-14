import { describe, expect, it } from 'vitest';
import { AgentRunOrchestrator, addTaskLatency, addTaskPlannerUsage, finishTaskRun, recordTaskStepSuccess } from './agentRunOrchestrator';
import type { TaskInstance } from './types';

function makeTask(overrides: Partial<TaskInstance> = {}): TaskInstance {
  const now = 1_000;
  return {
    id: 'task-1',
    deviceId: 'device-01',
    goal: 'verify dashboard',
    status: 'RUNNING',
    priority: 1,
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('AgentRunOrchestrator', () => {
  it('runs until maxSteps and calls the max-step handler once', async () => {
    const task = makeTask({ maxSteps: 3 });
    let stepCalls = 0;
    let maxStepIndex: number | null = null;
    const orchestrator = new AgentRunOrchestrator({
      task,
      maxSteps: 3,
      plannerProviderId: 'test-provider',
      shouldContinue: () => task.status === 'RUNNING',
      runStep: async ({ stepIndex }) => {
        stepCalls += 1;
        recordTaskStepSuccess(task, stepIndex + 1, 2_000 + stepIndex);
        return 'CONTINUE';
      },
      onMaxSteps: stepIndex => {
        maxStepIndex = stepIndex;
        task.status = 'FAILED';
      },
      now: () => 1_234,
    });

    const result = await orchestrator.run(new AbortController().signal);

    expect(result).toBe('STOPPED');
    expect(stepCalls).toBe(3);
    expect(maxStepIndex).toBe(3);
    expect(task.runStartedAt).toBe(1_234);
    expect(task.plannerProviderId).toBe('test-provider');
    expect(task.completedSteps).toBe(3);
  });

  it('stops immediately when a step enters human approval', async () => {
    const task = makeTask({ maxSteps: 10 });
    const orchestrator = new AgentRunOrchestrator({
      task,
      maxSteps: 10,
      plannerProviderId: 'approval-provider',
      shouldContinue: () => task.status === 'RUNNING',
      runStep: async () => {
        task.status = 'WAITING_APPROVAL';
        return 'WAITING_APPROVAL';
      },
      onMaxSteps: () => { throw new Error('should not be called'); },
    });

    await expect(orchestrator.run(new AbortController().signal)).resolves.toBe('WAITING_APPROVAL');
    expect(task.currentStepIndex).toBe(0);
  });

  it('accumulates planner usage and latency on the task only', () => {
    const task = makeTask();
    addTaskPlannerUsage(task, { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0.001 });
    addTaskPlannerUsage(task, { promptTokens: 4, completionTokens: 1, totalTokens: 5 });
    addTaskLatency(task, { plannerMs: 20, actionMs: 30, verificationMs: 40, totalStepMs: 100 });
    finishTaskRun(task, 2_500);

    expect(task.tokenUsage).toMatchObject({ promptTokens: 14, completionTokens: 6, totalTokens: 20, estimatedCostUsd: 0.001, known: true });
    expect(task.latencyMs).toMatchObject({ plannerMs: 20, actionMs: 30, verificationMs: 40, totalStepMs: 100, totalRunMs: 0 });
  });
});
