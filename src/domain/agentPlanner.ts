import type { AgentAction } from './agentActions';
import { containsSensitiveKeyword, makeAgentActionId } from './agentActions';
import type { AgentObservation } from './observationBuilder';
import { extractFeedScrollGoal, planFeedScroll } from './playbooks/catalog';

export class DeterministicAgentPlanner {
  plan(observation: AgentObservation): AgentAction {
    const goal = observation.goal.trim();
    const base = {
      actionId: makeAgentActionId(observation.taskInstanceId, observation.currentStep, 'planned'),
      deviceId: observation.deviceId,
      taskInstanceId: observation.taskInstanceId,
      source: 'MOCK_PLANNER' as const,
    };

    if (containsSensitiveKeyword(goal) && !observation.approvalGranted) {
      return { ...base, type: 'request_human', reason: 'Goal matches sensitive-action approval policy' };
    }

    const tapText = extractValue(goal, /tap\s+text\s*[:：]\s*([^\n;]+)/iu);
    if (tapText) {
      return observation.currentStep === 0
        ? { ...base, type: 'tap_element', selector: { text: tapText, mustBeEnabled: true, mustBeClickable: false }, reason: `Tap element with text "${tapText}"` }
        : { ...base, type: 'finish', reason: 'tap text goal already executed' };
    }

    const tapResource = extractValue(goal, /tap\s+(?:resource|resourceId)\s*[:：]\s*([^\n;]+)/iu);
    if (tapResource) {
      return observation.currentStep === 0
        ? { ...base, type: 'tap_element', selector: { resourceId: tapResource, mustBeEnabled: true, mustBeClickable: false }, reason: `Tap element with resourceId "${tapResource}"` }
        : { ...base, type: 'finish', reason: 'tap resource goal already executed' };
    }

    const tapDesc = extractValue(goal, /tap\s+(?:desc|contentDesc)\s*[:：]\s*([^\n;]+)/iu);
    if (tapDesc) {
      return observation.currentStep === 0
        ? { ...base, type: 'tap_element', selector: { contentDesc: tapDesc, mustBeEnabled: true, mustBeClickable: false }, reason: `Tap element with contentDesc "${tapDesc}"` }
        : { ...base, type: 'finish', reason: 'tap contentDesc goal already executed' };
    }

    const inputText = extractValue(goal, /input\s+text\s*[:：]\s*([^\n;]+)/iu);
    if (inputText) {
      return observation.currentStep === 0
        ? { ...base, type: 'input_text', text: inputText, reason: 'Input text from deterministic goal rule' }
        : { ...base, type: 'finish', reason: 'input text goal already executed' };
    }

    if (/\bback\b|返回/u.test(goal)) {
      return observation.currentStep === 0
        ? { ...base, type: 'back', reason: 'Back command from deterministic goal rule' }
        : { ...base, type: 'finish', reason: 'back goal already executed' };
    }

    if (/\bhome\b|主页|主屏/u.test(goal)) {
      return observation.currentStep === 0
        ? { ...base, type: 'home', reason: 'Home command from deterministic goal rule' }
        : { ...base, type: 'finish', reason: 'home goal already executed' };
    }

    const feedGoal = extractFeedScrollGoal(goal);
    if (feedGoal) {
      return planFeedScroll(observation, base, feedGoal);
    }

    const searchGoal = extractSearchGoal(goal);
    if (searchGoal) {
      return planShoppingSearch(observation, base, searchGoal);
    }

    const launchApp = extractValue(goal, /(?:open|launch)\s+app\s*[:：]\s*([^\n;]+)/iu)
      ?? resolveKnownAppId(goal);
    if (launchApp) {
      return observation.currentStep === 0
        ? { ...base, type: 'launch_app', appId: launchApp, reason: `Launch app "${launchApp}"` }
        : { ...base, type: 'finish', reason: 'launch app goal already executed' };
    }

    if (/open\s+app|launch\s+app|打开.*app|打开应用/iu.test(goal)) {
      return observation.currentStep === 0
        ? { ...base, type: 'wait', durationMs: 20, reason: 'Generic open app goal needs a concrete app id; wait for current app state' }
        : { ...base, type: 'finish', reason: 'generic open app observation completed' };
    }

    if (/\bfinish\b|完成/u.test(goal)) return { ...base, type: 'finish', reason: 'Goal explicitly requests finish' };

    if (/\b(check|verify)\b|检查|验证/iu.test(goal)) {
      return observation.currentStep === 0
        ? { ...base, type: 'wait', durationMs: 20, reason: 'Verification goal uses screenshot/UI observation before finishing' }
        : { ...base, type: 'finish', reason: 'verification observation completed' };
    }

    if (observation.approvalGranted) return { ...base, type: 'finish', reason: 'Human approval recorded; first mock planner version stops before sensitive execution' };
    return { ...base, type: 'request_human', reason: 'Deterministic planner could not infer a safe selector-driven action' };
  }
}

function extractValue(input: string, pattern: RegExp): string | null {
  const value = input.match(pattern)?.[1]?.trim();
  return value ? value.replace(/[。.;]\s*$/u, '').trim() : null;
}

const KNOWN_ANDROID_APPS: Array<{ pattern: RegExp; appId: string }> = [
  { pattern: /淘宝|taobao/iu, appId: 'com.taobao.taobao' },
  { pattern: /闲鱼|idlefish/iu, appId: 'com.taobao.idlefish' },
  { pattern: /支付宝|alipay/iu, appId: 'com.eg.android.AlipayGphone' },
  { pattern: /微信|wechat/iu, appId: 'com.tencent.mm' },
  { pattern: /抖音|douyin/iu, appId: 'com.ss.android.ugc.aweme' },
  { pattern: /快手|kuaishou/iu, appId: 'com.smile.gifmaker' },
  { pattern: /今日头条|toutiao/iu, appId: 'com.ss.android.article.news' },
];

