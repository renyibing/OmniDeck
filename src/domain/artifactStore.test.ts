import { describe, expect, it } from 'vitest';
import { ArtifactStore, sanitizeArtifactValue } from './artifactStore';
import { makeScreenshotArtifactRef } from './agentStepTrace';

describe('agent artifact store', () => {
  it('keeps artifact records isolated by device and task', () => {
    const store = new ArtifactStore();
    store.addScreenshot(makeScreenshotArtifactRef({
      screenshot: { deviceId: 'device-01', capturedAt: 100, purpose: 'AI', width: 1440, height: 2560 },
      taskInstanceId: 'task-01',
      stepId: 'task-01:step-0',
      purpose: 'AI_OBSERVATION',
    }), 'AI_OBSERVATION_SCREENSHOT');
    store.addScreenshot(makeScreenshotArtifactRef({
      screenshot: { deviceId: 'device-02', capturedAt: 200, purpose: 'AI', width: 1440, height: 2560 },
      taskInstanceId: 'task-02',
      stepId: 'task-02:step-0',
      purpose: 'AI_OBSERVATION',
    }), 'AI_OBSERVATION_SCREENSHOT');

    expect(store.listTaskArtifacts('device-01', 'task-01')).toHaveLength(1);
    expect(store.listTaskArtifacts('device-01', 'task-02')).toHaveLength(0);
    expect(store.listTaskArtifacts('device-02', 'task-01')).toHaveLength(0);
    expect(store.summarizeTask('device-01', 'task-01')).toMatchObject({ deviceId: 'device-01', taskInstanceId: 'task-01', total: 1 });
  });

  it('returns bounded recent records without exposing screenshot binaries', () => {
    const store = new ArtifactStore();
    for (let index = 0; index < 4; index += 1) {
      store.addScreenshot(makeScreenshotArtifactRef({
        screenshot: { deviceId: 'device-01', capturedAt: 100 + index, purpose: 'AI', width: 1440, height: 2560 },
        taskInstanceId: 'task-01',
        stepId: `task-01:step-${index}`,
        purpose: 'POST_ACTION_VERIFICATION',
      }), 'POST_ACTION_SCREENSHOT');
    }

    const records = store.listTaskArtifacts('device-01', 'task-01', 2);
    expect(records).toHaveLength(2);
    expect(records.map(record => record.stepId)).toEqual(['task-01:step-2', 'task-01:step-3']);
    expect(records.every(record => record.hasBinary === false)).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/"data"\s*:/u);
  });

  it('redacts raw text and sensitive command strings from artifact payloads', () => {
    const sanitized = sanitizeArtifactValue({
      action: { type: 'input_text', text: 'secret password' },
      command: 'adb -s serial-01 shell input text secret%spassword',
      stderr: 'password=123456 token=abcdef',
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain('redactedLength');
    expect(serialized).not.toContain('secret password');
    expect(serialized).not.toContain('secret%spassword');
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('abcdef');
  });
});
