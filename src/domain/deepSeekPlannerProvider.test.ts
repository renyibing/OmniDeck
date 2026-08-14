import { describe, expect, it, vi } from 'vitest';
import { DeepSeekPlannerProvider } from './deepSeekPlannerProvider';
import type { AgentObservation } from './observationBuilder';

const baseObservation: AgentObservation = {
  deviceId: 'device-01',
  platform: 'ANDROID',
  currentApp: 'Omni Market',
  taskInstanceId: 'task-1',
  goal: 'tap text:Continue',
  currentStep: 2,
  approvalGranted: false,
  screenshot: { purpose: 'AI', source: 'ON_DEMAND_SCREENSHOT', width: 1440, height: 2560, capturedAt: 10 },
  uiHierarchy: {
    capturedAt: 11,
    nodeCount: 2,
    actionableNodes: [
      {
        id: 'node-1',
        text: 'Continue',
        resourceId: 'com.omnideck:id/continue',
        contentDesc: '',
        className: 'android.widget.Button',
        bounds: { left: 10, top: 20, right: 120, bottom: 80, width: 110, height: 60, centerX: 65, centerY: 50 },
        clickable: true,
        enabled: true,
        focused: false,
      },
    ],
  },
  lastActionResult: null,
  actionHistory: [{ id: 'event-1', time: '10:00:00', kind: 'OBSERVE', message: 'input_text text=[REDACTED_TEXT]' }],
};

describe('DeepSeekPlannerProvider', () => {
  it('sends an OpenAI-compatible chat completion request and parses a whitelisted action', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedInit = init;
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              type: 'tap_element',
              selector: { text: 'Continue', mustBeEnabled: true },
              reason: 'Continue button is visible',
            }),
          },
        }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      });
    });
    const provider = new DeepSeekPlannerProvider({ apiKey: 'test-key', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-v4-flash', request });

    const result = await provider.plan(baseObservation);
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    const bodyText = JSON.stringify(body);

    expect(capturedUrl).toBe('https://api.deepseek.com/chat/completions');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json' });
    expect(body).toMatchObject({ model: 'deepseek-v4-flash', response_format: { type: 'json_object' } });
    expect(bodyText).toContain('ON_DEMAND_SCREENSHOT');
    expect(bodyText).not.toContain('data:image');
    expect(bodyText).not.toContain('base64');
    expect(result.action).toMatchObject({
      type: 'tap_element',
      source: 'LLM_PLANNER',
      deviceId: 'device-01',
      taskInstanceId: 'task-1',
      selector: { text: 'Continue', mustBeEnabled: true },
    });
    expect(result.usage).toMatchObject({ promptTokens: 12, completionTokens: 7, totalTokens: 19, estimatedCostUsd: null });
  });

  it('rejects non-whitelisted model output before execution', async () => {
    const provider = new DeepSeekPlannerProvider({
      apiKey: 'test-key',
      request: async () => jsonResponse({ choices: [{ message: { content: '{"type":"shell","command":"adb shell input tap 1 1"}' } }] }),
    });

    await expect(provider.plan(baseObservation)).rejects.toThrow();
  });

  it('rejects an action targeted at another device session', async () => {
    const provider = new DeepSeekPlannerProvider({
      apiKey: 'test-key',
      request: async () => jsonResponse({
        choices: [{
          message: { content: JSON.stringify({ type: 'finish', deviceId: 'device-02', reason: 'wrong target' }) },
        }],
      }),
    });

    await expect(provider.plan(baseObservation)).rejects.toThrow('expected device-01');
  });

  it('forwards abort signals to the HTTP request', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      controller.abort(new Error('cancelled'));
      if (init?.signal?.aborted) throw new Error('request aborted');
      return jsonResponse({ choices: [] });
    });
    const provider = new DeepSeekPlannerProvider({ apiKey: 'test-key', request });

    await expect(provider.plan(baseObservation, controller.signal)).rejects.toThrow('request aborted');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
