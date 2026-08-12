import { describe, expect, it, vi } from 'vitest';
import { AgentWorkerPool, RateLimiter, ResourceLimiter } from './workerPool';
import { ControlPlane } from './controlPlane';
import { DriverRegistry, SimulatedDeviceDriver } from './deviceDriver';
import { DeviceManager } from './deviceManager';
import { SessionManager } from './sessionManager';
import { StreamManager } from './streamManager';
import { TaskScheduler } from './taskScheduler';
import type { ConcurrencyConfig, TaskInstance } from './types';
import { AndroidAdbScrcpyDriver, encodeAdbInputText } from './androidDeviceDriver';
import { IOSXCUITestDriver } from './iosXcuitestDriver';
import { NativeToolError, ProcessRunner } from './nativeProcess';
import { EventEmitter } from 'node:events';
import { encodeRgbaPng, scaleRgbaToMaxDimension } from './pngEncoder';
import type { UiHierarchy } from './androidUiHierarchy';

const config: ConcurrencyConfig = { maxConcurrentAI: 8, maxConcurrentVLM: 4, maxConcurrentADB: 12, maxConcurrentIOS: 4, timeoutMs: 90_000, maxRetries: 2 };

describe('multi-device sessions', () => {
  it.each([8, 16, 32])('creates %i isolated sessions', count => {
    const manager = new DeviceManager(count);
    expect(manager.count()).toBe(count);
    expect(new Set(manager.getAll().map(session => session.id)).size).toBe(count);
    expect(new Set(manager.getAll().map(session => session.taskContext)).size).toBe(count);
    expect(new Set(manager.getAll().map(session => session.actionHistory)).size).toBe(count);
    expect(new Set(manager.getAll().map(session => session.memory)).size).toBe(count);
    expect(new Set(manager.getAll().map(session => session.agentSession)).size).toBe(count);
    expect(new Set(manager.getAll().map(session => session.healthState)).size).toBe(count);
    expect(new Set(manager.getAll().map(session => session.deviceDriver)).size).toBe(count);
    expect(new Set(manager.getAll().map(session => session.screenStream)).size).toBe(count);
    expect(new Set(manager.getAll().map(session => session.taskQueue)).size).toBe(count);
    expect(manager.getAll().every(session => session.agentRuntime.analyzeVideo === false)).toBe(true);
  });

  it('does not recreate sessions when stream layouts change', () => {
    const devices = new DeviceManager(32);
    const sessions = new SessionManager(devices);
    const original = sessions.getStableSession('device-01');
    const originalTaskContext = original?.taskContext;
    sessions.applyStreamPolicy(8, 'device-01', null, devices.getAll().slice(0, 8).map(device => device.id));
    sessions.applyStreamPolicy(16, 'device-02', null, devices.getAll().slice(0, 16).map(device => device.id));
    sessions.applyStreamPolicy(32, null, null, devices.getAll().map(device => device.id));
    expect(sessions.getStableSession('device-01')).toBe(original);
    expect(sessions.getStableSession('device-01')?.sessionRevision).toBe(original?.sessionRevision);
    expect(sessions.getStableSession('device-01')?.taskContext).toBe(originalTaskContext);
  });

  it('takes only the failed device offline and preserves its resumable task', () => {
    const manager = new DeviceManager(8);
    const siblingBefore = manager.get('device-02');
    manager.setOffline('device-01');
    expect(manager.get('device-01')?.currentTask?.status).toBe('DEVICE_OFFLINE');
    expect(manager.get('device-02')).toBe(siblingBefore);
    manager.recover('device-01');
    expect(manager.get('device-01')?.agentStatus).toBe('PAUSED');
    expect(manager.get('device-01')?.currentTask?.status).toBe('DEVICE_OFFLINE');
  });
});

