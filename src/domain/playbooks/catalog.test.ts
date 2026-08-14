import { describe, expect, it } from 'vitest';
import type { AgentObservation } from '../observationBuilder';
import { extractFeedScrollGoal, planFeedScroll } from './catalog';

const baseObservation: AgentObservation = {
  deviceId: 'device-01',
  platform: 'ANDROID',
  currentApp: 'Omni Market',
  taskInstanceId: 'task-1',
  goal: '刷抖音 3 条',
  currentStep: 0,
  approvalGranted: false,
  screenshot: { purpose: 'AI', source: 'ON_DEMAND_SCREENSHOT', width: 1440, height: 2560, capturedAt: 1 },
  uiHierarchy: { capturedAt: 1, nodeCount: 0, actionableNodes: [] },
  lastActionResult: null,
  actionHistory: [],
};

const base = {
  actionId: 'task-1:step-0:planned',
  deviceId: 'device-01',
  taskInstanceId: 'task-1',
  source: 'MOCK_PLANNER' as const,
};

describe('feed scroll playbooks', () => {
  it('parses douyin and kuaishou browse goals without inventing likes', () => {
    expect(extractFeedScrollGoal('刷抖音 8 条')).toMatchObject({
      playbook: { id: 'douyin.feed_scroll', appId: 'com.ss.android.ugc.aweme' },
      count: 8,
    });
    expect(extractFeedScrollGoal('playbook:kuaishou.feed_scroll count=5 dwellMs=3000')).toMatchObject({
      playbook: { id: 'kuaishou.feed_scroll', appId: 'com.smile.gifmaker' },
      count: 5,
      dwellMs: 3_000,
    });
    expect(extractFeedScrollGoal('打开抖音')).toBeNull();
    expect(extractFeedScrollGoal('刷抖音 99 条')?.count).toBe(8);
  });

  it('plans an isolated douyin launch → wait → swipe → dwell → finish loop', () => {
    const parsed = extractFeedScrollGoal('刷抖音 2 条');
    expect(parsed).toBeTruthy();
    if (!parsed) return;

    expect(planFeedScroll(baseObservation, base, parsed)).toMatchObject({
      type: 'launch_app',
      appId: 'com.ss.android.ugc.aweme',
    });
    expect(planFeedScroll({ ...baseObservation, platform: 'IOS', deviceId: 'device-07' }, base, parsed)).toMatchObject({
      type: 'launch_app',
      appId: 'com.ss.iphone.ugc.Aweme',
    });

    const inApp = { ...baseObservation, currentApp: 'com.ss.android.ugc.aweme', currentStep: 1 };
    expect(planFeedScroll(inApp, base, parsed)).toMatchObject({ type: 'wait', reason: 'Wait for douyin feed' });

    const ready = {
      ...inApp,
      currentStep: 2,
      actionHistory: [{ id: '1', time: '00:00:00', kind: 'ACTION' as const, message: 'Wait for douyin feed' }],
    };
    expect(planFeedScroll(ready, base, parsed)).toMatchObject({
      type: 'swipe',
      from: { x: 0.5, y: 0.78 },
      to: { x: 0.5, y: 0.28 },
      durationMs: 280,
      reason: 'Scroll douyin feed item 1/2',
    });

    const afterSwipe = {
      ...ready,
      currentStep: 3,
      lastActionResult: 'agentAction=swipe reason=Scroll douyin feed item 1/2 result=SUCCESS',
      actionHistory: [
        ...ready.actionHistory,
        { id: '2', time: '00:00:01', kind: 'ACTION' as const, message: 'Scroll douyin feed item 1/2' },
      ],
    };
    expect(planFeedScroll(afterSwipe, base, parsed)).toMatchObject({
      type: 'wait',
      durationMs: 2_500,
      reason: 'Dwell on douyin item 1/2',
    });

    const duplicatedThinkAndAction = {
      ...ready,
      currentStep: 3,
      lastActionResult: 'agentAction=swipe reason=Scroll douyin feed item 1/3 from={"x":0.5,"y":0.78} result=SUCCESS',
      actionHistory: [
        ...ready.actionHistory,
        { id: '2', time: '00:00:01', kind: 'THINK' as const, message: 'agentAction=swipe reason=Scroll douyin feed item 1/3 type=swipe' },
        { id: '3', time: '00:00:01', kind: 'ACTION' as const, message: 'agentAction=swipe reason=Scroll douyin feed item 1/3 from={"x":0.5,"y":0.78} result=SUCCESS' },
      ],
    };
    expect(planFeedScroll(duplicatedThinkAndAction, base, { ...parsed, count: 3 })).toMatchObject({
      type: 'wait',
      reason: 'Dwell on douyin item 1/3',
    });

    const done = {
      ...afterSwipe,
      currentStep: 6,
      lastActionResult: 'agentAction=swipe reason=Scroll douyin feed item 2/2 result=SUCCESS',
      actionHistory: [
        ...afterSwipe.actionHistory,
        { id: '3', time: '00:00:02', kind: 'ACTION' as const, message: 'Dwell on douyin item 1/2' },
        { id: '4', time: '00:00:03', kind: 'ACTION' as const, message: 'Scroll douyin feed item 2/2' },
        { id: '5', time: '00:00:04', kind: 'ACTION' as const, message: 'Dwell on douyin item 2/2' },
      ],
    };
    expect(planFeedScroll(done, base, parsed)).toMatchObject({
      type: 'finish',
      reason: 'douyin feed scroll completed (2/2)',
    });
  });

  it('uses kuaishou package and swipe path, and dismisses popups before scrolling', () => {
    const parsed = extractFeedScrollGoal('刷快手 3 条');
    expect(parsed?.playbook.appId).toBe('com.smile.gifmaker');
    if (!parsed) return;

    const popup = {
      ...baseObservation,
      goal: '刷快手 3 条',
      currentApp: 'com.smile.gifmaker',
      currentStep: 2,
      actionHistory: [{ id: '1', time: '00:00:00', kind: 'ACTION' as const, message: 'Wait for kuaishou feed' }],
      uiHierarchy: {
        capturedAt: 1,
        nodeCount: 1,
        actionableNodes: [{
          id: 'node-1', text: '我知道了', resourceId: '', contentDesc: '', className: 'TextView',
          bounds: { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40, centerX: 50, centerY: 20 },
          clickable: true, enabled: true, focused: false,
        }],
      },
    };
    expect(planFeedScroll(popup, base, parsed)).toMatchObject({
      type: 'tap_element',
      selector: { text: '我知道了' },
      reason: 'Dismiss kuaishou popup before feed scroll',
    });
    expect(planFeedScroll({
      ...popup,
      uiHierarchy: { capturedAt: 1, nodeCount: 0, actionableNodes: [] },
    }, base, parsed)).toMatchObject({
      type: 'swipe',
      from: { x: 0.5, y: 0.8 },
      to: { x: 0.5, y: 0.3 },
    });
  });

  it('does not treat another app launch in leftover history as the current playbook launch', () => {
    const parsed = extractFeedScrollGoal('刷快手 3 条');
    expect(parsed).toBeTruthy();
    if (!parsed) return;

    expect(planFeedScroll({
      ...baseObservation,
      platform: 'IOS',
      deviceId: 'device-07',
      taskInstanceId: 'task-2',
      goal: '刷快手 3 条',
      currentApp: 'com.omnideck.market.ios',
      actionHistory: [{
        id: '1',
        time: '00:00:00',
        kind: 'ACTION',
        message: 'agentAction=launch_app actionId=batch-old:step-0 reason=Launch com.jiangjia.gif before kuaishou feed scroll type=launch_app appId=com.jiangjia.gif result=ERROR',
      }],
    }, { ...base, deviceId: 'device-07', taskInstanceId: 'task-2' }, parsed)).toMatchObject({
      type: 'launch_app',
      appId: 'com.jiangjia.gif',
    });
  });

  it('ignores long legal copy when choosing a popup tap target', () => {
    const parsed = extractFeedScrollGoal('刷抖音 3 条');
    expect(parsed).toBeTruthy();
    if (!parsed) return;
    expect(planFeedScroll({
      ...baseObservation,
      currentApp: 'com.ss.android.ugc.aweme',
      currentStep: 2,
      actionHistory: [{ id: '1', time: '00:00:00', kind: 'ACTION', message: 'Wait for douyin feed' }],
      uiHierarchy: {
        capturedAt: 1,
        nodeCount: 2,
        actionableNodes: [
          { id: 'n1', text: `欢迎使用抖音。请阅读并同意并继续使用本应用。${'条款'.repeat(80)}`, resourceId: '', contentDesc: '', className: 'TextView', bounds: { left: 0, top: 0, right: 100, bottom: 200, width: 100, height: 200, centerX: 50, centerY: 100 }, clickable: false, enabled: true, focused: false },
          { id: 'n2', text: '同意', resourceId: '', contentDesc: '同意', className: 'Button', bounds: { left: 0, top: 220, right: 100, bottom: 260, width: 100, height: 40, centerX: 50, centerY: 240 }, clickable: true, enabled: true, focused: false },
        ],
      },
    }, base, parsed)).toMatchObject({
      type: 'tap_element',
      selector: { text: '同意' },
    });
  });

  it('taps iOS WLAN-only before a generic agree button', () => {
    const parsed = extractFeedScrollGoal('刷抖音 3 条');
    expect(parsed).toBeTruthy();
    if (!parsed) return;
    expect(planFeedScroll({
      ...baseObservation,
      platform: 'IOS',
      deviceId: 'device-07',
      goal: '刷抖音 3 条',
      currentApp: 'com.ss.iphone.ugc.Aweme',
      currentStep: 2,
      actionHistory: [{ id: '1', time: '00:00:00', kind: 'ACTION', message: 'Wait for douyin feed' }],
      uiHierarchy: {
        capturedAt: 1,
        nodeCount: 3,
        actionableNodes: [
          { id: 'n1', text: '不同意', resourceId: '', contentDesc: '不同意', className: 'XCUIElementTypeButton', bounds: { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40, centerX: 50, centerY: 20 }, clickable: true, enabled: true, focused: false },
          { id: 'n2', text: '同意并继续', resourceId: '', contentDesc: '同意并继续', className: 'XCUIElementTypeButton', bounds: { left: 0, top: 50, right: 100, bottom: 90, width: 100, height: 40, centerX: 50, centerY: 70 }, clickable: true, enabled: true, focused: false },
          { id: 'n3', text: '仅限无线局域网', resourceId: '', contentDesc: '仅限无线局域网', className: 'XCUIElementTypeButton', bounds: { left: 0, top: 100, right: 100, bottom: 140, width: 100, height: 40, centerX: 50, centerY: 120 }, clickable: true, enabled: true, focused: false },
        ],
      },
    }, { ...base, deviceId: 'device-07' }, parsed)).toMatchObject({
      type: 'tap_element',
      selector: { text: '仅限无线局域网' },
    });
  });
});
