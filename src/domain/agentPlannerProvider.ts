import type { AgentAction } from './agentActions';
import { parseAgentAction } from './agentActions';
import { DeterministicAgentPlanner } from './agentPlanner';
import type { AgentObservation } from './observationBuilder';

export interface AgentPlannerUsage {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estimatedCostUsd?: number | null;
}

export interface AgentPlannerResult {
  action: AgentAction;
  usage?: AgentPlannerUsage;
  providerMetadata?: Record<string, unknown>;
}

export type AgentPlannerResponse = AgentAction | AgentPlannerResult;

export interface AgentPlannerProvider {
  readonly id: string;
  plan(observation: AgentObservation, signal?: AbortSignal): Promise<AgentPlannerResponse>;
}

export function normalizePlannerResponse(response: AgentPlannerResponse): AgentPlannerResult {
  if (isPlannerResult(response)) {
    return {
      ...response,
      action: parseAgentAction(response.action),
      usage: normalizeUsage(response.usage),
    };
  }
  return { action: parseAgentAction(response) };
}

export class DeterministicAgentPlannerProvider implements AgentPlannerProvider {
  readonly id = 'deterministic-mock';
  private readonly planner = new DeterministicAgentPlanner();

  async plan(observation: AgentObservation, signal?: AbortSignal): Promise<AgentAction> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return parseAgentAction(this.planner.plan(observation));
  }
}

function isPlannerResult(value: AgentPlannerResponse): value is AgentPlannerResult {
  return Boolean(value && typeof value === 'object' && 'action' in value);
}

function normalizeUsage(usage: AgentPlannerUsage | undefined): AgentPlannerUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: finiteOrNull(usage.promptTokens),
    completionTokens: finiteOrNull(usage.completionTokens),
    totalTokens: finiteOrNull(usage.totalTokens),
    estimatedCostUsd: finiteOrNull(usage.estimatedCostUsd),
  };
}

function finiteOrNull(value: number | null | undefined): number | null | undefined {
  if (value === null || value === undefined) return value;
  return Number.isFinite(value) ? value : null;
}
