import type { AgentAction } from '../agentActions';
import type { AgentObservation } from '../observationBuilder';
import type { FeedScrollGoal, FeedScrollPlaybook, PlannerBase } from './types';

const FEED_POPUP = /我知道了|同意并继续|^同意$|同意并使用|青少年|跳过|以后再说|关闭|暂不|仅限无线局域网|无线局域网与蜂窝网络/u;
const POPUP_PRIORITY = [
  /仅限无线局域网/u,
  /无线局域网与蜂窝网络/u,
  /同意并继续/u,
  /我知道了/u,
  /跳过/u,
  /以后再说/u,
  /关闭/u,
  /暂不/u,
  /^同意$/u,
  /同意并使用/u,
];


export const DOUYIN_FEED_SCROLL: FeedScrollPlaybook = {
  id: 'douyin.feed_scroll',
  name: 'douyin',
  appId: 'com.ss.android.ugc.aweme',
  iosAppId: 'com.ss.iphone.ugc.Aweme',
  aliases: /抖音|douyin/iu,
  swipeFrom: { x: 0.5, y: 0.78 },
  swipeTo: { x: 0.5, y: 0.28 },
  swipeDurationMs: 280,
  dwellMs: 2_500,
  popupText: FEED_POPUP,
  defaultCount: 3,
  maxCount: 8,
};

export const KUAISHOU_FEED_SCROLL: FeedScrollPlaybook = {
  id: 'kuaishou.feed_scroll',
  name: 'kuaishou',
  appId: 'com.smile.gifmaker',
  iosAppId: 'com.jiangjia.gif',
  aliases: /快手|kuaishou/iu,
  swipeFrom: { x: 0.5, y: 0.8 },
  swipeTo: { x: 0.5, y: 0.3 },
  swipeDurationMs: 280,
  dwellMs: 2_500,
  popupText: FEED_POPUP,
  defaultCount: 3,
  maxCount: 8,
};

export const FEED_SCROLL_PLAYBOOKS: FeedScrollPlaybook[] = [DOUYIN_FEED_SCROLL, KUAISHOU_FEED_SCROLL];

const FEED_INTENT = /(?:刷|浏览|滑动|上滑|feed\s*scroll|watch)|playbook\s*[:：]/iu;
const STEP_BUDGET = 23;

export function extractFeedScrollGoal(goal: string): FeedScrollGoal | null {
  if (!FEED_INTENT.test(goal)) return null;
  const playbook = FEED_SCROLL_PLAYBOOKS.find(item => item.aliases.test(goal) || goal.includes(item.id));
  if (!playbook) return null;
  return {
    playbook,
    count: parseCount(goal, playbook),
    dwellMs: parseDwellMs(goal, playbook),
  };
}

export function planFeedScroll(
  observation: AgentObservation,
  base: PlannerBase,
  goal: FeedScrollGoal,
): AgentAction {
  const playbook = goal.playbook;
  const history = playbookHistory(observation);
  const nodes = observation.uiHierarchy.actionableNodes;
  const popup = pickPopup(nodes, playbook.popupText);
  const appId = playbookAppId(playbook, observation.platform);
  const inTargetApp = observation.currentApp.includes(playbook.appId)
    || observation.currentApp.includes(playbook.iosAppId)
    || playbook.aliases.test(observation.currentApp);
  const launched = inTargetApp
    || history.text.includes(`Launch ${appId}`)
    || history.text.includes(`appId=${appId}`);
  const waitedHome = new RegExp(`Wait for ${playbook.name} feed`, 'u').test(history.text);
  const swipeCount = countSwipes(history.text, playbook.name);
  const lastWasSwipe = /Scroll \S+ feed item/.test(history.last ?? '');

  if (!launched) {
    return { ...base, type: 'launch_app', appId, reason: `Launch ${appId} before ${playbook.name} feed scroll` };
  }
  if (!waitedHome) {
    return { ...base, type: 'wait', durationMs: 2_000, reason: `Wait for ${playbook.name} feed` };
  }
  if (popup) {
    const label = popupLabel(popup, playbook.popupText);
    if (label) {
      return {
        ...base,
        type: 'tap_element',
        selector: { text: label, mustBeEnabled: true, mustBeClickable: false },
        reason: `Dismiss ${playbook.name} popup before feed scroll`,
      };
    }
    return { ...base, type: 'back', reason: `Dismiss ${playbook.name} popup before feed scroll` };
  }
  if (swipeCount >= goal.count || observation.currentStep >= STEP_BUDGET) {
    return {
      ...base,
      type: 'finish',
      reason: swipeCount >= goal.count
        ? `${playbook.name} feed scroll completed (${swipeCount}/${goal.count})`
        : `${playbook.name} feed scroll stopped at step budget after ${swipeCount}/${goal.count} items`,
    };
  }
  if (lastWasSwipe) {
    return { ...base, type: 'wait', durationMs: goal.dwellMs, reason: `Dwell on ${playbook.name} item ${swipeCount}/${goal.count}` };
  }
  return {
    ...base,
    type: 'swipe',
    from: playbook.swipeFrom,
    to: playbook.swipeTo,
    durationMs: playbook.swipeDurationMs,
    reason: `Scroll ${playbook.name} feed item ${swipeCount + 1}/${goal.count}`,
  };
}

