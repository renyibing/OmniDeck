import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface ProcessRunnerOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface BinaryProcessResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export class ProcessRunner {
  async run(options: ProcessRunnerOptions): Promise<ProcessResult> {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return this.collect(child, options.timeoutMs ?? 30_000, options.signal);
  }

  async runBinary(options: ProcessRunnerOptions): Promise<BinaryProcessResult> {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return this.collectBinary(child, options.timeoutMs ?? 30_000, options.signal);
  }

  spawn(options: Omit<ProcessRunnerOptions, 'timeoutMs' | 'signal'>): ChildProcessByStdio<null, Readable, Readable> {
    return spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  private collect(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`Process timed out after ${timeoutMs}ms`)), timeoutMs);
      const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Process aborted'));
      const finish = (error?: Error, result?: ProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) {
          child.kill('SIGTERM');
          reject(error);
        } else resolve(result!);
      };
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.once('error', error => finish(error));
      child.once('close', code => finish(undefined, { code: code ?? 1, stdout, stderr }));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private collectBinary(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number, signal?: AbortSignal): Promise<BinaryProcessResult> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`Process timed out after ${timeoutMs}ms`)), timeoutMs);
      const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Process aborted'));
      const finish = (error?: Error, result?: BinaryProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) {
          child.kill('SIGTERM');
          reject(error);
        } else resolve(result!);
      };
      child.stdout.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.once('error', error => finish(error));
      child.once('close', code => finish(undefined, { code: code ?? 1, stdout: Buffer.concat(chunks), stderr }));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

export class NativeToolError extends Error {
  constructor(message: string, readonly command: string, readonly stderr = '') { super(message); }
}
