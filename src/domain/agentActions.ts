import { z } from 'zod';

const normalizedPointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});

const baseAgentActionSchema = z.object({
  actionId: z.string().trim().min(1).max(160),
  deviceId: z.string().trim().min(1),
  taskInstanceId: z.string().trim().min(1),
  source: z.enum(['MOCK_PLANNER', 'LLM_PLANNER', 'HUMAN_APPROVAL', 'SYSTEM']),
  reason: z.string().trim().min(1).max(1_000),
});

export const agentElementSelectorSchema = z.object({
  text: z.string().trim().min(1).max(500).optional(),
  resourceId: z.string().trim().min(1).max(500).optional(),
  contentDesc: z.string().trim().min(1).max(500).optional(),
  className: z.string().trim().min(1).max(500).optional(),
  mustBeClickable: z.boolean().default(false),
  mustBeEnabled: z.boolean().default(true),
}).refine(
  selector => Boolean(selector.text || selector.resourceId || selector.contentDesc),
  'tap_element selector requires text, resourceId, or contentDesc',
);

export const agentActionSchema = z.discriminatedUnion('type', [
  baseAgentActionSchema.extend({
    type: z.literal('tap_element'),
    selector: agentElementSelectorSchema,
  }),
  baseAgentActionSchema.extend({
    type: z.literal('tap'),
    point: normalizedPointSchema,
  }),
  baseAgentActionSchema.extend({
    type: z.literal('swipe'),
    from: normalizedPointSchema,
    to: normalizedPointSchema,
    durationMs: z.number().int().min(0).max(5_000).default(350),
  }),
  baseAgentActionSchema.extend({
    type: z.literal('input_text'),
    text: z.string().min(1).max(2_000),
  }),
  baseAgentActionSchema.extend({
    type: z.literal('press_key'),
    key: z.enum(['Enter', 'Backspace', 'Delete', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']),
  }),
  baseAgentActionSchema.extend({ type: z.literal('back') }),
  baseAgentActionSchema.extend({ type: z.literal('home') }),
  baseAgentActionSchema.extend({
    type: z.literal('launch_app'),
    appId: z.string().trim().min(1).max(240),
  }),
  baseAgentActionSchema.extend({
    type: z.literal('wait'),
    durationMs: z.number().int().min(0).max(30_000).default(500),
  }),
  baseAgentActionSchema.extend({ type: z.literal('request_human') }),
  baseAgentActionSchema.extend({ type: z.literal('finish') }),
]);

export type AgentElementSelector = z.infer<typeof agentElementSelectorSchema>;
export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentActionType = AgentAction['type'];
export type AgentActionLog = ReturnType<typeof redactAgentActionForLog>;

const sensitiveKeywords = [
  '发布评论', '发送私信', '点赞', '关注', '发布内容', '删除', '上传', '下单', '支付', '修改账号资料',
  'comment', 'direct message', 'private message', 'dm ', ' like ', 'follow', 'publish', 'post', 'delete', 'upload',
  'order', 'checkout', 'pay', 'payment', 'profile', 'account settings',
] as const;

export function parseAgentAction(value: unknown): AgentAction {
  return agentActionSchema.parse(value);
}

export function redactAgentActionForLog(action: AgentAction): Record<string, unknown> {
  if (action.type === 'input_text') {
    const { text: _text, ...rest } = action;
    return { ...rest, redactedLength: action.text.length };
  }
  return { ...action };
}

export function describeAgentAction(action: AgentAction): string {
  const redacted = redactAgentActionForLog(action);
  const details = Object.entries(redacted)
    .filter(([key]) => !['actionId', 'deviceId', 'taskInstanceId', 'source'].includes(key))
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ');
  return `agentAction=${action.type} actionId=${action.actionId} source=${action.source}${details ? ` ${details}` : ''}`;
}

export function isSensitiveGoalOrAction(goal: string, action: AgentAction): boolean {
  const actionText = JSON.stringify(redactAgentActionForLog(action));
  return containsSensitiveKeyword(`${goal} ${action.reason} ${actionText}`);
}

export function containsSensitiveKeyword(value: string): boolean {
  const haystack = ` ${value.toLowerCase()} `;
  return sensitiveKeywords.some(keyword => haystack.includes(keyword));
}

export function makeAgentActionId(taskInstanceId: string, step: number, type: string): string {
  return `${taskInstanceId}:step-${step}:${type}:${Date.now()}`;
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').slice(0, 240);
  return JSON.stringify(value);
}
