import { makeAgentActionId, parseAgentAction, type AgentAction } from './agentActions';
import type { AgentPlannerProvider, AgentPlannerResult, AgentPlannerUsage } from './agentPlannerProvider';
import type { AgentObservation, UiNodeSummary } from './observationBuilder';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface DeepSeekChoice {
  message?: { content?: string | null };
}

interface DeepSeekChatCompletionResponse {
  choices?: DeepSeekChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface DeepSeekPlannerProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  request?: FetchLike;
}

export class DeepSeekPlannerProvider implements AgentPlannerProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly request: FetchLike;

  constructor(options: DeepSeekPlannerProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error('DeepSeek planner requires DEEPSEEK_API_KEY');
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? 'https://api.deepseek.com');
    this.model = options.model?.trim() || 'deepseek-v4-flash';
    this.temperature = options.temperature ?? 0.1;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.request = options.request ?? fetch;
    this.id = `deepseek:${this.model}`;
  }

  async plan(observation: AgentObservation, signal?: AbortSignal): Promise<AgentPlannerResult> {
    const controller = new AbortController();
    const removeAbortListener = linkAbortSignal(signal, controller);
    const timeout = setTimeout(() => controller.abort(new DOMException('DeepSeek planner timeout', 'TimeoutError')), this.timeoutMs);
    if ('unref' in timeout) timeout.unref();

    try {
      const response = await this.request(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: JSON.stringify(buildPlannerPayload(observation)) },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`DeepSeek planner failed: ${response.status} ${await safeResponseText(response)}`.trim());

      const payload = await response.json() as DeepSeekChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error('DeepSeek planner returned an empty response');

      const rawAction = extractJsonObject(content);
      const action = parseAgentAction(normalizeActionCandidate(rawAction, observation));
      if (action.deviceId !== observation.deviceId) throw new Error(`DeepSeek planner targeted ${action.deviceId}, expected ${observation.deviceId}`);
      if (action.taskInstanceId !== observation.taskInstanceId) throw new Error(`DeepSeek planner targeted task ${action.taskInstanceId}, expected ${observation.taskInstanceId}`);
      return { action, usage: normalizeDeepSeekUsage(payload.usage) };
    } finally {
      clearTimeout(timeout);
      removeAbortListener();
    }
  }
}

function normalizeDeepSeekUsage(usage: DeepSeekChatCompletionResponse['usage']): AgentPlannerUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: finiteOrNull(usage.prompt_tokens),
    completionTokens: finiteOrNull(usage.completion_tokens),
    totalTokens: finiteOrNull(usage.total_tokens),
    estimatedCostUsd: null,
  };
}

function systemPrompt(): string {
  return [
    'You are the OmniDeck single-device mobile action planner.',
    'Return exactly one JSON object and no markdown or prose.',
    'The JSON must match OmniDeck AgentAction and use source="LLM_PLANNER".',
    'Allowed types: tap_element, tap, swipe, input_text, press_key, back, home, launch_app, wait, request_human, finish.',
    'Prefer tap_element with text, resourceId, or contentDesc. Use normalized tap coordinates only when a selector is impossible.',
    'Never emit shell commands, ADB commands, WDA commands, scripts, or coordinate broadcasts.',
    'Plan only for the supplied deviceId and taskInstanceId. Do not mention or target any other device.',
    'If the goal is sensitive, ambiguous, destructive, or the UI does not expose a safe target, return request_human.',
    'Do not rely on continuous video. Use only the screenshot metadata, UI summary, and redacted action history in the prompt.',
  ].join('\n');
}

function buildPlannerPayload(observation: AgentObservation): Record<string, unknown> {
  return {
    requiredFields: {
      deviceId: observation.deviceId,
      taskInstanceId: observation.taskInstanceId,
      source: 'LLM_PLANNER',
      suggestedActionId: makeAgentActionId(observation.taskInstanceId, observation.currentStep, 'deepseek'),
    },
    observation: {
      deviceId: observation.deviceId,
      platform: observation.platform,
      currentApp: observation.currentApp,
      taskInstanceId: observation.taskInstanceId,
      goal: observation.goal,
      currentStep: observation.currentStep,
      approvalGranted: observation.approvalGranted,
      screenshot: observation.screenshot,
      uiHierarchy: {
        capturedAt: observation.uiHierarchy.capturedAt,
        nodeCount: observation.uiHierarchy.nodeCount,
        actionableNodes: observation.uiHierarchy.actionableNodes.slice(0, 24).map(summarizeNode),
      },
      lastActionResult: observation.lastActionResult,
      actionHistory: observation.actionHistory.slice(-8).map(event => ({
        kind: event.kind,
        time: event.time,
        message: event.message.slice(0, 500),
      })),
    },
    outputShape: {
      example: {
        actionId: 'use requiredFields.suggestedActionId or another unique id',
        deviceId: observation.deviceId,
        taskInstanceId: observation.taskInstanceId,
        source: 'LLM_PLANNER',
        type: 'tap_element',
        selector: { text: 'Continue', mustBeEnabled: true, mustBeClickable: false },
        reason: 'Short reason based on current UI observation',
      },
    },
  };
}

function summarizeNode(node: UiNodeSummary): Record<string, unknown> {
  return {
    id: node.id,
    text: node.text,
    resourceId: node.resourceId,
    contentDesc: node.contentDesc,
    className: node.className,
    clickable: node.clickable,
    enabled: node.enabled,
    focused: node.focused,
    bounds: node.bounds,
  };
}

function normalizeActionCandidate(value: unknown, observation: AgentObservation): unknown {
  const unwrapped = unwrapAction(value);
  if (!isRecord(unwrapped)) return unwrapped;
  return {
    ...unwrapped,
    actionId: typeof unwrapped.actionId === 'string' && unwrapped.actionId.trim()
      ? unwrapped.actionId
      : makeAgentActionId(observation.taskInstanceId, observation.currentStep, 'deepseek'),
    deviceId: typeof unwrapped.deviceId === 'string' && unwrapped.deviceId.trim() ? unwrapped.deviceId : observation.deviceId,
    taskInstanceId: typeof unwrapped.taskInstanceId === 'string' && unwrapped.taskInstanceId.trim() ? unwrapped.taskInstanceId : observation.taskInstanceId,
    source: 'LLM_PLANNER',
    reason: typeof unwrapped.reason === 'string' && unwrapped.reason.trim() ? unwrapped.reason : 'DeepSeek planner selected the next safe action',
  };
}

function unwrapAction(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const maybeAction = value.action;
  return isRecord(maybeAction) ? maybeAction : value;
}

function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(fenced) as unknown;
  } catch {
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('DeepSeek planner response did not contain a JSON object');
    return JSON.parse(fenced.slice(start, end + 1)) as unknown;
  }
}

function linkAbortSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (!parent) return () => undefined;
  if (parent.aborted) {
    controller.abort(parent.reason);
    return () => undefined;
  }
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}

function finiteOrNull(value: number | null | undefined): number | null | undefined {
  if (value === null || value === undefined) return value;
  return Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