describe('native driver boundaries', () => {
  it('encodes an RGBA monitor frame as a valid PNG', () => {
    const png = encodeRgbaPng(1, 1, Buffer.from([255, 0, 0, 255]));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(1);
    expect(png.readUInt32BE(20)).toBe(1);
  });

  it('coalesces concurrent monitor frame requests per device without stale TTL reuse', async () => {
    const registry = new DriverRegistry();
    let resolveFrame: ((frame: { deviceId: string; capturedAt: number; contentType: 'image/png'; data: Buffer }) => void) | undefined;
    const monitorFrame = vi.fn(() => new Promise<{ deviceId: string; capturedAt: number; contentType: 'image/png'; data: Buffer }>(resolve => { resolveFrame = resolve; }));
    registry.register({
      deviceId: 'device-01', platform: 'ANDROID', connect: vi.fn(), disconnect: vi.fn(),
      screenshot: vi.fn(), monitorFrame, getUiHierarchy: vi.fn(), getScreenSize: vi.fn(), tap: vi.fn(), swipe: vi.fn(), longPress: vi.fn(), inputText: vi.fn(), back: vi.fn(), home: vi.fn(), launchApp: vi.fn(), restartApp: vi.fn(), stopApp: vi.fn(),
      performGoalStep: vi.fn(), health: vi.fn(),
    });
    const first = registry.monitorFrame('device-01');
    const second = registry.monitorFrame('device-01');
    expect(monitorFrame).toHaveBeenCalledTimes(1);
    resolveFrame?.({ deviceId: 'device-01', capturedAt: 1, contentType: 'image/png', data: Buffer.from('png') });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    const third = registry.monitorFrame('device-01');
    expect(monitorFrame).toHaveBeenCalledTimes(2);
    resolveFrame?.({ deviceId: 'device-01', capturedAt: 2, contentType: 'image/png', data: Buffer.from('png-2') });
    await expect(third).resolves.toMatchObject({ capturedAt: 2 });
  });

  it('downscales RGBA monitor frames before PNG encode', () => {
    const rgba = Buffer.alloc(40 * 80 * 4, 7);
    const scaled = scaleRgbaToMaxDimension(40, 80, rgba, 20);
    expect(scaled).toMatchObject({ width: 10, height: 20 });
    expect(scaled.rgba.length).toBe(10 * 20 * 4);
    const png = encodeRgbaPng(40, 80, rgba, 20);
    expect(png.readUInt32BE(16)).toBe(10);
    expect(png.readUInt32BE(20)).toBe(20);
  });

  it('requires an explicit serial and never builds an unscoped Android command', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      run: vi.fn(async (options: { command: string; args: string[] }) => {
        calls.push(options);
        if (options.args.includes('wm')) return { code: 0, stdout: 'Physical size: 1080x2400\n', stderr: '' };
        if (options.args.includes('dumpsys')) return { code: 0, stdout: 'SurfaceOrientation: 0\n', stderr: '' };
        return { code: 0, stdout: 'device\n', stderr: '' };
      }),
      spawn: vi.fn(),
    } as unknown as ProcessRunner;
    const driver = new AndroidAdbScrcpyDriver('device-01', { serial: 'serial-01', runner });
    await driver.connect();
    await driver.screenshot({ purpose: 'AI', width: 100, height: 200 });
    await driver.tap({ x: 0.5, y: 0.25 });
    expect(calls.map(call => ({ command: call.command, args: call.args }))).toEqual([
      { command: 'adb', args: ['-s', 'serial-01', 'get-state'] },
      { command: 'adb', args: ['-s', 'serial-01', 'exec-out', 'screencap', '-p'] },
      { command: 'adb', args: ['-s', 'serial-01', 'shell', 'wm', 'size'] },
      { command: 'adb', args: ['-s', 'serial-01', 'shell', 'dumpsys', 'input'] },
      { command: 'adb', args: ['-s', 'serial-01', 'shell', 'input', 'tap', '540', '600'] },
    ]);
  });

  it('does not use current preview frame dimensions as the physical action viewport', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const header = Buffer.alloc(16);
    header.writeUInt32LE(240, 0);
    header.writeUInt32LE(108, 4);
    header.writeUInt32LE(1, 8);
    const frame = Buffer.concat([header, Buffer.alloc(240 * 108 * 4)]);
    const runner = {
      run: vi.fn(async (options: { command: string; args: string[] }) => {
        calls.push(options);
        if (options.args.includes('wm')) return { code: 0, stdout: 'Physical size: 108x240\n', stderr: '' };
        if (options.args.includes('dumpsys')) return { code: 0, stdout: 'SurfaceOrientation: 1\n', stderr: '' };
        return { code: 0, stdout: 'device\n', stderr: '' };
      }),
      runBinary: vi.fn(async (options: { command: string; args: string[] }) => {
        calls.push(options);
        return { code: 0, stdout: frame, stderr: '' };
      }),
      spawn: vi.fn(),
    } as unknown as ProcessRunner;
    const driver = new AndroidAdbScrcpyDriver('device-01', { serial: 'serial-01', runner });

    await driver.connect();
    await driver.monitorFrame();
    await driver.tap({ x: 0.25, y: 0.5 });

    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell wm size');
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell dumpsys input');
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell input tap 60 54');
  });

  it('keeps every Android automation action scoped to the configured serial', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      run: vi.fn(async (options: { command: string; args: string[] }) => {
        calls.push(options);
        if (options.args.includes('wm')) return { code: 0, stdout: 'Physical size: 1080x2400\n', stderr: '' };
        if (options.args.includes('dumpsys')) return { code: 0, stdout: 'SurfaceOrientation: 0\n', stderr: '' };
        if (options.args.includes('uiautomator')) return { code: 0, stdout: '<hierarchy><node index="0" text="Home" resource-id="com.example:id/home" class="android.widget.TextView" package="com.example" content-desc="Home" clickable="false" enabled="true" focused="false" bounds="[0,0][100,100]" /></hierarchy>', stderr: '' };
        return { code: 0, stdout: 'device\n', stderr: '' };
      }),
      spawn: vi.fn(),
    } as unknown as ProcessRunner;
    const driver = new AndroidAdbScrcpyDriver('device-01', { serial: 'serial-01', runner });
    await driver.connect();
    await driver.getUiHierarchy();
    await driver.getScreenSize();
    await driver.swipe({ from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, durationMs: 300 });
    await driver.longPress({ point: { x: 0.5, y: 0.5 }, durationMs: 700 });
    await driver.inputText('hello world & ok');
    await driver.back();
    await driver.home();
    await driver.stopApp('com.example');

    expect(calls.every(call => call.args[0] === '-s' && call.args[1] === 'serial-01')).toBe(true);
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 exec-out uiautomator dump /dev/tty');
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell input text hello%sworld%s\\&%sok');
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell input keyevent KEYCODE_BACK');
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell input keyevent KEYCODE_HOME');
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell am force-stop com.example');
    expect(encodeAdbInputText('a b')).toBe('a%sb');
  });

  it('falls back to a scoped UIAutomator file dump when /dev/tty returns no XML', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      run: vi.fn(async (options: { command: string; args: string[] }) => {
        calls.push(options);
        const joined = options.args.join(' ');
        if (joined.includes('get-state')) return { code: 0, stdout: 'device\n', stderr: '' };
        if (joined.includes('exec-out uiautomator dump /dev/tty')) return { code: 0, stdout: 'UI hierchary dumped to: /dev/tty\n', stderr: '' };
        if (joined.includes('shell uiautomator dump /sdcard/omnideck-ui-')) return { code: 0, stdout: 'UI hierchary dumped to: /sdcard/omnideck-ui.xml\n', stderr: '' };
        if (joined.includes('exec-out cat /sdcard/omnideck-ui-')) return { code: 0, stdout: '<hierarchy><node index="0" text="Fallback" resource-id="com.example:id/fallback" class="android.widget.TextView" package="com.example" content-desc="Fallback" clickable="false" enabled="true" focused="false" bounds="[0,0][100,100]" /></hierarchy>', stderr: '' };
        if (joined.includes('shell rm -f /sdcard/omnideck-ui-')) return { code: 0, stdout: '', stderr: '' };
        return { code: 1, stdout: '', stderr: `unexpected ${joined}` };
      }),
      spawn: vi.fn(),
    } as unknown as ProcessRunner;
    const driver = new AndroidAdbScrcpyDriver('device-01', { serial: 'serial-01', runner });

    await driver.connect();
    const hierarchy = await driver.getUiHierarchy();
    const scoped = calls.map(call => call.args.join(' '));

    expect(hierarchy.nodes[0].text).toBe('Fallback');
    expect(calls.every(call => call.args[0] === '-s' && call.args[1] === 'serial-01')).toBe(true);
    expect(scoped.some(call => call.includes('shell uiautomator dump /sdcard/omnideck-ui-'))).toBe(true);
    expect(scoped.some(call => call.includes('exec-out cat /sdcard/omnideck-ui-'))).toBe(true);
    expect(scoped.some(call => call.includes('shell rm -f /sdcard/omnideck-ui-'))).toBe(true);
  });

  it('reports a diagnostic error when UIAutomator returns no nodes', async () => {
    const runner = {
      run: vi.fn(async (options: { args: string[] }) => {
        const joined = options.args.join(' ');
        if (joined.includes('get-state')) return { code: 0, stdout: 'device\n', stderr: '' };
        if (joined.includes('exec-out uiautomator dump /dev/tty')) return { code: 0, stdout: 'UI hierchary dumped to: /dev/tty\n', stderr: '' };
        if (joined.includes('shell uiautomator dump /sdcard/omnideck-ui-')) return { code: 0, stdout: 'dumped\n', stderr: '' };
        if (joined.includes('exec-out cat /sdcard/omnideck-ui-')) return { code: 0, stdout: '<hierarchy rotation="0"></hierarchy>', stderr: '' };
        if (joined.includes('shell rm -f /sdcard/omnideck-ui-')) return { code: 0, stdout: '', stderr: '' };
        return { code: 1, stdout: '', stderr: `unexpected ${joined}` };
      }),
      spawn: vi.fn(),
    } as unknown as ProcessRunner;
    const driver = new AndroidAdbScrcpyDriver('device-01', { serial: 'serial-01', runner });

    await driver.connect();
    await expect(driver.getUiHierarchy()).rejects.toThrow('UI hierarchy dump returned no nodes for device-01 (serial-01)');
  });

  it('does not allow Android actions before connect', async () => {
    const driver = new AndroidAdbScrcpyDriver('device-01', { serial: 'serial-01' });
    await expect(driver.screenshot({ purpose: 'AI', width: 100, height: 200 })).rejects.toBeInstanceOf(NativeToolError);
  });

  it('scopes scrcpy to the serial and restarts only when the stream profile changes', async () => {
    const spawned: Array<{ command: string; args: string[]; process: EventEmitter & { kill: ReturnType<typeof vi.fn> } }> = [];
    const runner = {
      run: vi.fn(async () => ({ code: 0, stdout: 'device\n', stderr: '' })),
      spawn: vi.fn((options: { command: string; args: string[] }) => {
        const process = Object.assign(new EventEmitter(), { kill: vi.fn() });
        spawned.push({ ...options, process });
        return process;
      }),
    } as unknown as ProcessRunner;
    const driver = new AndroidAdbScrcpyDriver('device-01', { serial: 'serial-01', runner, streamProcessEnabled: true });
    await driver.connect();
    const preview = { mode: 'PREVIEW', width: 480, height: 854, fps: 10, bitrateKbps: 900 } as const;
    driver.applyStreamProfile(preview);
    driver.applyStreamProfile(preview);
    driver.applyStreamProfile({ ...preview, fps: 5 });
    expect(spawned).toHaveLength(2);
    expect(spawned[0].args.slice(0, 2)).toEqual(['-s', 'serial-01']);
    expect(spawned[0].process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('uses the current WDA tap route and device-local viewport coordinates for iOS', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (url.endsWith('/status')) return new Response(JSON.stringify({ value: { ready: true } }), { status: 200 });
      if (url.endsWith('/session')) {
        return new Response(JSON.stringify({ value: { sessionId: 'session-03' }, sessionId: 'session-03' }), { status: 200 });
      }
      if (url.endsWith('/session/session-03/appium/settings')) return new Response(JSON.stringify({ value: {} }), { status: 200 });
      if (url.endsWith('/window/size')) return new Response(JSON.stringify({ value: { width: 390, height: 844 } }), { status: 200 });
      if (url.endsWith('/orientation')) return new Response(JSON.stringify({ value: 'PORTRAIT' }), { status: 200 });
      if (url.endsWith('/session/session-03/wda/tap')) return new Response(JSON.stringify({ value: null }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const driver = new IOSXCUITestDriver('device-03', {
      udid: '00008020-001C259A0ED8003A',
      wdaUrl: 'http://127.0.0.1:8100',
      request,
    });

    await driver.connect();
    await driver.tap({ x: 0.5, y: 0.25 });

    expect(requests).toEqual([
      { url: 'http://127.0.0.1:8100/status', method: 'GET', body: undefined },
      { url: 'http://127.0.0.1:8100/session', method: 'POST', body: JSON.stringify({ capabilities: { firstMatch: [{}], alwaysMatch: {} } }) },
      {
        url: 'http://127.0.0.1:8100/session/session-03/appium/settings',
        method: 'POST',
        body: JSON.stringify({
          settings: {
            screenshotQuality: 2,
            mjpegServerFramerate: 15,
            mjpegScalingFactor: 56,
            mjpegServerScreenshotQuality: 35,
          },
        }),
      },
      { url: 'http://127.0.0.1:8100/window/size', method: 'GET', body: undefined },
      { url: 'http://127.0.0.1:8100/orientation', method: 'GET', body: undefined },
      { url: 'http://127.0.0.1:8100/session/session-03/wda/tap', method: 'POST', body: JSON.stringify({ x: 195, y: 211 }) },
    ]);
  });

  it('reports actionable WDA endpoint errors when iOS WDA is unreachable', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8100'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 8100,
    });
    const request = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause });
    }) as unknown as typeof fetch;
    const driver = new IOSXCUITestDriver('device-03', {
      udid: '00008020-001C259A0ED8003A',
      wdaUrl: 'http://127.0.0.1:8100',
      request,
    });

    await expect(driver.connect()).rejects.toThrow('WebDriverAgent is unreachable for device-03 (00008020-001C259A0ED8003A) at http://127.0.0.1:8100/status during status check');
    await expect(driver.connect()).rejects.toThrow('Start WebDriverAgent for this UDID and its device-specific port tunnel');
    await expect(driver.connect()).rejects.toThrow('ECONNREFUSED 127.0.0.1:8100');
  });
});

