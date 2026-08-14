import { describe, expect, it, vi } from 'vitest';
import { AgentWorkerPool, RateLimiter, ResourceLimiter } from './workerPool';
import { ControlPlane } from './controlPlane';
import { DriverRegistry, SimulatedDeviceDriver } from './deviceDriver';
import { DeviceManager } from './deviceManager';
import { SessionManager } from './sessionManager';
import { StreamManager } from './streamManager';
import { TaskScheduler } from './taskScheduler';
import type { ConcurrencyConfig, TaskInstance } from './types';
import { AndroidAdbScrcpyDriver, asciiFallbackInput, encodeAdbInputText } from './androidDeviceDriver';
import { IOSXCUITestDriver } from './iosXcuitestDriver';
import { NativeToolError, ProcessRunner } from './nativeProcess';
import { EventEmitter } from 'node:events';
import { encodeRgbaPng, scaleRgbaToMaxDimension } from './pngEncoder';
import { parseUiAutomatorXml, type UiHierarchy } from './androidUiHierarchy';
import type { AgentPlannerProvider } from './agentPlannerProvider';

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
      screenshot: vi.fn(), monitorFrame, getUiHierarchy: vi.fn(), getScreenSize: vi.fn(), tap: vi.fn(), swipe: vi.fn(), longPress: vi.fn(), inputText: vi.fn(), pressKey: vi.fn(), back: vi.fn(), home: vi.fn(), launchApp: vi.fn(), restartApp: vi.fn(), stopApp: vi.fn(),
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
    expect(calls.map(call => call.args.join(' '))).toContain(`-s serial-01 shell input keyevent ${Array.from({ length: 24 }, () => 'KEYCODE_DEL').join(' ')}`);
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell input text hello%sworld%s\\&%sok');
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell input keyevent KEYCODE_BACK');
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell input keyevent KEYCODE_HOME');
    await driver.pressKey('Enter');
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell input keyevent KEYCODE_ENTER');
    expect(calls.map(call => call.args.join(' '))).toContain('-s serial-01 shell am force-stop com.example');
    expect(encodeAdbInputText('a b')).toBe('a%sb');
    expect(asciiFallbackInput('苹果Mac mini M4 16G')).toBe('Mac mini M4 16G');
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

  it('returns an empty hierarchy immediately when MIUI theme dump is unavailable', async () => {
    const calls: Array<{ args: string[] }> = [];
    const runner = {
      run: vi.fn(async (options: { args: string[] }) => {
        calls.push(options);
        const joined = options.args.join(' ');
        if (joined.includes('get-state')) return { code: 0, stdout: 'device\n', stderr: '' };
        if (joined.includes('exec-out uiautomator dump /dev/tty')) {
          return {
            code: 1,
            stdout: '',
            stderr: 'java.io.FileNotFoundException: /data/system/theme_config/theme_compatibility.xml: open failed: ENOENT',
          };
        }
        return { code: 1, stdout: '', stderr: `unexpected ${joined}` };
      }),
      spawn: vi.fn(),
    } as unknown as ProcessRunner;
    const driver = new AndroidAdbScrcpyDriver('device-01', { serial: 'serial-01', runner });

    await driver.connect();
    const first = await driver.getUiHierarchy();
    const second = await driver.getUiHierarchy();
    const dumpCalls = calls.filter(call => call.args.includes('uiautomator'));

    expect(first.nodes).toEqual([]);
    expect(second.nodes).toEqual([]);
    expect(dumpCalls).toHaveLength(1);
  });

  it('caches an empty hierarchy when UIAutomator returns no nodes', async () => {
    const calls: Array<{ args: string[] }> = [];
    const runner = {
      run: vi.fn(async (options: { args: string[] }) => {
        calls.push(options);
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
    const first = await driver.getUiHierarchy();
    const second = await driver.getUiHierarchy();
    const dumpCalls = calls.filter(call => call.args.includes('uiautomator'));

    expect(first.nodes).toEqual([]);
    expect(second.nodes).toEqual([]);
    expect(dumpCalls).toHaveLength(2);
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

  it('uses WDA drag, touch-and-hold, keys, and home routes for iOS gestures', async () => {
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
      if (url.endsWith('/element/active')) {
        return new Response(JSON.stringify({ value: { 'element-6066-11e4-a52e-4f735466cecf': 'elem-input-1' } }), { status: 200 });
      }
      if (url.endsWith('/attribute/value')) {
        return new Response(JSON.stringify({ value: 'hello' }), { status: 200 });
      }
      if (url.includes('/element/elem-input-1/value')) return new Response(JSON.stringify({ value: null }), { status: 200 });
      if (url.includes('/wda/')) return new Response(JSON.stringify({ value: null }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const driver = new IOSXCUITestDriver('device-03', {
      udid: '00008020-001C259A0ED8003A',
      wdaUrl: 'http://127.0.0.1:8100',
      request,
    });

    await driver.connect();
    await driver.swipe({ from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, durationMs: 400 });
    await driver.longPress({ point: { x: 0.4, y: 0.6 }, durationMs: 700 });
    await driver.inputText('hello', undefined);
    await driver.pressKey('Backspace');
    await driver.home();

    expect(requests).toContainEqual({
      url: 'http://127.0.0.1:8100/session/session-03/wda/keys',
      method: 'POST',
      body: JSON.stringify({ value: ['\uE003'], frequency: 4800 }),
    });
    expect(requests).toContainEqual({
      url: 'http://127.0.0.1:8100/session/session-03/wda/dragfromtoforduration',
      method: 'POST',
      body: JSON.stringify({ fromX: 195, fromY: 674, toX: 195, toY: 169, duration: 0.02 }),
    });
    expect(requests).toContainEqual({
      url: 'http://127.0.0.1:8100/session/session-03/wda/touchAndHold',
      method: 'POST',
      body: JSON.stringify({ x: 156, y: 506, duration: 0.7 }),
    });
    expect(requests).toContainEqual({
      url: 'http://127.0.0.1:8100/session/session-03/wda/keys',
      method: 'POST',
      body: JSON.stringify({ value: ['h', 'e', 'l', 'l', 'o'], frequency: 4800 }),
    });
    expect(requests).toContainEqual({
      url: 'http://127.0.0.1:8100/session/session-03/wda/pressButton',
      method: 'POST',
      body: JSON.stringify({ name: 'home' }),
    });
  });

  it('uses coordinate flick for iOS wheel scrolling', async () => {
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
      if (url.includes('/wda/')) return new Response(JSON.stringify({ value: null }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const driver = new IOSXCUITestDriver('device-03', {
      udid: '00008020-001C259A0ED8003A',
      wdaUrl: 'http://127.0.0.1:8100',
      request,
    });

    await driver.connect();
    await driver.scrollWheel?.({ point: { x: 0.5, y: 0.5 }, deltaX: 0, deltaY: 120 });

    expect(requests).toContainEqual({
      url: 'http://127.0.0.1:8100/session/session-03/wda/dragfromtoforduration',
      method: 'POST',
      body: JSON.stringify({ fromX: 195, fromY: 422, toX: 195, toY: 270, duration: 0 }),
    });
  });

  it('uses drag-from-to as the iOS tap primitive and disables WDA idle waits', async () => {
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
      if (url.endsWith('/session/session-03/wda/dragfromtoforduration')) return new Response(JSON.stringify({ value: null }), { status: 200 });
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
            waitForIdleTimeout: 0,
            animationCoolOffTimeout: 0,
            screenshotQuality: 2,
            mjpegServerFramerate: 15,
            mjpegScalingFactor: 56,
            mjpegServerScreenshotQuality: 35,
          },
        }),
      },
      { url: 'http://127.0.0.1:8100/session/session-03/window/size', method: 'GET', body: undefined },
      { url: 'http://127.0.0.1:8100/session/session-03/orientation', method: 'GET', body: undefined },
      { url: 'http://127.0.0.1:8100/session/session-03/wda/dragfromtoforduration', method: 'POST', body: JSON.stringify({ fromX: 195, fromY: 211, toX: 195, toY: 211, duration: 0 }) },
    ]);
  });

  it('recreates a stale WDA session once when tap hits a recoverable session error', async () => {
    let tapAttempts = 0;
    let sessionCounter = 0;
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status')) return new Response(JSON.stringify({ value: { ready: true } }), { status: 200 });
      if (url.endsWith('/session') && init?.method === 'POST') {
        sessionCounter += 1;
        const sessionId = `session-${sessionCounter}`;
        return new Response(JSON.stringify({ value: { sessionId }, sessionId }), { status: 200 });
      }
      if (url.endsWith('/appium/settings')) return new Response(JSON.stringify({ value: {} }), { status: 200 });
      if (url.endsWith('/window/size')) return new Response(JSON.stringify({ value: { width: 390, height: 844 } }), { status: 200 });
      if (url.endsWith('/orientation')) return new Response(JSON.stringify({ value: 'PORTRAIT' }), { status: 200 });
      if (url.includes('/wda/dragfromtoforduration')) {
        tapAttempts += 1;
        if (tapAttempts === 1) return new Response(JSON.stringify({ value: { error: 'invalid session id' } }), { status: 404 });
        return new Response(JSON.stringify({ value: null }), { status: 200 });
      }
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ value: null }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const driver = new IOSXCUITestDriver('device-03', {
      udid: '00008020-001C259A0ED8003A',
      wdaUrl: 'http://127.0.0.1:8100',
      request,
    });

    await driver.connect();
    await driver.tap({ x: 0.5, y: 0.5 });

    expect(tapAttempts).toBe(2);
    expect(sessionCounter).toBe(2);
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
  const makePlane = (count = 12, autoExecute = false, driverLatency = 0, plannerProvider?: AgentPlannerProvider) => {
    const devices = new DeviceManager(count);
    const scheduler = new TaskScheduler({ maxConcurrentAI: 8, maxConcurrentVLM: 4, maxConcurrentADB: 12, maxConcurrentIOS: 4, timeoutMs: 500, maxRetries: 2, rateLimitPerMinute: 60 });
    const drivers = new DriverRegistry();
    devices.getAll().forEach(device => drivers.register(new SimulatedDeviceDriver(device, driverLatency)));
    return { devices, scheduler, drivers, plane: new ControlPlane(devices, scheduler, drivers, { autoExecute, plannerProvider }) };
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

  it('archives selected-device step trace metadata without screenshot binaries', async () => {
    const { devices, plane } = makePlane(1, true);
    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('Check the dashboard', ['device-01']);

    await waitFor(() => task.status === 'SUCCESS', 600);
    const state = plane.getAgentState('device-01');
    const trace = state.recentStepRecords;

    expect(trace.length).toBeGreaterThanOrEqual(2);
    expect(trace.map(record => record.deviceId)).toEqual(trace.map(() => 'device-01'));
    expect(trace.some(record => record.status === 'VERIFIED')).toBe(true);
    expect(trace.some(record => record.status === 'FINISHED')).toBe(true);
    expect(trace[0].observation.screenshot).toMatchObject({ source: 'ON_DEMAND_SCREENSHOT', purpose: 'AI_OBSERVATION', width: 1440, height: 2560 });
    expect(JSON.stringify(state)).not.toContain('data');
  });

  it('records task artifacts separately from step trace and keeps them device-local', async () => {
    const { plane } = makePlane(2, true);
    plane.stopDevice('device-01');
    plane.stopDevice('device-02');
    const [first, second] = plane.submitBatch('Check the dashboard', ['device-01', 'device-02']);

    await waitFor(() => first.status === 'SUCCESS' && second.status === 'SUCCESS', 600);
    const artifacts = plane.getTaskArtifacts('device-01', first.id);
    const artifactTypes = new Set(artifacts.map(artifact => artifact.type));
    const summary = plane.getTaskArtifactSummary('device-01', first.id);

    expect(artifactTypes).toEqual(new Set(['AI_OBSERVATION_SCREENSHOT', 'POST_ACTION_SCREENSHOT', 'UI_HIERARCHY_SUMMARY', 'PLANNER_REQUEST', 'PLANNER_RESPONSE']));
    expect(artifacts.every(artifact => artifact.deviceId === 'device-01' && artifact.taskInstanceId === first.id)).toBe(true);
    expect(artifacts.every(artifact => artifact.hasBinary === false)).toBe(true);
    expect(summary.total).toBe(artifacts.length);
    expect(plane.artifactStore.listTaskArtifacts('device-02', first.id)).toHaveLength(0);
    expect(() => plane.getTaskArtifacts('device-02', first.id)).toThrow(`Task ${first.id} belongs to device-01, not device-02`);
  });

  it('lists global task summaries without duplicating current, queued, or history tasks', async () => {
    const { devices, plane } = makePlane(2, false);
    plane.stopDevice('device-01');
    const [first, queued, sibling] = plane.submitBatch('Task center index', ['device-01', 'device-01', 'device-02']);
    await plane.completeTask(first.id);

    const result = plane.listTasks({ limit: 20 });
    const ids = result.tasks.map(task => task.taskId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([first.id, queued.id, sibling.id]));
    expect(result.tasks.find(task => task.taskId === queued.id)).toMatchObject({ deviceId: 'device-01', deviceName: devices.get('device-01')?.name });
    expect(JSON.stringify(result.tasks)).not.toContain('stepTrace');
    expect(JSON.stringify(result.tasks)).not.toContain('redactedPayload');
    expect(JSON.stringify(result.tasks)).not.toContain('uiTree');
  });

  it('returns selected task audit without leaking sibling task artifacts', async () => {
    const { plane } = makePlane(2, true);
    plane.stopDevice('device-01');
    plane.stopDevice('device-02');
    const [first, second] = plane.submitBatch('Check task audit isolation', ['device-01', 'device-02']);

    await waitFor(() => first.status === 'SUCCESS' && second.status === 'SUCCESS', 600);
    const audit = plane.getTaskAudit('device-01', first.id, 3);

    expect(audit.task.taskId).toBe(first.id);
    expect(audit.device.id).toBe('device-01');
    expect(audit.trace.every(record => record.deviceId === 'device-01' && record.taskInstanceId === first.id)).toBe(true);
    expect(audit.artifacts.every(artifact => artifact.deviceId === 'device-01' && artifact.taskInstanceId === first.id)).toBe(true);
    expect(JSON.stringify(audit.artifacts)).not.toMatch(/"data"\s*:/u);
    expect(() => plane.getTaskAudit('device-02', first.id)).toThrow(`Task ${first.id} belongs to device-01, not device-02`);
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

  it('accumulates planner usage and re-observes on each multi-step planner call', async () => {
    const observedSteps: number[] = [];
    const plannerProvider: AgentPlannerProvider = {
      id: 'usage-provider',
      async plan(observation) {
        observedSteps.push(observation.currentStep);
        const action = observation.currentStep === 0
          ? {
              actionId: `wait-${observation.currentStep}`,
              deviceId: observation.deviceId,
              taskInstanceId: observation.taskInstanceId,
              source: 'MOCK_PLANNER' as const,
              type: 'wait' as const,
              durationMs: 0,
              reason: 'first step waits to force another observation',
            }
          : {
              actionId: `finish-${observation.currentStep}`,
              deviceId: observation.deviceId,
              taskInstanceId: observation.taskInstanceId,
              source: 'MOCK_PLANNER' as const,
              type: 'finish' as const,
              reason: 'second step finishes after re-observation',
            };
        return { action, usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10, estimatedCostUsd: 0.002 } };
      },
    };
    const { plane } = makePlane(1, true, 0, plannerProvider);
    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('multi-step usage accounting', ['device-01']);

    await waitFor(() => task.status === 'SUCCESS', 600);
    const summary = plane.listTasks({ deviceId: 'device-01' }).tasks.find(item => item.taskId === task.id)!;

    expect(observedSteps).toEqual([0, 1]);
    expect(task.completedSteps).toBe(1);
    expect(summary.totalTokens).toBe(20);
    expect(summary.estimatedCostUsd).toBeCloseTo(0.004);
    expect(summary.plannerLatencyMs).toBeGreaterThanOrEqual(0);
    expect(plane.getTaskAudit('device-01', task.id).trace.some(record => record.telemetry?.usage?.totalTokens === 10)).toBe(true);
  });

  it('executes selector-driven tap_element goals from Android UIAutomator text', async () => {
    const { drivers, plane } = makePlane(1, true);
    const driver = drivers.get('device-01') as SimulatedDeviceDriver & {
      getUiHierarchy: () => Promise<UiHierarchy>;
      getScreenSize: () => Promise<{ width: number; height: number }>;
      tap: (point: { x: number; y: number }, signal?: AbortSignal) => Promise<void>;
    };
    driver.getUiHierarchy = vi.fn(async () => parseUiAutomatorXml(`
<hierarchy rotation="0">
  <node index="0" text="Open" resource-id="com.example:id/open" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" bounds="[100,200][300,400]" />
</hierarchy>`));
    driver.getScreenSize = vi.fn(async () => ({ width: 1000, height: 2000 }));
    const tap = vi.fn(async (_point: { x: number; y: number }, _signal?: AbortSignal) => undefined);
    driver.tap = tap;

    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('tap text:Open', ['device-01']);

    await waitFor(() => task.status === 'SUCCESS');
    expect(tap).toHaveBeenCalledWith({ x: 200 / 999, y: 300 / 1999 }, expect.any(AbortSignal));
  });

  it('fails selector-driven tap_element without fallback coordinates when no element matches', async () => {
    const { drivers, plane } = makePlane(1, true);
    const driver = drivers.get('device-01') as SimulatedDeviceDriver & {
      getUiHierarchy: () => Promise<UiHierarchy>;
      tap: (point: { x: number; y: number }, signal?: AbortSignal) => Promise<void>;
    };
    driver.getUiHierarchy = vi.fn(async () => parseUiAutomatorXml('<hierarchy rotation="0"/>'));
    const tap = vi.fn(async (_point: { x: number; y: number }, _signal?: AbortSignal) => undefined);
    driver.tap = tap;

    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('tap text:Missing', ['device-01']);

    await waitFor(() => task.status === 'FAILED');
    expect(tap).not.toHaveBeenCalled();
    expect(task.error).toContain('No UI element matched selector');
  });

  it('redacts deterministic input_text goal content from agent task history', async () => {
    const { devices, plane } = makePlane(1, true);
    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('input text:secret password', ['device-01']);

    await waitFor(() => task.status === 'SUCCESS');
    const history = devices.get('device-01')?.actionHistory.map(event => event.message).join('\n') ?? '';
    expect(history).toContain('agentAction=input_text');
    expect(history).toContain('redactedLength=15');
    expect(history).not.toContain('secret password');
  });

  it('puts sensitive goals into human approval without executing the action', async () => {
    const { devices, drivers, plane } = makePlane(1, true);
    const driver = drivers.get('device-01') as SimulatedDeviceDriver & { tap: (point: { x: number; y: number }) => Promise<void> };
    const tap = vi.fn(async (_point: { x: number; y: number }) => undefined);
    driver.tap = tap;

    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('点赞 tap text:Like', ['device-01']);

    await waitFor(() => task.status === 'WAITING_APPROVAL');
    expect(tap).not.toHaveBeenCalled();
    expect(devices.get('device-01')?.taskContext.variables.pendingApproval).toMatchObject({ type: 'request_human' });
    expect(plane.getAgentState('device-01').currentStepRecord).toMatchObject({ status: 'WAITING_APPROVAL', approval: { required: true } });
    expect(plane.scheduler.workers.isActive(task.id)).toBe(false);
  });

  it('approves and rejects only the targeted device task', async () => {
    const { devices, plane } = makePlane(2, true);
    plane.stopDevice('device-01');
    plane.stopDevice('device-02');
    const [first, second] = plane.submitBatch('点赞一下', ['device-01', 'device-02']);

    await waitFor(() => first.status === 'WAITING_APPROVAL' && second.status === 'WAITING_APPROVAL');
    plane.approveTask('device-01', first.id);
    await waitFor(() => first.status === 'SUCCESS');
    expect(second.status).toBe('WAITING_APPROVAL');
    expect(plane.getAgentState('device-01').recentStepRecords.some(record => record.approval?.decision === 'APPROVED')).toBe(true);
    expect(plane.getTaskArtifacts('device-01', first.id).some(artifact => artifact.type === 'APPROVAL_DECISION' && artifact.metadata.decision === 'APPROVED')).toBe(true);

    await plane.rejectTask('device-02', second.id);
    expect(second.status).toBe('FAILED');
    expect(plane.getAgentState('device-02').recentStepRecords.some(record => record.approval?.decision === 'REJECTED')).toBe(true);
    expect(plane.getTaskArtifacts('device-02', second.id).some(artifact => artifact.type === 'APPROVAL_DECISION' && artifact.metadata.decision === 'REJECTED')).toBe(true);
    expect(devices.get('device-01')?.taskHistory.at(-1)?.id).toBe(first.id);
    expect(devices.get('device-02')?.taskHistory.at(-1)?.id).toBe(second.id);
  });

  it('rejects non-whitelisted planner actions without affecting sibling tasks', async () => {
    const plannerProvider: AgentPlannerProvider = {
      id: 'test-invalid-provider',
      async plan(observation) {
        if (observation.deviceId === 'device-01') {
          return {
            actionId: `invalid-${observation.deviceId}`,
            deviceId: observation.deviceId,
            taskInstanceId: observation.taskInstanceId,
            source: 'MOCK_PLANNER',
            type: 'shell',
            reason: 'invalid planner output',
            command: 'adb shell input tap 1 1',
          } as never;
        }
        return {
          actionId: `finish-${observation.deviceId}`,
          deviceId: observation.deviceId,
          taskInstanceId: observation.taskInstanceId,
          source: 'MOCK_PLANNER',
          type: 'finish',
          reason: 'sibling task can finish independently',
        };
      },
    };
    const { plane } = makePlane(2, true, 0, plannerProvider);
    plane.stopDevice('device-01');
    plane.stopDevice('device-02');
    const [failed, succeeded] = plane.submitBatch('custom provider isolation', ['device-01', 'device-02']);

    await waitFor(() => failed.status === 'FAILED' && succeeded.status === 'SUCCESS', 600);

    expect(failed.error).toContain('Invalid discriminator value');
    expect(succeeded.status).toBe('SUCCESS');
    expect(plane.getAgentState('device-01').recentStepRecords.at(-1)?.status).toBe('FAILED');
    expect(plane.getAgentState('device-02').recentStepRecords.at(-1)?.status).toBe('FINISHED');
  });

  it('marks only the interrupted device step trace as DEVICE_OFFLINE', async () => {
    const { devices, plane } = makePlane(2, true, 60);
    plane.stopDevice('device-01');
    plane.stopDevice('device-02');
    const [first, second] = plane.submitBatch('Check offline interruption', ['device-01', 'device-02']);

    await waitFor(() => (devices.get('device-01')?.taskContext.stepTrace?.length ?? 0) > 0, 400);
    await plane.setOffline('device-01');

    expect(first.status).toBe('DEVICE_OFFLINE');
    await waitFor(() => second.status === 'SUCCESS', 900);
    expect(plane.getAgentState('device-01').recentStepRecords.at(-1)?.status).toBe('DEVICE_OFFLINE');
    expect(devices.get('device-02')?.status).toBe('ONLINE');
  });

  it('records a max-step failure when a planner never finishes', async () => {
    const plannerProvider: AgentPlannerProvider = {
      id: 'test-wait-forever-provider',
      async plan(observation) {
        return {
          actionId: `wait-${observation.currentStep}`,
          deviceId: observation.deviceId,
          taskInstanceId: observation.taskInstanceId,
          source: 'MOCK_PLANNER',
          type: 'wait',
          durationMs: 0,
          reason: 'exercise max-step guard',
        };
      },
    };
    const { plane } = makePlane(1, true, 0, plannerProvider);
    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('never finish', ['device-01']);

    await waitFor(() => task.status === 'FAILED', 1_000);

    expect(task.error).toContain('Max agent steps reached');
    expect(plane.getAgentState('device-01').recentStepRecords.at(-1)).toMatchObject({ status: 'FAILED', verification: { result: 'ERROR' } });
  });

  it('keeps batch task failure isolated from a sibling selector-driven success', async () => {
    const { drivers, plane } = makePlane(2, true);
    const missingDriver = drivers.get('device-01') as SimulatedDeviceDriver & { getUiHierarchy: () => Promise<UiHierarchy> };
    const matchingDriver = drivers.get('device-02') as SimulatedDeviceDriver & { getUiHierarchy: () => Promise<UiHierarchy> };
    missingDriver.getUiHierarchy = vi.fn(async () => parseUiAutomatorXml('<hierarchy rotation="0"/>'));
    matchingDriver.getUiHierarchy = vi.fn(async () => parseUiAutomatorXml(`
<hierarchy rotation="0">
  <node index="0" text="Open" resource-id="com.example:id/open" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" bounds="[10,10][110,110]" />
</hierarchy>`));

    plane.stopDevice('device-01');
    plane.stopDevice('device-02');
    const [failed, succeeded] = plane.submitBatch('tap text:Open', ['device-01', 'device-02']);

    await waitFor(() => failed.status === 'FAILED' && succeeded.status === 'SUCCESS');
    expect(failed.deviceId).toBe('device-01');
    expect(succeeded.deviceId).toBe('device-02');
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
    const [task] = plane.submitBatch('verify recover dashboard task', ['device-01']);
    const originalTask = devices.get('device-01')?.currentTask;
    await plane.setOffline('device-01');
    expect(devices.get('device-01')?.currentTask).toBe(originalTask);
    expect(task.status).toBe('DEVICE_OFFLINE');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(task.status).toBe('DEVICE_OFFLINE');
    await plane.recover('device-01');
    plane.resumeDevice('device-01');
    await waitFor(() => task.status === 'SUCCESS', 500);
    expect(task.status).toBe('SUCCESS');
    expect(devices.get('device-01')?.currentTask).toBeNull();
  });

  it('does not start a second execution when pause and resume race cancellation', async () => {
    const { devices, plane } = makePlane(1, true, 20);
    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('verify pause and resume safely', ['device-01']);
    plane.pauseDevice('device-01');
    plane.resumeDevice('device-01');
    await waitFor(() => task.status === 'SUCCESS', 500);
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

  it('does not block manual screen input when the global IOS pool is exhausted', async () => {
    const devices = new DeviceManager(4);
    const scheduler = new TaskScheduler({ ...config, rateLimitPerMinute: 60 });
    const drivers = new DriverRegistry();
    for (const session of devices.getAll()) {
      drivers.register(new SimulatedDeviceDriver(session, 1));
    }
    const plane = new ControlPlane(devices, scheduler, drivers, { autoExecute: false });
    for (let index = 0; index < 4; index += 1) {
      expect(scheduler.resources.acquire('IOS')).toBe(true);
    }
    expect(scheduler.resources.acquire('IOS')).toBe(false);
    plane.takeHumanControl('device-03');
    await expect(plane.tapDevice('device-03', { x: 0.5, y: 0.5 })).resolves.toBeUndefined();
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
