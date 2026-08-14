import { DeepSeekPlannerProvider } from '../domain/deepSeekPlannerProvider';
import { DeterministicAgentPlannerProvider, type AgentPlannerProvider } from '../domain/agentPlannerProvider';

export function makePlannerProviderFromEnv(env: NodeJS.ProcessEnv = process.env): AgentPlannerProvider {
  const provider = (env.OMNIDECK_PLANNER_PROVIDER ?? 'deterministic').trim().toLowerCase();
  if (!provider || provider === 'deterministic' || provider === 'mock') return new DeterministicAgentPlannerProvider();
  if (provider === 'deepseek') {
    return new DeepSeekPlannerProvider({
      apiKey: env.DEEPSEEK_API_KEY ?? '',
      baseUrl: env.DEEPSEEK_BASE_URL,
      model: env.DEEPSEEK_MODEL ?? env.OMNIDECK_DEEPSEEK_MODEL,
      timeoutMs: parsePositiveInteger(env.DEEPSEEK_TIMEOUT_MS, 'DEEPSEEK_TIMEOUT_MS'),
      temperature: parseNumber(env.DEEPSEEK_TEMPERATURE, 'DEEPSEEK_TEMPERATURE'),
    });
  }
  throw new Error(`Unsupported OMNIDECK_PLANNER_PROVIDER: ${provider}`);
}

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}