describe('task scheduling', () => {
  it('creates one independent task instance per target device', () => {
    const scheduler = new TaskScheduler(config);
    const tasks = scheduler.createBatch('Verify home screen', ['device-01', 'device-02', 'device-03']);
    expect(tasks.map(task => task.deviceId)).toEqual(['device-01', 'device-02', 'device-03']);
    expect(new Set(tasks.map(task => task.id)).size).toBe(3);
    expect(new Set(tasks.map(task => task)).size).toBe(3);
    tasks[0].status = 'FAILED';
    expect(tasks[1].status).toBe('RUNNING');
  });

  it('keeps task identities unique across batches created in the same millisecond', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const scheduler = new TaskScheduler(config);
    const first = scheduler.createInstances('First goal', ['device-01']);
    const second = scheduler.createInstances('Second goal', ['device-01']);
    expect(first[0].batchId).not.toBe(second[0].batchId);
    expect(first[0].id).not.toBe(second[0].id);
    now.mockRestore();
  });

  it('limits active AI work and queues overflow', () => {
    const scheduler = new TaskScheduler(config);
    const tasks = scheduler.createBatch('Batch goal', Array.from({ length: 32 }, (_, index) => `device-${index + 1}`));
    expect(tasks.filter(task => task.status === 'RUNNING')).toHaveLength(8);
    expect(tasks.filter(task => task.status === 'WAITING')).toHaveLength(24);
    expect(scheduler.workers.snapshot()).toEqual({ active: 8, queued: 24, completed: 0 });
  });

  it('releases a worker for the next queued task', () => {
    const pool = new AgentWorkerPool({ ...config, maxConcurrentAI: 1 });
    const base = { batchId: 'b', goal: 'goal', priority: 1, attempts: 0, createdAt: 1, updatedAt: 1 };
    const first: TaskInstance = { ...base, id: 't1', deviceId: 'd1', status: 'WAITING' };
    const second: TaskInstance = { ...base, id: 't2', deviceId: 'd2', status: 'WAITING' };
    expect(pool.enqueue(first).status).toBe('RUNNING');
    expect(pool.enqueue(second).status).toBe('WAITING');
    expect(pool.finish('t1')?.id).toBe('t2');
    expect(pool.snapshot()).toEqual({ active: 1, queued: 0, completed: 1 });
  });

  it('dispatches queued work by priority', () => {
    const pool = new AgentWorkerPool({ ...config, maxConcurrentAI: 1 });
    const base = { batchId: 'b', goal: 'goal', attempts: 0, createdAt: 1, updatedAt: 1 };
    pool.enqueue({ ...base, id: 'active', deviceId: 'd1', status: 'WAITING', priority: 1 });
    pool.enqueue({ ...base, id: 'low', deviceId: 'd2', status: 'WAITING', priority: 1 });
    pool.enqueue({ ...base, id: 'high', deviceId: 'd3', status: 'WAITING', priority: 9 });
    expect(pool.finish('active')?.id).toBe('high');
  });

  it('enforces independent VLM, ADB, and iOS resource limits', () => {
    const limiter = new ResourceLimiter(config);
    expect(Array.from({ length: 4 }, () => limiter.acquire('VLM'))).toEqual([true, true, true, true]);
    expect(limiter.acquire('VLM')).toBe(false);
    expect(Array.from({ length: 4 }, () => limiter.acquire('IOS'))).toEqual([true, true, true, true]);
    expect(limiter.acquire('IOS')).toBe(false);
    limiter.release('VLM');
    expect(limiter.acquire('VLM')).toBe(true);
  });

  it('uses screenshot-driven analysis instead of video analysis', () => {
    const scheduler = new TaskScheduler(config);
    expect(scheduler.getScreenshotAnalysisFlow()).toEqual(['TRIGGER_SCREENSHOT', 'VLM_ANALYZE', 'DEVICE_ACTION', 'WAIT_FOR_UI_CHANGE', 'TRIGGER_SCREENSHOT']);
  });

  it('rate limits model requests within a rolling window', () => {
    const limiter = new RateLimiter(2, 1_000);
    expect(limiter.tryAcquire(1_000)).toBe(true);
    expect(limiter.tryAcquire(1_100)).toBe(true);
    expect(limiter.tryAcquire(1_200)).toBe(false);
    expect(limiter.tryAcquire(2_100)).toBe(true);
  });
});

