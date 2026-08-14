import { describe, expect, it } from 'vitest';
import { redactAgentActionForLog } from './agentActions';
import { appendAgentStepRecord, archiveStepTrace, createAgentStepRecord, makeScreenshotArtifactRef, updateAgentStepRecord } from './agentStepTrace';
import { DeviceManager } from './deviceManager';
import type { TaskInstance } from './types';

describe('agent step trace', () => {
  it('stores only redacted action and screenshot metadata', () => {
    const devices = new DeviceManager(1);
    const session = devices.get('device-01')!;
    const task: TaskInstance = {
      id: 'task-1',
      deviceId: 'device-01',
      goal: 'input text:secret password',
      status: 'RUNNING',
      priority: 1,
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    session.currentTask = task;
    session.taskContext = { goal: task.goal, step: 0, variables: {} };
    const record = appendAgentStepRecord(session, createAgentStepRecord(session, task, 0));

    updateAgentStepRecord(session, record.stepId, step => {
      step.plannedAction = redactAgentActionForLog({
        actionId: 'action-1',
        deviceId: 'device-01',
        taskInstanceId: task.id,
        source: 'MOCK_PLANNER',
        type: 'input_text',
        text: 'secret password',
        reason: 'test input redaction',
      });
      step.observation.screenshot = makeScreenshotArtifactRef({
        screenshot: { deviceId: 'device-01', capturedAt: 123, purpose: 'AI', width: 1440, height: 2560 },
        taskInstanceId: task.id,
        stepId: record.stepId,
        purpose: 'AI_OBSERVATION',
      });
    });
    archiveStepTrace(session);

    const serialized = JSON.stringify(session.memory.recentStepTrace);
    expect(serialized).toContain('redactedLength');
    expect(serialized).toContain('ON_DEMAND_SCREENSHOT');
    expect(serialized).not.toContain('secret password');
    expect(serialized).not.toContain('data');
  });
});
