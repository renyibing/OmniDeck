import { describe, expect, it } from 'vitest';
import { DeepSeekPlannerProvider } from '../domain/deepSeekPlannerProvider';
import { DeterministicAgentPlannerProvider } from '../domain/agentPlannerProvider';
import { parseEnvLine } from './env';
import { makePlannerProviderFromEnv } from './plannerProviderConfig';

describe('planner provider env config', () => {
  it('uses deterministic planner by default', () => {
    expect(makePlannerProviderFromEnv({} as NodeJS.ProcessEnv)).toBeInstanceOf(DeterministicAgentPlannerProvider);
  });

  it('builds a DeepSeek planner only when explicitly configured', () => {
    const provider = makePlannerProviderFromEnv({
      OMNIDECK_PLANNER_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      DEEPSEEK_MODEL: 'deepseek-v4-pro',
      DEEPSEEK_TIMEOUT_MS: '15000',
      DEEPSEEK_TEMPERATURE: '0',
    } as NodeJS.ProcessEnv);

    expect(provider).toBeInstanceOf(DeepSeekPlannerProvider);
    expect(provider.id).toBe('deepseek:deepseek-v4-pro');
  });

  it('fails fast when DeepSeek is selected without an API key', () => {
    expect(() => makePlannerProviderFromEnv({ OMNIDECK_PLANNER_PROVIDER: 'deepseek' } as NodeJS.ProcessEnv)).toThrow('DEEPSEEK_API_KEY');
  });

  it('parses simple .env lines without overriding runtime semantics', () => {
    expect(parseEnvLine('DEEPSEEK_MODEL="deepseek-v4-flash"')).toEqual({ key: 'DEEPSEEK_MODEL', value: 'deepseek-v4-flash' });
    expect(parseEnvLine('# comment')).toBeNull();
  });
});