export function playbookAppId(playbook: FeedScrollPlaybook, platform: AgentObservation['platform']): string {
  return platform === 'IOS' ? playbook.iosAppId : playbook.appId;
}

function countSwipes(history: string, name: string): number {
  const pattern = new RegExp(`Scroll ${name} feed item (\\d+)/`, 'gu');
  let maxIndex = 0;
  for (const match of history.matchAll(pattern)) {
    const index = Number(match[1]);
    if (Number.isInteger(index)) maxIndex = Math.max(maxIndex, index);
  }
  return maxIndex;
}

function playbookHistory(observation: AgentObservation): { text: string; last: string | null } {
  const taskId = observation.taskInstanceId;
  const scoped = observation.actionHistory.some(event => /actionId=/.test(event.message));
  const messages = observation.actionHistory
    .map(event => event.message)
    .filter(message => !scoped || message.includes(taskId));
  const last = observation.lastActionResult && (!scoped || observation.lastActionResult.includes(taskId))
    ? observation.lastActionResult
    : null;
  return { text: [last, ...messages].filter(Boolean).join('\n'), last };
}

const MAX_POPUP_LABEL = 40;

function pickPopup(
  nodes: AgentObservation['uiHierarchy']['actionableNodes'],
  popupText: RegExp,
) {
  const matches = nodes.filter(node => {
    const text = node.text.trim();
    const desc = node.contentDesc.trim();
    return (text.length > 0 && text.length <= MAX_POPUP_LABEL && popupText.test(text))
      || (desc.length > 0 && desc.length <= MAX_POPUP_LABEL && popupText.test(desc));
  });
  for (const pattern of POPUP_PRIORITY) {
    const hit = matches.find(node => pattern.test(node.text) || pattern.test(node.contentDesc));
    if (hit) return hit;
  }
  return matches[0] ?? null;
}

function popupLabel(
  node: AgentObservation['uiHierarchy']['actionableNodes'][number],
  popupText: RegExp,
): string | null {
  const text = node.text.trim();
  const desc = node.contentDesc.trim();
  if (text.length > 0 && text.length <= MAX_POPUP_LABEL && popupText.test(text)) return text;
  if (desc.length > 0 && desc.length <= MAX_POPUP_LABEL && popupText.test(desc)) return desc;
  return null;
}

function parseCount(goal: string, playbook: FeedScrollPlaybook): number {
  const matched = goal.match(/count\s*[=:]\s*(\d+)/iu)
    ?? goal.match(/(\d+)\s*(?:条|次|个|videos?|items?)/iu);
  const raw = matched ? Number(matched[1]) : playbook.defaultCount;
  if (!Number.isInteger(raw) || raw <= 0) return playbook.defaultCount;
  return Math.min(playbook.maxCount, Math.max(1, raw));
}

function parseDwellMs(goal: string, playbook: FeedScrollPlaybook): number {
  const seconds = goal.match(/停留\s*(\d+)\s*秒/u);
  if (seconds) return clampDwell(Number(seconds[1]) * 1_000);
  const explicit = goal.match(/dwell(?:Ms)?\s*[=:]\s*(\d+)/iu);
  if (explicit) return clampDwell(Number(explicit[1]));
  return playbook.dwellMs;
}

function clampDwell(value: number): number {
  if (!Number.isFinite(value)) return 2_500;
  return Math.min(8_000, Math.max(800, Math.round(value)));
}
