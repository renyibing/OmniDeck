import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AndroidAdbScrcpyDriver } from '../domain/androidDeviceDriver';
import { NativeToolError } from '../domain/nativeProcess';
import { ControlDaemon } from './controlDaemon';

const daemons: ControlDaemon[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

async function start(options: ConstructorParameters<typeof ControlDaemon>[0] = {}) {
  const daemon = new ControlDaemon({ autoExecute: false, healthCheckIntervalMs: 0, ...options });
  const server = await daemon.listen({ host: '127.0.0.1', port: 0 });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Daemon did not expose a TCP address');
  daemons.push(daemon);
  return { daemon, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function json(baseUrl: string, path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json() as Record<string, unknown>;
  return { response, body };
}

function postBody(command: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) };
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map(daemon => daemon.close()));
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

describe('Control Daemon HTTP/SSE protocol', () => {
  it('keeps native drivers disabled by default and requires explicit real-device identifiers', async () => {
    const daemon = new ControlDaemon({ healthCheckIntervalMs: 0 });
    expect((await daemon.discovery.discover()).every(candidate => candidate.simulated)).toBe(true);
    expect(() => new ControlDaemon({ realDevices: true, driverMode: 'ANDROID_ADB_SCRCPY', healthCheckIntervalMs: 0 })).toThrow('androidSerial');
  });

  it('binds an explicitly configured Android driver to device-01 and keeps other sessions simulated', async () => {
    const daemon = new ControlDaemon({ realDevices: true, driverMode: 'ANDROID_ADB_SCRCPY', androidSerial: 'serial-01', healthCheckIntervalMs: 0 });
    await daemon.discovery.discover();
    expect(daemon.drivers.get('device-01')).toBeInstanceOf(AndroidAdbScrcpyDriver);
    expect(daemon.discovery.getByDeviceId('device-01')?.simulated).toBe(false);
    expect(daemon.drivers.get('device-03')).not.toBeInstanceOf(AndroidAdbScrcpyDriver);
    expect(daemon.discovery.getByDeviceId('device-03')).toBeUndefined();
  });

  it('binds one Android and two iOS devices without reusing a device session', async () => {
    const daemon = new ControlDaemon({
      realDevices: true,
      androidDevices: [{ serial: 'serial-01' }],
      iosDevices: [
        { udid: 'ios-udid-01', wdaUrl: 'http://127.0.0.1:8100' },
        { udid: 'ios-udid-02', wdaUrl: 'http://127.0.0.1:8101' },
      ],
      healthCheckIntervalMs: 0,
    });
    const discovered = await daemon.discovery.discover();
    expect(new Set(discovered.map(device => device.deviceId)).size).toBe(3);
    expect(discovered.filter(device => device.platform === 'IOS')).toHaveLength(2);
    expect(discovered.every(device => device.simulated === false)).toBe(true);
  });

  it('restores persisted iOS configuration and reconnects after a daemon restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnideck-state-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stateFilePath = join(dir, 'daemon-state.json');
    const wda = await startStubWda();
    cleanups.push(() => closeServer(wda.server));

    const first = new ControlDaemon({
      autoExecute: false,
      healthCheckIntervalMs: 0,
      realDevices: true,
      iosDevices: [{ udid: 'ios-udid-01', wdaUrl: wda.baseUrl }],
      stateFilePath,
    });
    daemons.push(first);
    const firstServer = await first.listen({ host: '127.0.0.1', port: 0 });
    const firstAddress = firstServer.address();
    if (!firstAddress || typeof firstAddress === 'string') throw new Error('Daemon did not expose a TCP address');
    const firstBaseUrl = `http://127.0.0.1:${firstAddress.port}`;

    await json(firstBaseUrl, '/api/devices/discovery');
    await json(firstBaseUrl, '/api/devices/configure', postBody({
      commandId: 'persist-ios-config',
      timestamp: Date.now(),
      configuration: {
        deviceId: 'device-03',
        platform: 'IOS',
        name: 'Persisted iPhone',
        identifier: 'ios-udid-01',
        appId: 'com.omnideck.market.ios',
        transport: 'XCUITEST',
        orientation: 'PORTRAIT',
        driverMode: 'IOS_XCUITEST',
        wdaUrl: wda.baseUrl,
      },
    }));
    await json(firstBaseUrl, '/api/devices/device-03/connect', postBody({
      commandId: 'persist-ios-connect',
      timestamp: Date.now(),
      deviceId: 'device-03',
    }));
    await first.close();
    daemons.splice(daemons.indexOf(first), 1);

    const second = new ControlDaemon({
      autoExecute: false,
      healthCheckIntervalMs: 0,
      realDevices: true,
      iosDevices: [{ udid: 'ios-udid-01', wdaUrl: wda.baseUrl }],
      stateFilePath,
    });
    daemons.push(second);
    const secondServer = await second.listen({ host: '127.0.0.1', port: 0 });
    const secondAddress = secondServer.address();
    if (!secondAddress || typeof secondAddress === 'string') throw new Error('Daemon did not expose a TCP address');
    const secondBaseUrl = `http://127.0.0.1:${secondAddress.port}`;
    const runtime = await json(secondBaseUrl, '/api/runtime');
    const restored = (runtime.body.devices as Array<Record<string, unknown>>).find(device => device.id === 'device-03');

    expect(restored?.name).toBe('Persisted iPhone');
    expect((restored?.configuration as Record<string, unknown>).identifier).toBe('ios-udid-01');
    expect((restored?.connection as Record<string, unknown>).state).toBe('CONNECTED');
    expect(restored?.livePreview).toBe(true);
    expect(wda.requests.filter(request => request.url.endsWith('/session')).length).toBeGreaterThanOrEqual(2);
  });

  it('returns WDA diagnostics and blocks iOS connect before session creation when the tunnel is missing', async () => {
    const wdaUrl = await unavailableLocalUrl();
    const { baseUrl } = await start({
      realDevices: true,
      iosDevices: [{ udid: 'ios-udid-01', wdaUrl }],
    });

    await json(baseUrl, '/api/devices/discovery');
    await json(baseUrl, '/api/devices/configure', postBody({
      commandId: 'configure-unreachable-ios',
      timestamp: Date.now(),
      configuration: {
        deviceId: 'device-03',
        platform: 'IOS',
        name: 'Unreachable iPhone',
        identifier: 'ios-udid-01',
        appId: 'com.omnideck.market.ios',
        transport: 'XCUITEST',
        orientation: 'PORTRAIT',
        driverMode: 'IOS_XCUITEST',
        wdaUrl,
      },
    }));
    const diagnostics = await json(baseUrl, '/api/devices/device-03/wda-status');
    const result = await json(baseUrl, '/api/devices/device-03/connect', postBody({
      commandId: 'connect-unreachable-ios',
      timestamp: Date.now(),
      deviceId: 'device-03',
    }));
    const runtime = await json(baseUrl, '/api/runtime');
    const device = (runtime.body.devices as Array<Record<string, unknown>>).find(item => item.id === 'device-03');

    expect(diagnostics.response.status).toBe(200);
    expect(diagnostics.body.wdaStatus).toMatchObject({ state: 'PORT_TUNNEL_MISSING', deviceId: 'device-03', udid: 'ios-udid-01', localPortListening: false, statusReady: false });
    expect(((diagnostics.body.wdaStatus as Record<string, unknown>).nextAction as string)).toContain('iproxy');
    expect(result.response.status).toBe(503);
    expect(result.body.error).toContain('PORT_TUNNEL_MISSING');
    expect(result.body.error).toContain('ECONNREFUSED');
    expect(((device?.connection as Record<string, unknown>).error as string)).toContain('PORT_TUNNEL_MISSING');
  });

  it('reports WDA_READY when the device-local WDA endpoint responds', async () => {
    const wda = await startStubWda();
    cleanups.push(() => closeServer(wda.server));
    const { baseUrl } = await start({
      realDevices: true,
      iosDevices: [{ udid: 'ios-udid-01', wdaUrl: wda.baseUrl }],
    });

    await json(baseUrl, '/api/devices/discovery');
    await json(baseUrl, '/api/devices/configure', postBody({
      commandId: 'configure-ready-ios',
      timestamp: Date.now(),
      configuration: {
        deviceId: 'device-03',
        platform: 'IOS',
        name: 'Ready iPhone',
        identifier: 'ios-udid-01',
        appId: 'com.omnideck.market.ios',
        transport: 'XCUITEST',
        orientation: 'PORTRAIT',
        driverMode: 'IOS_XCUITEST',
        wdaUrl: wda.baseUrl,
      },
    }));
    const diagnostics = await json(baseUrl, '/api/devices/device-03/wda-status');

    expect(diagnostics.response.status).toBe(200);
    expect(diagnostics.body.wdaStatus).toMatchObject({ state: 'WDA_READY', deviceId: 'device-03', udid: 'ios-udid-01', localPortListening: true, statusReady: true });
    expect(((diagnostics.body.wdaStatus as Record<string, unknown>).nextAction as string)).toContain('Click Connect');
  });

  it('exposes 32 lightweight devices and preserves session identity across reload-like fetches', async () => {
    const { baseUrl } = await start();
    const first = await json(baseUrl, '/api/runtime');
    const second = await json(baseUrl, '/api/runtime');
    const devices = first.body.devices as Array<Record<string, unknown>>;
    const server = first.body.server as Record<string, unknown>;

    expect(first.response.status).toBe(200);
    expect(devices).toHaveLength(32);
    expect(server.sessionEpoch).toBe((second.body.server as Record<string, unknown>).sessionEpoch);
    expect(devices[0]).not.toHaveProperty('actionHistory');
    expect(devices[0]).not.toHaveProperty('taskContext');
    expect(devices[0]).not.toHaveProperty('uiTree');
    expect(devices[0]).toHaveProperty('queuedTaskCount');
    expect(devices[0].sessionRevision).toBe(1);
  });

  it('loads timeline and task history only through the selected-device detail endpoint', async () => {
    const { baseUrl } = await start();
    const result = await json(baseUrl, '/api/devices/device-01');
    const device = result.body.device as Record<string, unknown>;

    expect(result.response.status).toBe(200);
    expect(device).toHaveProperty('actionHistory');
    expect(device).toHaveProperty('taskContext');
    expect(device).toHaveProperty('taskHistory');
    expect(device).toHaveProperty('agentSessionId');
    expect(device).toHaveProperty('logs');
  });

  it('discovers, configures, and connects one Android and one iOS session without replacing them', async () => {
    const { baseUrl, daemon } = await start();
    const beforeAndroid = await json(baseUrl, '/api/devices/device-01');
    const beforeIOS = await json(baseUrl, '/api/devices/device-03');
    const discovery = await json(baseUrl, '/api/devices/discovery');
    const candidates = discovery.body.devices as Array<Record<string, unknown>>;

    expect(discovery.response.status).toBe(200);
    expect(candidates).toHaveLength(2);
    expect(candidates.map(candidate => candidate.platform)).toEqual(['ANDROID', 'IOS']);
    expect(candidates.every(candidate => candidate.simulated === true)).toBe(true);

    const androidConfiguration = {
      deviceId: 'device-01', platform: 'ANDROID', name: 'Android QA', identifier: 'omni-android-01',
      appId: 'com.omnideck.market', transport: 'ADB', orientation: 'PORTRAIT',
    };
    const configured = await json(baseUrl, '/api/devices/configure', postBody({
      commandId: 'configure-android-1', timestamp: Date.now(), configuration: androidConfiguration,
    }));
    const connected = await json(baseUrl, '/api/devices/device-01/connect', postBody({
      commandId: 'connect-android-1', timestamp: Date.now(), deviceId: 'device-01',
    }));
    const afterAndroid = await json(baseUrl, '/api/devices/device-01');
    const afterIOS = await json(baseUrl, '/api/devices/device-03');

    expect(configured.response.status).toBe(200);
    expect(connected.response.status).toBe(200);
    expect((afterAndroid.body.device as Record<string, unknown>).name).toBe('Android QA');
    expect((afterAndroid.body.device as Record<string, unknown>).sessionRevision).toBe((beforeAndroid.body.device as Record<string, unknown>).sessionRevision);
    expect(((afterAndroid.body.device as Record<string, unknown>).connection as Record<string, unknown>).state).toBe('CONNECTED');
    expect((afterIOS.body.device as Record<string, unknown>).sessionRevision).toBe((beforeIOS.body.device as Record<string, unknown>).sessionRevision);
    expect(daemon.events.since(0).some(event => event.type === 'DEVICE_DISCOVERED')).toBe(true);
    expect(daemon.events.since(0).some(event => event.type === 'DEVICE_CONFIGURED' && event.deviceId === 'device-01')).toBe(true);
    expect(daemon.events.since(0).some(event => event.type === 'DEVICE_CONNECTED' && event.deviceId === 'device-01')).toBe(true);
  });

  it('requires configuration before connecting a discovered device', async () => {
    const { baseUrl } = await start();
    const result = await json(baseUrl, '/api/devices/device-03/connect', postBody({
      commandId: 'connect-before-config-1', timestamp: Date.now(), deviceId: 'device-03',
    }));
    expect(result.response.status).toBe(409);
  });

  it('validates commands and enforces URL/device target agreement', async () => {
    const { baseUrl } = await start();
    const invalid = await json(baseUrl, '/api/tasks/batch', postBody({ goal: 'missing command metadata' }));
    const mismatch = await json(baseUrl, '/api/devices/device-01/pause', postBody({ commandId: 'mismatch-1', timestamp: Date.now(), deviceId: 'device-02' }));
    const actionMismatch = await json(baseUrl, '/api/devices/device-01/input-text', postBody({ commandId: 'mismatch-input-1', timestamp: Date.now(), deviceId: 'device-02', text: 'secret' }));

    expect(invalid.response.status).toBe(400);
    expect(mismatch.response.status).toBe(400);
    expect(actionMismatch.response.status).toBe(400);
  });

  it('rejects unknown batch targets instead of silently dropping them', async () => {
    const { baseUrl } = await start();
    const result = await json(baseUrl, '/api/tasks/batch', postBody({ commandId: 'unknown-target-1', timestamp: Date.now(), targetDeviceIds: ['device-01', 'missing-device'], goal: 'Validate target' }));
    expect(result.response.status).toBe(404);
    expect(result.body.error).toContain('missing-device');
  });

  it('makes repeated batch command IDs idempotent and rejects conflicting reuse', async () => {
    const { baseUrl } = await start();
    const command = { commandId: 'batch-idempotency-1', timestamp: Date.now(), targetDeviceIds: ['device-09'], goal: 'Inspect home screen', priority: 1 };
    const first = await json(baseUrl, '/api/tasks/batch', postBody(command));
    const second = await json(baseUrl, '/api/tasks/batch', postBody(command));
    const conflict = await json(baseUrl, '/api/tasks/batch', postBody({ ...command, goal: 'Different goal' }));

    expect(first.response.status).toBe(202);
    expect(second.response.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(conflict.response.status).toBe(409);
    expect((first.body.tasks as unknown[])).toHaveLength(1);
  });

  it('keeps an offline batch target as a resumable DEVICE_OFFLINE instance', async () => {
    const { baseUrl } = await start();
    await json(baseUrl, '/api/devices/device-14/recover', postBody({ commandId: 'recover-before-offline-task', timestamp: Date.now(), deviceId: 'device-14' }));
    await json(baseUrl, '/api/devices/device-14/disconnect', postBody({ commandId: 'offline-before-task', timestamp: Date.now(), deviceId: 'device-14' }));
    const result = await json(baseUrl, '/api/tasks/batch', postBody({ commandId: 'offline-task-1', timestamp: Date.now(), targetDeviceIds: ['device-14'], goal: 'Wait for recovery' }));
    expect(result.response.status).toBe(202);
    expect((result.body.tasks as Array<Record<string, unknown>>)[0].status).toBe('DEVICE_OFFLINE');
  });

  it('keeps AI worker usage at eight and expands a batch into independent task instances', async () => {
    const { baseUrl } = await start();
    const targetDeviceIds = Array.from({ length: 32 }, (_, index) => `device-${String(index + 1).padStart(2, '0')}`);
    const result = await json(baseUrl, '/api/tasks/batch', postBody({ commandId: 'batch-scale-1', timestamp: Date.now(), targetDeviceIds, goal: 'Check dashboard' }));
    const runtime = await json(baseUrl, '/api/runtime');
    const tasks = result.body.tasks as Array<Record<string, unknown>>;
    const config = runtime.body.config as Record<string, unknown>;
    const workers = runtime.body.workers as Record<string, unknown>;

    expect(result.response.status).toBe(202);
    expect(new Set(tasks.map(task => task.id)).size).toBe(tasks.length);
    expect(config.maxConcurrentAI).toBe(8);
    expect(config.maxConcurrentVLM).toBe(4);
    expect(workers.active).toBeLessThanOrEqual(8);
  });

  it('replays ordered events from a sequence and keeps the event sequence monotonic', async () => {
    const { baseUrl, daemon } = await start();
    const before = daemon.events.latest();
    await json(baseUrl, '/api/tasks/batch', postBody({ commandId: 'event-replay-1', timestamp: Date.now(), targetDeviceIds: ['device-09'], goal: 'Open target app' }));
    const replay = daemon.events.since(before);
    const sequences = replay.map(event => event.sequence);
    const stream = await fetch(`${baseUrl}/api/events?since=${before}`);
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('SSE response has no body');
    const firstChunk = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(firstChunk.value);

    expect(sequences.length).toBeGreaterThan(0);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(text).toContain('Open target app');
    expect(replay.some(event => event.type === 'TASK_CREATED')).toBe(true);
  });

  it('isolates disconnect, recovery, explicit resume, and human control per device', async () => {
    const { baseUrl } = await start();
    await json(baseUrl, '/api/tasks/batch', postBody({ commandId: 'isolation-1', timestamp: Date.now(), targetDeviceIds: ['device-09'], goal: 'Recoverable task' }));
    const offline = await json(baseUrl, '/api/devices/device-09/disconnect', postBody({ commandId: 'disconnect-1', timestamp: Date.now(), deviceId: 'device-09' }));
    const recovered = await json(baseUrl, '/api/devices/device-09/recover', postBody({ commandId: 'recover-1', timestamp: Date.now(), deviceId: 'device-09' }));
    const detail = await json(baseUrl, '/api/devices/device-09');
    const sibling = await json(baseUrl, '/api/devices/device-10');
    const takeover = await json(baseUrl, '/api/devices/device-10/take-control', postBody({ commandId: 'takeover-1', timestamp: Date.now(), deviceId: 'device-10' }));

    expect(offline.response.status).toBe(200);
    expect((offline.body.device as Record<string, unknown>).status).toBe('OFFLINE');
    expect(recovered.response.status).toBe(200);
    expect((detail.body.device as Record<string, unknown>).agentStatus).toBe('PAUSED');
    const resumed = await json(baseUrl, '/api/devices/device-09/resume', postBody({ commandId: 'resume-1', timestamp: Date.now(), deviceId: 'device-09' }));
    expect((sibling.body.device as Record<string, unknown>).status).toBe('ONLINE');
    expect((takeover.body.device as Record<string, unknown>).agentStatus).toBe('HUMAN_CONTROL');
    expect(resumed.response.status).toBe(200);
    expect((resumed.body.device as Record<string, unknown>).agentStatus).toBe('WAITING');
  });

  it('accepts fullscreen tap commands only for the explicit human-controlled device target', async () => {
    const { baseUrl } = await start();
    const forbidden = await json(baseUrl, '/api/devices/device-10/tap', postBody({
      commandId: 'tap-without-control',
      timestamp: Date.now(),
      deviceId: 'device-10',
      point: { x: 0.5, y: 0.5 },
      source: 'FULLSCREEN_PREVIEW',
    }));
    await json(baseUrl, '/api/devices/device-10/take-control', postBody({ commandId: 'takeover-tap-1', timestamp: Date.now(), deviceId: 'device-10' }));
    const accepted = await json(baseUrl, '/api/devices/device-10/tap', postBody({
      commandId: 'tap-with-control',
      timestamp: Date.now(),
      deviceId: 'device-10',
      point: { x: 0.5, y: 0.5 },
      source: 'FULLSCREEN_PREVIEW',
    }));
    const conflict = await json(baseUrl, '/api/devices/device-10/tap', postBody({
      commandId: 'tap-with-control',
      timestamp: Date.now(),
      deviceId: 'device-10',
      point: { x: 0.2, y: 0.2 },
      source: 'FULLSCREEN_PREVIEW',
    }));

    expect(forbidden.response.status).toBe(500);
    expect(accepted.response.status).toBe(200);
    expect(conflict.response.status).toBe(409);
  });

  it('exposes UI hierarchy only through the selected-device route and keeps input text redacted', async () => {
    const { baseUrl } = await start();
    await json(baseUrl, '/api/devices/device-01/take-control', postBody({ commandId: 'takeover-manual-1', timestamp: Date.now(), deviceId: 'device-01' }));
    const input = await json(baseUrl, '/api/devices/device-01/input-text', postBody({ commandId: 'input-secret-1', timestamp: Date.now(), deviceId: 'device-01', text: 'secret password' }));
    const uiTree = await json(baseUrl, '/api/devices/device-01/ui-tree');
    const runtime = await json(baseUrl, '/api/runtime');
    const detail = await json(baseUrl, '/api/devices/device-01');
    const sibling = await json(baseUrl, '/api/devices/device-02');
    const summary = (runtime.body.devices as Array<Record<string, unknown>>).find(device => device.id === 'device-01') as Record<string, unknown>;
    const history = ((detail.body.device as Record<string, unknown>).actionHistory as Array<Record<string, string>>).map(entry => entry.message).join('\n');
    const siblingHistory = ((sibling.body.device as Record<string, unknown>).actionHistory as Array<Record<string, string>>).map(entry => entry.message).join('\n');

    expect(input.response.status).toBe(200);
    expect(uiTree.response.status).toBe(200);
    expect((uiTree.body.uiTree as Record<string, unknown>).nodes).toEqual([]);
    expect(summary).not.toHaveProperty('uiTree');
    expect(history).toContain('action=input_text');
    expect(history).toContain('redactedLength=15');
    expect(history).not.toContain('secret password');
    expect(siblingHistory).not.toContain('input_text');
  });

  it('returns redacted driver diagnostics for failed manual Android actions', async () => {
    const { baseUrl, daemon } = await start();
    const driver = daemon.drivers.get('device-01') as { inputText: (text: string) => Promise<void> };
    driver.inputText = async () => {
      throw new NativeToolError('ADB command failed for device-01 (serial-01)', 'adb -s serial-01 shell input text secret%spassword', 'input text secret password rejected');
    };

    await json(baseUrl, '/api/devices/device-01/take-control', postBody({ commandId: 'takeover-failed-input-1', timestamp: Date.now(), deviceId: 'device-01' }));
    const result = await json(baseUrl, '/api/devices/device-01/input-text', postBody({ commandId: 'failed-input-secret-1', timestamp: Date.now(), deviceId: 'device-01', text: 'secret password' }));
    const detail = await json(baseUrl, '/api/devices/device-01');
    const history = ((detail.body.device as Record<string, unknown>).actionHistory as Array<Record<string, string>>).map(entry => entry.message).join('\n');

    expect(result.response.status).toBe(500);
    expect(result.body.error).toContain('ADB command failed for device-01 (serial-01)');
    expect(result.body.error).toContain('command=adb -s serial-01 shell input text [REDACTED_TEXT]');
    expect(result.body.error).toContain('stderr=input text [REDACTED_TEXT]');
    expect(result.body.error).not.toContain('secret password');
    expect(history).toContain('result=ERROR');
    expect(history).not.toContain('secret password');
  });

  it('stops the selected app only after human takeover and keeps command retries idempotent', async () => {
    const { baseUrl } = await start();
    const forbidden = await json(baseUrl, '/api/devices/device-01/stop-app', postBody({
      commandId: 'stop-app-without-control',
      timestamp: Date.now(),
      deviceId: 'device-01',
      appId: 'com.example.app',
    }));
    await json(baseUrl, '/api/devices/device-01/take-control', postBody({ commandId: 'takeover-stop-app-1', timestamp: Date.now(), deviceId: 'device-01' }));
    const command = { commandId: 'stop-app-idempotent-1', timestamp: Date.now(), deviceId: 'device-01', appId: 'com.example.app' };
    const first = await json(baseUrl, '/api/devices/device-01/stop-app', postBody(command));
    const second = await json(baseUrl, '/api/devices/device-01/stop-app', postBody(command));
    const detail = await json(baseUrl, '/api/devices/device-01');
    const sibling = await json(baseUrl, '/api/devices/device-02');
    const history = ((detail.body.device as Record<string, unknown>).actionHistory as Array<Record<string, string>>).map(entry => entry.message).join('\n');
    const siblingHistory = ((sibling.body.device as Record<string, unknown>).actionHistory as Array<Record<string, string>>).map(entry => entry.message).join('\n');

    expect(forbidden.response.status).toBe(500);
    expect(first.response.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(history).toContain('action=stop_app target=app=com.example.app');
    expect(siblingHistory).not.toContain('stop_app');
  });
});

async function startStubWda(): Promise<{ server: Server; baseUrl: string; requests: Array<{ url: string; method: string }> }> {
  const requests: Array<{ url: string; method: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? '/', method: request.method ?? 'GET' });
    if (request.method === 'GET' && request.url === '/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value: { ready: true } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/session') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value: { sessionId: `session-${requests.length}` }, sessionId: `session-${requests.length}` }));
      return;
    }
    if (request.method === 'DELETE' && /^\/session\/[^/]+$/.test(request.url ?? '')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value: null }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'unknown command' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('WDA stub did not expose a TCP address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function unavailableLocalUrl(): Promise<string> {
  const server = createServer((_, response) => response.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Temporary server did not expose a TCP address');
  await closeServer(server);
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
