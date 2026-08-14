import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvFile(path = '.env', env: NodeJS.ProcessEnv = process.env): void {
  const fullPath = resolve(process.cwd(), path);
  if (!existsSync(fullPath)) return;
  const lines = readFileSync(fullPath, 'utf8').split(/\r?\n/u);
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (env[parsed.key] === undefined) env[parsed.key] = parsed.value;
  }
}

export function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const equals = trimmed.indexOf('=');
  if (equals <= 0) return null;
  const key = trimmed.slice(0, equals).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return null;
  const rawValue = trimmed.slice(equals + 1).trim();
  return { key, value: unquoteEnvValue(rawValue) };
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\n/gu, '\n');
  }
  return value;
}