describe('stream policy', () => {
  it('degrades wall streams and keeps AI screenshots high resolution', () => {
    const streams = new StreamManager();
    expect(streams.getProfile('FULLSCREEN', 1)).toMatchObject({ width: 1080, fps: 60 });
    expect(streams.getProfile('PREVIEW', 4)).toMatchObject({ width: 720, fps: 30 });
    expect(streams.getProfile('PREVIEW', 16)).toMatchObject({ width: 480, fps: 10 });
    expect(streams.getProfile('PREVIEW', 32)).toMatchObject({ width: 360, fps: 5 });
    expect(streams.getProfile('BACKGROUND', 32).fps).toBe(1);
    expect(streams.requestAIScreenshot()).toMatchObject({ width: 1440, height: 2560, source: 'ON_DEMAND_SCREENSHOT' });
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error('Timed out waiting for condition');
}

describe('control plane lifecycle', () => {
  const makePlane = (count = 12, autoExecute = false, driverLatency = 0) => {
    const devices = new DeviceManager(count);
    const scheduler = new TaskScheduler({ maxConcurrentAI: 8, maxConcurrentVLM: 4, maxConcurrentADB: 12, maxConcurrentIOS: 4, timeoutMs: 500, maxRetries: 2, rateLimitPerMinute: 60 });
    const drivers = new DriverRegistry();
    devices.getAll().forEach(device => drivers.register(new SimulatedDeviceDriver(device, driverLatency)));
    return { devices, scheduler, drivers, plane: new ControlPlane(devices, scheduler, drivers, { autoExecute }) };
  };

  it('executes a task, records it, and releases resources', async () => {
    const { devices, plane } = makePlane(12, true);
    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('Check the dashboard', ['device-01']);
    await waitFor(() => task.status === 'SUCCESS');
    const session = devices.get('device-01')!;
    expect(task.status).toBe('SUCCESS');
    expect(session.currentTask).toBeNull();
    expect(session.taskHistory.some(item => item.id === task.id && item.status === 'SUCCESS')).toBe(true);
    expect(session.actionHistory.map(event => event.message).join('\n')).toContain('taskAction=goal_step verification=UI_HIERARCHY_AFTER_ACTION');
    expect(session.actionHistory.map(event => event.message).join('\n')).toContain('Captured post-action verification screenshot');
    expect(plane.scheduler.workers.snapshot().active).toBeLessThanOrEqual(8);
    expect(plane.scheduler.resources.snapshot()).toEqual({ AI: 0, VLM: 0, ADB: 0, IOS: 0 });
  });

  it('keeps an auto task complete when UI hierarchy verification fails but screenshot verification succeeds', async () => {
    const { devices, drivers, plane } = makePlane(1, true);
    const driver = drivers.get('device-01') as SimulatedDeviceDriver & { getUiHierarchy: () => Promise<never> };
    driver.getUiHierarchy = vi.fn(async () => {
      throw new NativeToolError('UI hierarchy dump failed for device-01 (serial-01)', 'adb -s serial-01 exec-out uiautomator dump /dev/tty', 'uiautomator not available');
    });
    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('Check action verification fallback', ['device-01']);

    await waitFor(() => task.status === 'SUCCESS');
    const history = devices.get('device-01')?.taskHistory.at(-1);
    const messages = devices.get('device-01')?.actionHistory.map(event => event.message).join('\n') ?? '';

    expect(history?.id).toBe(task.id);
    expect(messages).toContain('taskAction=goal_step verification=UI_HIERARCHY_AFTER_ACTION');
    expect(messages).toContain('result=ERROR');
    expect(messages).toContain('Captured post-action verification screenshot');
  });

  it('pauses and resumes a device-scoped task without affecting a sibling', () => {
    const { devices, plane } = makePlane(12, false);
    plane.pauseDevice('device-01');
    expect(devices.get('device-01')?.agentStatus).toBe('PAUSED');
    expect(devices.get('device-02')?.agentStatus).toBe('RUNNING');
    plane.resumeDevice('device-01');
    expect(devices.get('device-01')?.agentStatus).toBe('RUNNING');
  });

  it('isolates disconnect and preserves the interrupted task for recovery', async () => {
    const { devices, plane } = makePlane(12, false);
    const taskId = devices.get('device-01')?.currentTask?.id;
    await plane.setOffline('device-01');
    expect(devices.get('device-01')?.currentTask?.status).toBe('DEVICE_OFFLINE');
    expect(devices.get('device-02')?.status).toBe('ONLINE');
    expect(plane.scheduler.workers.isActive(taskId!)).toBe(false);
    await plane.recover('device-01');
    expect(devices.get('device-01')?.agentStatus).toBe('PAUSED');
    plane.resumeDevice('device-01');
    expect(devices.get('device-01')?.agentStatus).toBe('RUNNING');
  });

  it('keeps an auto-executing task resumable across disconnect and recovery', async () => {
    const { devices, plane } = makePlane(1, true, 20);
    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('Recover the dashboard task', ['device-01']);
    const originalTask = devices.get('device-01')?.currentTask;
    await plane.setOffline('device-01');
    expect(devices.get('device-01')?.currentTask).toBe(originalTask);
    expect(task.status).toBe('DEVICE_OFFLINE');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(task.status).toBe('DEVICE_OFFLINE');
    await plane.recover('device-01');
    plane.resumeDevice('device-01');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(task.status).toBe('SUCCESS');
    expect(devices.get('device-01')?.currentTask).toBeNull();
  });

  it('does not start a second execution when pause and resume race cancellation', async () => {
    const { devices, plane } = makePlane(1, true, 20);
    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('Pause and resume safely', ['device-01']);
    plane.pauseDevice('device-01');
    plane.resumeDevice('device-01');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(task.status).toBe('SUCCESS');
    expect(devices.get('device-01')?.taskHistory.filter(item => item.id === task.id)).toHaveLength(1);
  });

  it('records a real task timeout as a failure', async () => {
    const devices = new DeviceManager(1);
    const scheduler = new TaskScheduler({ ...config, timeoutMs: 10, rateLimitPerMinute: 60 });
    const drivers = new DriverRegistry();
    drivers.register(new SimulatedDeviceDriver(devices.get('device-01')!, 20));
    const plane = new ControlPlane(devices, scheduler, drivers, { autoExecute: true });
    await new Promise(resolve => setTimeout(resolve, 30));
    const failed = devices.get('device-01')?.taskHistory.at(-1);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toBe('Task timeout');
    expect(scheduler.resources.snapshot()).toEqual({ AI: 0, VLM: 0, ADB: 0, IOS: 0 });
  });

  it('moves a running agent into human control and pauses its task', () => {
    const { devices, plane } = makePlane(12, false);
    plane.takeHumanControl('device-01');
    expect(devices.get('device-01')?.agentStatus).toBe('HUMAN_CONTROL');
    expect(devices.get('device-01')?.currentTask?.status).toBe('PAUSED');
    expect(devices.get('device-02')?.agentStatus).toBe('RUNNING');
  });

  it('sends manual taps only after explicit human takeover and keeps them device-local', async () => {
    const { devices, plane } = makePlane(12, false);
    await expect(plane.tapDevice('device-01', { x: 0.5, y: 0.5 })).rejects.toThrow('Take human control');
    plane.takeHumanControl('device-01');
    await plane.tapDevice('device-01', { x: 0.5, y: 0.5 }, 'FULLSCREEN_PREVIEW');
    const history = devices.get('device-01')?.actionHistory.map(event => event.message).join('\n') ?? '';
    expect(history).toContain('action=tap target=x=50% y=50%');
    expect(history).toContain('action=tap verification=UI_HIERARCHY_AFTER_ACTION');
    expect(devices.get('device-02')?.actionHistory.map(event => event.message).join('\n')).not.toContain('action=tap');
  });

  it('redacts text input in the device-local action history', async () => {
    const { devices, plane } = makePlane(12, false);
    plane.takeHumanControl('device-01');
    await plane.inputTextDevice('device-01', 'secret password');
    const message = devices.get('device-01')?.actionHistory.map(event => event.message).join('\n') ?? '';
    expect(message).toContain('action=input_text');
    expect(message).toContain('redactedLength=15');
    expect(message).toContain('verification=UI_HIERARCHY_AFTER_ACTION');
    expect(message).not.toContain('secret password');
    expect(devices.get('device-02')?.actionHistory.at(-1)?.message).not.toContain('input_text');
  });

  it('includes driver diagnostics on manual action failure without leaking input text', async () => {
    const { devices, drivers, plane } = makePlane(12, false);
    const driver = drivers.get('device-01') as SimulatedDeviceDriver & { inputText: (text: string) => Promise<void> };
    driver.inputText = vi.fn(async () => {
      throw new NativeToolError('ADB command failed for device-01 (serial-01)', 'adb -s serial-01 shell input text secret%spassword', 'input text secret password rejected');
    });
    plane.takeHumanControl('device-01');

    await expect(plane.inputTextDevice('device-01', 'secret password')).rejects.toThrow(NativeToolError);
    const message = devices.get('device-01')?.actionHistory.at(-1)?.message ?? '';
    expect(message).toContain('ADB command failed for device-01 (serial-01)');
    expect(message).toContain('command=adb -s serial-01 shell input text [REDACTED_TEXT]');
    expect(message).toContain('stderr=input text [REDACTED_TEXT]');
    expect(message).not.toContain('secret password');
    expect(message).not.toContain('secret%spassword');
  });

  it('records post-action UI hierarchy verification failures without masking the completed action', async () => {
    const { devices, drivers, plane } = makePlane(12, false);
    const driver = drivers.get('device-01') as SimulatedDeviceDriver & { getUiHierarchy: () => Promise<never> };
    driver.getUiHierarchy = vi.fn(async () => {
      throw new NativeToolError('UI hierarchy dump failed for device-01 (serial-01)', 'adb -s serial-01 exec-out uiautomator dump /dev/tty', 'uiautomator not available');
    });
    plane.takeHumanControl('device-01');

    await expect(plane.backDevice('device-01')).resolves.toBeUndefined();
    const history = devices.get('device-01')?.actionHistory.map(event => event.message).join('\n') ?? '';
    expect(history).toContain('action=back target=key=BACK');
    expect(history).toContain('action=back verification=UI_HIERARCHY_AFTER_ACTION');
    expect(history).toContain('result=ERROR');
    expect(history).toContain('command=adb -s serial-01 exec-out uiautomator dump /dev/tty');
  });

  it('routes stop app through the selected device driver and audits it locally', async () => {
    const { devices, drivers, plane } = makePlane(12, false);
    const driver = drivers.get('device-01') as SimulatedDeviceDriver & { stopApp: (appId: string, signal?: AbortSignal) => Promise<void> };
    const stopApp = vi.fn(async (_appId: string, _signal?: AbortSignal) => undefined);
    driver.stopApp = stopApp;
    plane.takeHumanControl('device-01');

    await plane.stopAppDevice('device-01', 'com.example.app');
    const history = devices.get('device-01')?.actionHistory.map(event => event.message).join('\n') ?? '';

    expect(stopApp).toHaveBeenCalledWith('com.example.app', expect.any(AbortSignal));
    expect(history).toContain('action=stop_app target=app=com.example.app');
    expect(devices.get('device-02')?.actionHistory.map(event => event.message).join('\n')).not.toContain('stop_app');
  });

  it('passes AbortSignal to manual driver actions and post-action verification', async () => {
    const { drivers, plane } = makePlane(12, false);
    const driver = drivers.get('device-01') as SimulatedDeviceDriver & {
      back: (signal?: AbortSignal) => Promise<void>;
      getUiHierarchy: (signal?: AbortSignal) => Promise<UiHierarchy>;
    };
    let actionSignal: AbortSignal | undefined;
    let observeSignal: AbortSignal | undefined;
    driver.back = vi.fn(async signal => { actionSignal = signal; });
    driver.getUiHierarchy = vi.fn(async signal => {
      observeSignal = signal;
      return { capturedAt: Date.now(), root: null, nodes: [] };
    });

    plane.takeHumanControl('device-01');
    await plane.backDevice('device-01');

    expect(actionSignal).toBeInstanceOf(AbortSignal);
    expect(observeSignal).toBeInstanceOf(AbortSignal);
    expect(actionSignal?.aborted).toBe(false);
    expect(observeSignal?.aborted).toBe(false);
  });

  it('aborts in-flight device commands when that device goes offline', async () => {
    const { devices, drivers, plane } = makePlane(12, false);
    const driver = drivers.get('device-01') as SimulatedDeviceDriver & { back: (signal?: AbortSignal) => Promise<void> };
    let actionSignal: AbortSignal | undefined;
    driver.back = vi.fn(signal => new Promise<void>((_resolve, reject) => {
      actionSignal = signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    plane.takeHumanControl('device-01');
    const pending = plane.backDevice('device-01');
    const assertion = expect(pending).rejects.toThrow('Device offline');
    await new Promise(resolve => setTimeout(resolve, 0));
    await plane.setOffline('device-01');
    await assertion;

    expect(actionSignal?.aborted).toBe(true);
    expect(devices.get('device-01')?.actionHistory.map(event => event.message).join('\n')).toContain('result=ERROR error=Device offline');
    expect(devices.get('device-02')?.status).toBe('ONLINE');
  });

  it('keeps tasks serialized per device while sharing the global worker pool', () => {
    const { devices, plane, scheduler } = makePlane(12, false);
    plane.stopDevice('device-01');
    const tasks = plane.submitBatch('Same device queue test', ['device-01', 'device-01', 'device-02']);
    const first = devices.get('device-01')?.currentTask;
    expect(first?.id).toBe(tasks[0].id);
    expect(devices.get('device-01')?.taskQueue.map(task => task.id)).toEqual([tasks[1].id]);
    expect(scheduler.workers.isActive(tasks[0].id)).toBe(true);
    expect(scheduler.workers.isActive(tasks[1].id)).toBe(false);
    void plane.completeTask(tasks[0].id);
    expect(devices.get('device-01')?.currentTask?.id).toBe(tasks[1].id);
    expect(scheduler.workers.isActive(tasks[1].id)).toBe(true);
  });
});
