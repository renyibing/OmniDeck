import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProcessRunner } from './nativeProcess';

export interface ScrcpyServerInfo {
  jarPath: string;
  version: string;
}

export async function resolveScrcpyServer(scrcpyPath: string, runner: ProcessRunner): Promise<ScrcpyServerInfo> {
  const version = await readScrcpyVersion(scrcpyPath, runner);
  const envPath = process.env.OMNIDECK_SCRCPY_SERVER_PATH;
  if (envPath && await exists(envPath)) {
    return { jarPath: envPath, version: process.env.OMNIDECK_SCRCPY_SERVER_VERSION ?? version };
  }

  const candidates = [
    join(dirname(scrcpyPath), '../share/scrcpy/scrcpy-server'),
    join(dirname(scrcpyPath), '../../share/scrcpy/scrcpy-server'),
    '/opt/homebrew/share/scrcpy/scrcpy-server',
    '/usr/local/share/scrcpy/scrcpy-server',
    '/usr/share/scrcpy/scrcpy-server',
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return { jarPath: candidate, version };
  }
  throw new Error(`Unable to locate scrcpy-server.jar near ${scrcpyPath}. Set OMNIDECK_SCRCPY_SERVER_PATH.`);
}

async function readScrcpyVersion(scrcpyPath: string, runner: ProcessRunner): Promise<string> {
  const result = await runner.run({ command: scrcpyPath, args: ['--version'], timeoutMs: 5_000 });
  const match = `${result.stdout}\n${result.stderr}`.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match?.[1] ?? '2.7';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
