import { describe, expect, it } from 'vitest';
import { DeterministicAgentPlanner } from './agentPlanner';
import type { AgentObservation } from './observationBuilder';

const baseObservation: AgentObservation = {
  deviceId: 'device-01',
  platform: 'ANDROID',
  currentApp: 'Omni Market',
  taskInstanceId: 'task-1',
  goal: 'finish',
  currentStep: 0,
  approvalGranted: false,
  screenshot: { purpose: 'AI', source: 'ON_DEMAND_SCREENSHOT', width: 1440, height: 2560, capturedAt: 1 },
  uiHierarchy: { capturedAt: 1, nodeCount: 0, actionableNodes: [] },
  lastActionResult: null,
  actionHistory: [],
};

describe('deterministic agent planner', () => {
  const planner = new DeterministicAgentPlanner();

  it('plans tap_element by text on the first step and finish on the next step', () => {
    const first = planner.plan({ ...baseObservation, goal: 'tap text:Open', currentStep: 0 });
    const second = planner.plan({ ...baseObservation, goal: 'tap text:Open', currentStep: 1 });

    expect(first).toMatchObject({ type: 'tap_element', selector: { text: 'Open', mustBeEnabled: true } });
    expect(second).toMatchObject({ type: 'finish' });
  });

  it('plans resourceId and contentDesc selector actions', () => {
    expect(planner.plan({ ...baseObservation, goal: 'tap resourceId:submit_button' })).toMatchObject({ type: 'tap_element', selector: { resourceId: 'submit_button' } });
    expect(planner.plan({ ...baseObservation, goal: 'tap desc:Account menu' })).toMatchObject({ type: 'tap_element', selector: { contentDesc: 'Account menu' } });
  });

  it('routes sensitive goals to request_human until approval is granted', () => {
    expect(planner.plan({ ...baseObservation, goal: '发布评论 tap text:Publish' })).toMatchObject({ type: 'request_human' });
    expect(planner.plan({ ...baseObservation, goal: '发布评论 tap text:Publish', approvalGranted: true })).toMatchObject({ type: 'tap_element' });
  });

  it('uses request_human for unknown goals instead of inventing actions', () => {
    expect(planner.plan({ ...baseObservation, goal: 'do something vague' })).toMatchObject({ type: 'request_human' });
  });

  it('maps Chinese open-app goals to known Android package ids', () => {
    expect(planner.plan({ ...baseObservation, goal: '打开淘宝' })).toMatchObject({ type: 'launch_app', appId: 'com.taobao.taobao' });
    expect(planner.plan({ ...baseObservation, goal: '打开淘宝', currentStep: 1 })).toMatchObject({ type: 'finish' });
    expect(planner.plan({ ...baseObservation, goal: 'launch app:com.taobao.taobao' })).toMatchObject({ type: 'launch_app', appId: 'com.taobao.taobao' });
    expect(planner.plan({ ...baseObservation, goal: '打开快手' })).toMatchObject({ type: 'launch_app', appId: 'com.smile.gifmaker' });
  });

  it('plans douyin and kuaishou feed-scroll playbooks without likes or follows', () => {
    expect(planner.plan({ ...baseObservation, goal: '刷抖音 8 条' })).toMatchObject({
      type: 'launch_app',
      appId: 'com.ss.android.ugc.aweme',
    });
    expect(planner.plan({ ...baseObservation, platform: 'IOS', deviceId: 'device-07', goal: '刷快手 3 条' })).toMatchObject({
      type: 'launch_app',
      appId: 'com.jiangjia.gif',
    });
    expect(planner.plan({
      ...baseObservation,
      goal: '刷快手 3 条',
      currentApp: 'com.smile.gifmaker',
      actionHistory: [{ id: '1', time: '00:00:00', kind: 'ACTION' as const, message: 'Wait for kuaishou feed' }],
    })).toMatchObject({
      type: 'swipe',
      from: { x: 0.5, y: 0.8 },
      to: { x: 0.5, y: 0.3 },
      durationMs: 280,
      reason: 'Scroll kuaishou feed item 1/3',
    });
    expect(planner.plan({ ...baseObservation, goal: '刷抖音并点赞' })).toMatchObject({ type: 'request_human' });
  });

  it('plans a multi-step Taobao search and lowest-price sort', () => {
    const goal = '打开淘宝并搜索苹果mac mini4 16G最低价格的商品';
    expect(planner.plan({ ...baseObservation, goal })).toMatchObject({ type: 'launch_app', appId: 'com.taobao.taobao' });

    const inApp = {
      ...baseObservation,
      goal,
      currentApp: 'com.taobao.taobao',
      uiHierarchy: {
        capturedAt: 1,
        nodeCount: 2,
        actionableNodes: [{
          id: 'node-1', text: '去使用', resourceId: '', contentDesc: '', className: 'TextView',
          bounds: { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40, centerX: 50, centerY: 20 },
          clickable: true, enabled: true, focused: false,
        }],
      },
    };
    expect(planner.plan(inApp)).toMatchObject({ type: 'back' });

    const afterWait = {
      ...baseObservation,
      goal,
      currentApp: 'com.taobao.taobao',
      uiHierarchy: { capturedAt: 1, nodeCount: 0, actionableNodes: [] },
      actionHistory: [{ id: '1', time: '00:00:00', kind: 'ACTION' as const, message: 'Wait for Taobao home' }],
    };
    expect(planner.plan(afterWait)).toMatchObject({ type: 'tap', point: { x: 0.4, y: 0.1 }, reason: 'Focus Taobao search field' });

    const focused = {
      ...baseObservation,
      goal,
      currentApp: 'com.taobao.taobao',
      actionHistory: [{ id: '1', time: '00:00:00', kind: 'ACTION' as const, message: 'Focus Taobao search field' }],
    };
    expect(planner.plan(focused)).toMatchObject({ type: 'input_text', text: 'Mac mini M4 16G' });

    const typed = {
      ...baseObservation,
      goal,
      currentApp: 'com.taobao.taobao',
      actionHistory: [
        { id: '1', time: '00:00:00', kind: 'ACTION' as const, message: 'action=input_text redactedLength=18 result=SUCCESS' },
      ],
      uiHierarchy: {
        capturedAt: 1,
        nodeCount: 2,
        actionableNodes: [{
          id: 'node-2', text: '搜索', resourceId: '', contentDesc: '', className: 'TextView',
          bounds: { left: 900, top: 80, right: 1040, bottom: 140, width: 140, height: 60, centerX: 970, centerY: 110 },
          clickable: true, enabled: true, focused: false,
        }],
      },
    };
    expect(planner.plan(typed)).toMatchObject({ type: 'tap_element', selector: { text: '搜索' }, reason: 'Submit Taobao search' });
    expect(planner.plan({
      ...typed,
      uiHierarchy: { capturedAt: 1, nodeCount: 0, actionableNodes: [] },
    })).toMatchObject({ type: 'tap', point: { x: 0.85, y: 0.1 }, reason: 'Submit Taobao search' });

    const results = {
      ...baseObservation,
      goal,
      currentApp: 'com.taobao.taobao',
      actionHistory: [
        { id: '1', time: '00:00:00', kind: 'ACTION' as const, message: 'action=input_text redactedLength=18 result=SUCCESS' },
        { id: '2', time: '00:00:01', kind: 'ACTION' as const, message: 'Submit Taobao search tap_element 搜索' },
      ],
      uiHierarchy: {
        capturedAt: 1,
        nodeCount: 2,
        actionableNodes: [{
          id: 'node-3', text: '价格', resourceId: '', contentDesc: '', className: 'TextView',
          bounds: { left: 400, top: 200, right: 500, bottom: 250, width: 100, height: 50, centerX: 450, centerY: 225 },
          clickable: true, enabled: true, focused: false,
        }],
      },
    };
    expect(planner.plan(results)).toMatchObject({ type: 'tap_element', selector: { text: '价格' }, reason: 'Sort search results by price' });

    expect(planner.plan({
      ...baseObservation,
      goal,
      currentApp: 'com.taobao.taobao',
      lastActionResult: 'agentAction=tap reason=Submit Taobao search result=SUCCESS',
      actionHistory: Array.from({ length: 8 }, (_, index) => ({
        id: String(index),
        time: '00:00:00',
        kind: 'OBSERVE' as const,
        message: `Agent observation step=${index} screenshot=1440x2560`,
      })),
    })).toMatchObject({ type: 'wait', reason: 'Wait for Taobao search results before sorting' });
  });
});
