import { describe, expect, it } from 'vitest';
import { agentActionSchema, describeAgentAction, isSensitiveGoalOrAction } from './agentActions';

const base = {
  actionId: 'action-1',
  deviceId: 'device-01',
  taskInstanceId: 'task-1',
  source: 'MOCK_PLANNER' as const,
  reason: 'test action',
};

describe('agent action schema', () => {
  it('rejects arbitrary shell/raw command actions', () => {
    expect(() => agentActionSchema.parse({ ...base, type: 'shell', command: 'adb shell input tap 1 1' })).toThrow();
    expect(() => agentActionSchema.parse({ ...base, type: 'raw', payload: 'adb shell input tap 1 1' })).toThrow();
  });

  it('redacts input_text in log descriptions', () => {
    const action = agentActionSchema.parse({ ...base, type: 'input_text', text: 'secret password' });
    const message = describeAgentAction(action);
    expect(message).toContain('agentAction=input_text');
    expect(message).toContain('redactedLength=15');
    expect(message).not.toContain('secret password');
  });

  it('detects sensitive goals and reasons before execution', () => {
    const action = agentActionSchema.parse({ ...base, type: 'tap_element', selector: { text: 'Publish' }, reason: '发布评论前需要确认' });
    expect(isSensitiveGoalOrAction('打开页面并发布评论', action)).toBe(true);
  });
});
