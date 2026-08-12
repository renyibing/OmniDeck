import { describe, expect, it, vi } from 'vitest';
import { IOSWdaDiagnostics, classifyWdaFailure } from './iosWdaDiagnostics';
import type { ProcessRunner } from './nativeProcess';

describe('iOS WDA diagnostics', () => {
  it('returns PORT_TUNNEL_MISSING when the local WDA port is not listening', async () => {
    const diagnostics = new IOSWdaDiagnostics({
      runner: quietRunner(),
      probeLocalPort: vi.fn(async () => ({ listening: false, code: 'ECONNREFUSED', error: 'ECONNREFUSED 127.0.0.1:8101' })),
    });

    const status = await diagnostics.diagnose({
      deviceId: 'device-07',
      udid: 'ios-udid-07',
      wdaUrl: 'http://127.0.0.1:8101',
      configured: true,
      detected: true,
    });

    expect(status.state).toBe('PORT_TUNNEL_MISSING');
    expect(status.iproxyDetected).toBe(false);
    expect(status.localPortListening).toBe(false);
    expect(status.nextAction).toContain('iproxy 8101 8100 -u ios-udid-07');
  });

  it('returns WDA_NOT_RUNNING when the local tunnel resets WDA /status', async () => {
    const diagnostics = new IOSWdaDiagnostics({
      runner: iproxyRunner('4321', 'ios-udid-07'),
      probeLocalPort: vi.fn(async () => ({ listening: true, code: null, error: null })),
      request: vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      }) as unknown as typeof fetch,
    });

    const status = await diagnostics.diagnose({
      deviceId: 'device-07',
      udid: 'ios-udid-07',
      wdaUrl: 'http://127.0.0.1:8101',
      configured: true,
      detected: true,
    });

    expect(status.state).toBe('WDA_NOT_RUNNING');
    expect(status.iproxyDetected).toBe(true);
    expect(status.localPortListening).toBe(true);
    expect(status.lastError).toContain('ECONNRESET');
    expect(status.nextAction).toContain('WebDriverAgentRunner');
  });

  it('returns WDA_READY when /status responds successfully', async () => {
    const diagnostics = new IOSWdaDiagnostics({
      runner: iproxyRunner('1234', 'ios-udid-03'),
      probeLocalPort: vi.fn(async () => ({ listening: true, code: null, error: null })),
      request: vi.fn(async () => new Response(JSON.stringify({ value: { ready: true } }), { status: 200 })) as unknown as typeof fetch,
    });

    const status = await diagnostics.diagnose({
      deviceId: 'device-03',
      udid: 'ios-udid-03',
      wdaUrl: 'http://127.0.0.1:8100',
      configured: true,
      detected: true,
    });

    expect(status.state).toBe('WDA_READY');
    expect(status.statusReady).toBe(true);
    expect(status.sessionReady).toBe(false);
    expect(status.nextAction).toContain('Click Connect');
  });

  it('keeps WDA state device-local for multiple iPhones', async () => {
    const diagnostics = new IOSWdaDiagnostics({
      runner: quietRunner(),
      probeLocalPort: vi.fn(async (_host, port) => port === 8100
        ? { listening: true, code: null, error: null }
        : { listening: false, code: 'ECONNREFUSED', error: 'ECONNREFUSED 127.0.0.1:8101' }),
      request: vi.fn(async () => new Response(JSON.stringify({ value: { ready: true } }), { status: 200 })) as unknown as typeof fetch,
    });

    const [first, second] = await Promise.all([
      diagnostics.diagnose({ deviceId: 'device-03', udid: 'ios-udid-03', wdaUrl: 'http://127.0.0.1:8100', configured: true, detected: true }),
      diagnostics.diagnose({ deviceId: 'device-07', udid: 'ios-udid-07', wdaUrl: 'http://127.0.0.1:8101', configured: true, detected: true }),
    ]);

    expect(first).toMatchObject({ deviceId: 'device-03', state: 'WDA_READY' });
    expect(second).toMatchObject({ deviceId: 'device-07', state: 'PORT_TUNNEL_MISSING' });
  });

  it('classifies signing and provisioning failures separately', async () => {
    expect(classifyWdaFailure("No profiles for 'com.example.WebDriverAgentRunner.xctrunner' were found")).toBe('SIGNING_REQUIRED');
    const diagnostics = new IOSWdaDiagnostics({
      runner: quietRunner(),
      probeLocalPort: vi.fn(async () => ({ listening: false, code: 'ECONNREFUSED', error: 'ECONNREFUSED 127.0.0.1:8101' })),
    });
    const status = await diagnostics.diagnose({
      deviceId: 'device-07',
      udid: 'ios-udid-07',
      wdaUrl: 'http://127.0.0.1:8101',
      configured: true,
      detected: true,
      previousError: "No profiles for 'com.example.WebDriverAgentRunner.xctrunner' were found",
    });

    expect(status.state).toBe('SIGNING_REQUIRED');
    expect(status.nextAction).toContain('signing/provisioning');
  });

  it('lets a live WDA endpoint override stale signing errors', async () => {
    const diagnostics = new IOSWdaDiagnostics({
      runner: iproxyRunner('1234', 'ios-udid-07'),
      probeLocalPort: vi.fn(async () => ({ listening: true, code: null, error: null })),
      request: vi.fn(async () => new Response(JSON.stringify({ value: { ready: true } }), { status: 200 })) as unknown as typeof fetch,
    });

    const status = await diagnostics.diagnose({
      deviceId: 'device-07',
      udid: 'ios-udid-07',
      wdaUrl: 'http://127.0.0.1:8101',
      configured: true,
      detected: true,
      previousError: "No profiles for 'com.example.WebDriverAgentRunner.xctrunner' were found",
    });

    expect(status.state).toBe('WDA_READY');
    expect(status.statusReady).toBe(true);
  });
});

function quietRunner(): ProcessRunner {
  return {
    run: vi.fn(async () => ({ code: 1, stdout: '', stderr: '' })),
  } as unknown as ProcessRunner;
}

function iproxyRunner(pid: string, udid: string): ProcessRunner {
  return {
    run: vi.fn(async ({ command }: { command: string }) => command === 'lsof'
      ? { code: 0, stdout: `COMMAND   PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\niproxy ${pid} user 4u IPv6 0x0 0t0 TCP *:8101 (LISTEN)\n`, stderr: '' }
      : { code: 0, stdout: `iproxy 8101 8100 -u ${udid}\n`, stderr: '' }),
  } as unknown as ProcessRunner;
}