function normalizeAdbSearchQuery(query: string): string {
  if (/mac\s*mini/iu.test(query)) {
    const ram = query.match(/(\d+)\s*G/iu)?.[0]?.replace(/\s+/g, '') ?? '16G';
    return `Mac mini M4 ${ram}`;
  }
  const ascii = query.replace(/[^\x20-\x7e]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return ascii || query;
}

function resolveKnownAppId(goal: string): string | null {
  if (!/(?:打开|启动|open|launch|start)/iu.test(goal)) return null;
  return KNOWN_ANDROID_APPS.find(app => app.pattern.test(goal))?.appId ?? null;
}

interface ShoppingSearchGoal {
  appId: string;
  query: string;
  lowestPrice: boolean;
}

function extractSearchGoal(goal: string): ShoppingSearchGoal | null {
  const query = extractValue(goal, /(?:搜索|搜一下|查找|search(?:\s+for)?)\s*[:：]?\s*(.+)/iu);
  if (!query) return null;
  const lowestPrice = /最低|最便宜|价格最低|从低到高|lowest\s*price|cheapest/iu.test(goal);
  const cleaned = query
    .replace(/的商品|商品/gu, ' ')
    .replace(/最低价格|最低价|最便宜|价格最低/gu, ' ')
    .replace(/\bmini\s*4\b/iu, 'mini M4')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    appId: KNOWN_ANDROID_APPS.find(app => app.pattern.test(goal))?.appId ?? 'com.taobao.taobao',
    query: normalizeAdbSearchQuery(cleaned || query.trim()),
    lowestPrice,
  };
}

function planShoppingSearch(
  observation: AgentObservation,
  base: { actionId: string; deviceId: string; taskInstanceId: string; source: 'MOCK_PLANNER' },
  goal: ShoppingSearchGoal,
): AgentAction {
  const history = [observation.lastActionResult, ...observation.actionHistory.map(event => event.message)]
    .filter(Boolean)
    .join('\n');
  const nodes = observation.uiHierarchy.actionableNodes;
  const hasText = (pattern: RegExp) => nodes.some(node => pattern.test(node.text) || pattern.test(node.contentDesc));
  const inTargetApp = observation.currentApp.includes(goal.appId) || /taobao|淘宝/iu.test(observation.currentApp);
  const launched = inTargetApp || /launch_app|Launch app/.test(history);
  const typed = /input_text|redactedLength|Enter product search query/.test(history);
  const submitted = /Submit Taobao search|key=Enter|Submit search query/.test(history);
  const sorted = /Sort search results by price|从低到高/.test(history);

  if (!launched) {
    return { ...base, type: 'launch_app', appId: goal.appId, reason: `Launch ${goal.appId} before searching` };
  }
  const openedSort = /Open Taobao price sort/.test(history);

  if (inTargetApp && observation.uiHierarchy.nodeCount === 0 && !typed && !submitted && !/Wait for Taobao home|Focus Taobao search field/.test(history)) {
    return { ...base, type: 'wait', durationMs: 2_000, reason: 'Wait for Taobao home' };
  }
  if (!typed && !submitted && hasText(/去使用|消费券榜单|七夕/u)) {
    return { ...base, type: 'back', reason: 'Dismiss blocking Taobao coupon popup before search' };
  }
  if (!typed && !submitted && !/Focus Taobao search field/.test(history)) {
    return { ...base, type: 'tap', point: TAOBAO_SEARCH_FIELD, reason: 'Focus Taobao search field' };
  }
  if (!typed && !submitted) {
    return { ...base, type: 'input_text', text: goal.query, reason: 'Enter product search query' };
  }
  if (!submitted) {
    if (hasText(/^搜索$/u)) {
      return {
        ...base,
        type: 'tap_element',
        selector: { text: '搜索', mustBeEnabled: true, mustBeClickable: false },
        reason: 'Submit Taobao search',
      };
    }
    return { ...base, type: 'tap', point: TAOBAO_SEARCH_SUBMIT, reason: 'Submit Taobao search' };
  }
  if (goal.lowestPrice && !sorted) {
    if (hasText(/从低到高/u)) {
      return {
        ...base,
        type: 'tap_element',
        selector: { text: '从低到高', mustBeEnabled: true, mustBeClickable: false },
        reason: 'Sort search results by price',
      };
    }
    if (hasText(/^价格$/u)) {
      return {
        ...base,
        type: 'tap_element',
        selector: { text: '价格', mustBeEnabled: true, mustBeClickable: false },
        reason: 'Sort search results by price',
      };
    }
    if (!openedSort && !/Wait for Taobao search results/.test(history)) {
      return { ...base, type: 'wait', durationMs: 1_200, reason: 'Wait for Taobao search results before sorting' };
    }
    if (!openedSort) {
      return { ...base, type: 'tap', point: TAOBAO_PRICE_SORT_TAB, reason: 'Open Taobao price sort' };
    }
    return { ...base, type: 'tap', point: TAOBAO_PRICE_LOW_TO_HIGH, reason: 'Sort search results by price' };
  }
  return { ...base, type: 'finish', reason: 'Search completed' };
}

const TAOBAO_SEARCH_FIELD = { x: 0.4, y: 0.1 };
const TAOBAO_SEARCH_SUBMIT = { x: 0.85, y: 0.1 };
const TAOBAO_PRICE_SORT_TAB = { x: 0.14, y: 0.11 };
const TAOBAO_PRICE_LOW_TO_HIGH = { x: 0.3, y: 0.22 };
