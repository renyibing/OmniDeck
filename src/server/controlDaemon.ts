import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { WebSocketServer } from 'ws';
import { ControlPlane, DeviceManager, DriverRegistry, PreviewBroadcast, SessionManager, SimulatedDeviceDriver, TaskScheduler } from '../domain';
import { ScrcpyVideoRegistry } from '../domain/scrcpyVideoRegistry';
import { AndroidAdbScrcpyDriver } from '../domain/androidDeviceDriver';
import { DeviceDiscovery } from '../domain/deviceDiscovery';
import { IOSXCUITestDriver } from '../domain/iosXcuitestDriver';
import { IOSWdaDiagnostics } from '../domain/iosWdaDiagnostics';
import { describeDriverError } from '../domain/controlPlane';
import { deriveWdaMjpegUrl } from '../domain/wdaMjpegUrl';
import type { DeviceSession, DriverMode, StreamProfile, TaskInstance, TaskStatus } from '../domain/types';
import { EventStore } from './eventStore';
import { RuntimeStateStore, type PersistedRuntimeState } from './runtimeStateStore';
import {
  batchTaskCommandSchema,
  cloneSnapshot,
  configureDeviceCommandSchema,
  connectDeviceCommandSchema,
  deviceCommandSchema,
  inputTextCommandSchema,
  launchAppCommandSchema,
  longPressCommandSchema,
  protocolVersion,
  screenTapCommandSchema,
  streamPolicyCommandSchema,
  swipeCommandSchema,
  toDeviceDetail,
  toDeviceSummary,
  toRuntimeSnapshot,
  type BatchTaskCommand,
  type DeviceDetailDTO,
  type DeviceSummaryDTO,
  type EventEnvelope,
  type EventType,
  type IOSWdaStatusDTO,
  type RuntimeSnapshot,
} from './protocol';

const concurrency = {
  maxConcurrentAI: 8,
  maxConcurrentVLM: 4,
  maxConcurrentADB: 12,
  maxConcurrentIOS: 4,
  timeoutMs: 90_000,
  maxRetries: 2,
  rateLimitPerMinute: 60,
} as const;

type Connection = { close: () => void };
type CachedCommand = { signature: string; result: Promise<HttpResult> };
type HttpResult = { status: number; payload: unknown };
type TaskState = { deviceId: string; status: TaskStatus };
type AndroidBinding = { deviceId?: string; serial: string };
type IOSBinding = { deviceId?: string; udid: string; wdaUrl: string };
type ResolvedBinding =
  | { deviceId: string; platform: 'ANDROID'; driverMode: 'ANDROID_ADB_SCRCPY'; serial: string }
  | { deviceId: string; platform: 'IOS'; driverMode: 'IOS_XCUITEST'; udid: string; wdaUrl: string };

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ControlDaemonOptions {
  port?: number;
  host?: string;
  deviceCount?: number;
  autoExecute?: boolean;
  driverLatencyMs?: number;
  healthCheckIntervalMs?: number;
  driverMode?: DriverMode;
  androidDriverMode?: DriverMode;
  iosDriverMode?: DriverMode;
  realDevices?: boolean;
  androidSerial?: string;
  iosUdid?: string;
  wdaUrl?: string;
  adbPath?: string;
  scrcpyPath?: string;
  startScrcpyProcess?: boolean;
  androidDevices?: AndroidBinding[];
  iosDevices?: IOSBinding[];
  hostDiscovery?: boolean;
  stateFilePath?: string;
}

export class ControlDaemon {
  readonly devices: DeviceManager;
  readonly sessions: SessionManager;
  readonly scheduler: TaskScheduler;
  readonly drivers: DriverRegistry;
  readonly controlPlane: ControlPlane;
  readonly discovery: DeviceDiscovery;
  readonly wdaDiagnostics: IOSWdaDiagnostics;
  readonly events = new EventStore();
  readonly startedAt = Date.now();
  readonly sessionEpoch = randomUUID();
  readonly previews = new PreviewBroadcast();
  readonly scrcpyVideos: ScrcpyVideoRegistry;

  private readonly connections = new Set<Connection>();
  private readonly commandCache = new Map<string, CachedCommand>();
  private readonly previousDevices = new Map<string, string>();
  private readonly previousTasks = new Map<string, TaskState>();
  private previousWorkers = '';
  private readonly groups: RuntimeSnapshot['groups'];
  private readonly healthTimer: ReturnType<typeof setInterval> | null;
  private readonly driverOptions: Pick<ControlDaemonOptions, 'adbPath' | 'scrcpyPath' | 'startScrcpyProcess' | 'driverLatencyMs'>;
  private readonly desiredConnections = new Set<string>();
  private readonly stateStore: RuntimeStateStore | null;
  private readonly restoredState: PersistedRuntimeState | null;
  private server: Server | null = null;
  private videoSockets: WebSocketServer | null = null;

  constructor(options: ControlDaemonOptions = {}) {
    this.devices = new DeviceManager(options.deviceCount ?? 32);
    const nativeEnabled = options.realDevices === true;
    this.driverOptions = {
      adbPath: options.adbPath,
      scrcpyPath: options.scrcpyPath,
      startScrcpyProcess: options.startScrcpyProcess,
      driverLatencyMs: options.driverLatencyMs,
    };
    this.stateStore = options.stateFilePath ? new RuntimeStateStore(options.stateFilePath) : null;
    this.restoredState = this.stateStore?.load() ?? null;
    this.restoredState?.devices.filter(device => device.autoConnect).forEach(device => this.desiredConnections.add(device.deviceId));
    const configuredAndroidDevices = options.androidDevices?.length ? options.androidDevices : options.androidSerial ? [{ serial: options.androidSerial }] : [];
    const configuredIOSDevices = options.iosDevices?.length ? options.iosDevices : options.iosUdid && options.wdaUrl ? [{ udid: options.iosUdid, wdaUrl: options.wdaUrl }] : [];
    const androidDriverMode = nativeEnabled
      ? options.androidDriverMode ?? (options.driverMode === 'ANDROID_ADB_SCRCPY' ? options.driverMode : configuredAndroidDevices.length ? 'ANDROID_ADB_SCRCPY' : 'SIMULATED')
      : 'SIMULATED';
    const iosDriverMode = nativeEnabled
      ? options.iosDriverMode ?? (options.driverMode === 'IOS_XCUITEST' ? options.driverMode : configuredIOSDevices.length ? 'IOS_XCUITEST' : 'SIMULATED')
      : 'SIMULATED';
    if (androidDriverMode === 'ANDROID_ADB_SCRCPY' && !configuredAndroidDevices.length) throw new Error('ANDROID_ADB_SCRCPY requires at least one explicit androidSerial');
    if (iosDriverMode === 'IOS_XCUITEST' && !configuredIOSDevices.length) throw new Error('IOS_XCUITEST requires at least one explicit iosUdid and wdaUrl');
    const bindings = nativeEnabled ? resolveBindings(this.devices, configuredAndroidDevices, configuredIOSDevices, androidDriverMode, iosDriverMode) : [];
    this.discovery = new DeviceDiscovery(this.devices, bindings.length
      ? {
        nativeCandidates: bindings.map(binding => ({
          deviceId: binding.deviceId,
          platform: binding.platform,
          identifier: binding.platform === 'ANDROID' ? binding.serial : binding.udid,
          driverMode: binding.driverMode,
          simulated: false,
        })),
        adbPath: options.adbPath,
        hostDiscovery: options.hostDiscovery,
      }
      : {
        androidDriverMode,
        iosDriverMode,
        androidIdentifier: options.androidSerial,
        iosIdentifier: options.iosUdid,
        hostDiscovery: options.hostDiscovery,
        adbPath: options.adbPath,
      });
    this.sessions = new SessionManager(this.devices);
    this.scheduler = new TaskScheduler(concurrency);
    this.drivers = new DriverRegistry();
    this.scrcpyVideos = new ScrcpyVideoRegistry({ adbPath: options.adbPath, scrcpyPath: options.scrcpyPath });
    this.wdaDiagnostics = new IOSWdaDiagnostics();
    this.devices.getAll().forEach(device => {
      const binding = bindings.find(candidate => candidate.deviceId === device.id);
      if (binding?.driverMode === 'ANDROID_ADB_SCRCPY') {
        this.drivers.register(new AndroidAdbScrcpyDriver(device.id, {
          serial: binding.serial,
          adbPath: options.adbPath,
          scrcpyPath: options.scrcpyPath,
          streamProcessEnabled: options.startScrcpyProcess ?? false,
        }));
      } else if (binding?.driverMode === 'IOS_XCUITEST') {
        this.drivers.register(new IOSXCUITestDriver(device.id, { udid: binding.udid, wdaUrl: binding.wdaUrl }));
      } else {
        this.drivers.register(new SimulatedDeviceDriver(device, options.driverLatencyMs ?? 20));
      }
    });
    this.groups = this.makeGroups(this.devices.getAll());
    this.controlPlane = new ControlPlane(this.devices, this.scheduler, this.drivers, { autoExecute: options.autoExecute ?? true });
    this.restorePersistedConfigurations();
    this.captureBaseline();
    this.controlPlane.subscribe(() => this.publishChanges());
    this.events.append('DEVICE_ADDED', { payload: { count: this.devices.count(), sessionEpoch: this.sessionEpoch } });
    const healthCheckIntervalMs = options.healthCheckIntervalMs ?? 10_000;
    this.healthTimer = healthCheckIntervalMs > 0
      ? setInterval(() => { void this.controlPlane.checkAllHealth(); }, healthCheckIntervalMs)
      : null;
    if (this.healthTimer && 'unref' in this.healthTimer) this.healthTimer.unref();
  }

  snapshot(): RuntimeSnapshot {
    return toRuntimeSnapshot({
      devices: this.devices.getAll().map(toDeviceSummary),
      workers: this.scheduler.workers.snapshot(),
      resources: this.scheduler.resources.snapshot(),
      config: this.scheduler.config,
      groups: this.groups,
      startedAt: this.startedAt,
      sessionEpoch: this.sessionEpoch,
      latestSequence: this.events.latest(),
    });
  }

  deviceSummary(deviceId: string): DeviceSummaryDTO | undefined {
    const device = this.devices.get(deviceId);
    return device ? toDeviceSummary(device) : undefined;
  }

  deviceDetail(deviceId: string): DeviceDetailDTO | undefined {
    const device = this.devices.get(deviceId);
    return device ? toDeviceDetail(device) : undefined;
  }

  async listen(options: ControlDaemonOptions = {}): Promise<Server> {
    if (this.server) return this.server;
    this.server = createServer((request, response) => { void this.handle(request, response); });
    this.videoSockets = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (request, socket, head) => {
      const host = request.headers.host ?? 'localhost';
      const url = new URL(request.url ?? '/', `http://${host}`);
      const match = url.pathname.match(/^\/api\/devices\/([^/]+)\/video$/);
      if (!match) {
        socket.destroy();
        return;
      }
      this.videoSockets!.handleUpgrade(request, socket, head, ws => {
        const deviceId = this.decodeId(match[1]!);
        void this.attachVideoClient(deviceId, ws);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject).listen(options.port ?? 4317, options.host ?? '127.0.0.1', () => resolve());
    });
    await this.restoreDesiredConnections();
    return this.server;
  }

  async close(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.connections.forEach(connection => connection.close());
    this.connections.clear();
    this.previews.stopAll();
    this.videoSockets?.close();
    this.videoSockets = null;
    await this.scrcpyVideos.stopAll();
    await this.drivers.disconnectAll();
    if (this.server) {
      await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
      this.server = null;
    }
  }

  async executeBatch(command: BatchTaskCommand): Promise<TaskInstance[]> {
    const missing = command.targetDeviceIds.filter(deviceId => !this.devices.get(deviceId));
    if (missing.length) throw new HttpError(404, `Device not found: ${missing.join(', ')}`);
    return this.controlPlane.submitBatch(command.goal, command.targetDeviceIds, command.priority).map(cloneSnapshot);
  }

  async executeDeviceAction(action: string, deviceId: string, appId?: string): Promise<void> {
    switch (action) {
      case 'pause': this.controlPlane.pauseDevice(deviceId); break;
      case 'resume': this.controlPlane.resumeDevice(deviceId); break;
      case 'stop': this.controlPlane.stopDevice(deviceId); break;
      case 'retry': this.controlPlane.retryDevice(deviceId); break;
      case 'take-control': this.controlPlane.takeHumanControl(deviceId); break;
      case 'release-control': this.controlPlane.releaseHumanControl(deviceId); break;
      case 'disconnect':
        this.previews.stop(deviceId);
        await this.scrcpyVideos.stop(deviceId);
        await this.controlPlane.setOffline(deviceId);
        this.desiredConnections.delete(deviceId);
        this.persistRuntimeState();
        break;
      case 'recover':
        await this.controlPlane.recover(deviceId);
        if (this.devices.get(deviceId)?.configuration?.driverMode === 'ANDROID_ADB_SCRCPY') {
          await this.startAndroidVideo(deviceId);
        } else {
          this.startPreview(deviceId);
        }
        this.desiredConnections.add(deviceId);
        this.persistRuntimeState();
        break;
      case 'restart-app': await this.controlPlane.restartApp(deviceId); break;
      case 'launch-app': await this.controlPlane.launchApp(deviceId, appId); break;
      case 'stop-app': await this.controlPlane.stopAppDevice(deviceId, appId); break;
      default: throw new HttpError(404, `Unsupported device action: ${action}`);
    }
  }

  async executeScreenTap(deviceId: string, point: { x: number; y: number }, source: 'LIVE_PREVIEW' | 'FULLSCREEN_PREVIEW'): Promise<void> {
    await this.controlPlane.tapDevice(deviceId, point, source);
  }

  async executeManualInput(action: string, deviceId: string, command: unknown): Promise<void> {
    switch (action) {
      case 'swipe': {
        const parsed = swipeCommandSchema.parse(command);
        await this.controlPlane.swipeDevice(deviceId, { from: parsed.from, to: parsed.to, durationMs: parsed.durationMs }, parsed.source);
        break;
      }
      case 'long-press': {
        const parsed = longPressCommandSchema.parse(command);
        await this.controlPlane.longPressDevice(deviceId, { point: parsed.point, durationMs: parsed.durationMs }, parsed.source);
        break;
      }
      case 'input-text': {
        const parsed = inputTextCommandSchema.parse(command);
        await this.controlPlane.inputTextDevice(deviceId, parsed.text, parsed.source);
        break;
      }
      case 'back': await this.controlPlane.backDevice(deviceId); break;
      case 'home': await this.controlPlane.homeDevice(deviceId); break;
      default: throw new HttpError(404, `Unsupported manual action: ${action}`);
    }
  }

  discoverDevices() {
    throw new Error('discoverDevices must be awaited');
  }

  async discoverDevicesAsync() {
    const candidates = await this.discovery.discover();
    candidates.forEach(candidate => this.events.append('DEVICE_DISCOVERED', {
      deviceId: candidate.deviceId,
      payload: { candidate: cloneSnapshot(candidate) },
    }));
    return candidates;
  }

  configureDevice(configuration: Omit<Parameters<DeviceManager['configure']>[1], 'configuredAt'>): DeviceSummaryDTO {
    const candidate = this.discovery.getByDeviceId(configuration.deviceId);
    const session = this.devices.get(configuration.deviceId);
    if (!candidate || !session) throw new HttpError(404, 'Device candidate not found');
    if (candidate.platform !== configuration.platform || candidate.transport !== configuration.transport || candidate.driverMode !== configuration.driverMode) {
      throw new HttpError(400, 'Device platform, transport, and driver mode must match the discovered candidate');
    }
    if (candidate.identifier !== configuration.identifier) {
      throw new HttpError(400, 'Device identifier does not match the discovered candidate');
    }
    const updated = this.devices.configure(configuration.deviceId, { ...configuration, configuredAt: Date.now() });
    if (!updated) throw new HttpError(404, 'Device not found');
    const summary = toDeviceSummary(updated);
    this.persistRuntimeState();
    this.events.append('DEVICE_CONFIGURED', { deviceId: updated.id, payload: { snapshot: summary } });
    this.publishChanges();
    return summary;
  }

  async connectDevice(deviceId: string): Promise<DeviceSummaryDTO> {
    const session = this.devices.get(deviceId);
    if (!session) throw new HttpError(404, 'Device not found');
    if (!session.configuration) throw new HttpError(409, 'Configure the device before connecting');
    if (session.configuration.platform === 'IOS' && session.configuration.driverMode === 'IOS_XCUITEST') {
      const readiness = await this.wdaStatus(deviceId);
      if (!isWdaConnectable(readiness)) {
        const message = formatWdaReadinessBlocker(readiness);
        this.devices.setConnectionState(deviceId, 'FAILED', message);
        this.events.append('DEVICE_CONNECTION_FAILED', { deviceId, payload: { error: message, wdaStatus: readiness } });
        this.publishChanges();
        throw new HttpError(503, message);
      }
    }
    await this.ensureDriver(deviceId, session.configuration);
    this.devices.setConnectionState(deviceId, 'CONNECTING');
    this.events.append('DEVICE_CONNECTING', { deviceId, payload: { platform: session.platform } });
    this.publishChanges();
    try {
      await this.drivers.get(deviceId).connect();
      this.devices.recover(deviceId);
      const connected = this.devices.get(deviceId)!;
      await this.drivers.applyStreamProfile(deviceId, connected.stream);
      if (session.configuration.driverMode === 'ANDROID_ADB_SCRCPY') {
        await this.startAndroidVideo(deviceId);
      } else {
        this.startPreview(deviceId);
      }
      this.events.append('DEVICE_CONNECTED', { deviceId, payload: { snapshot: toDeviceSummary(connected) } });
      this.desiredConnections.add(deviceId);
      this.persistRuntimeState();
      this.publishChanges();
      return toDeviceSummary(connected);
    } catch (error) {
      this.previews.stop(deviceId);
      await this.scrcpyVideos.stop(deviceId);
      const message = error instanceof Error ? error.message : 'Device connection failed';
      this.devices.setConnectionState(deviceId, 'FAILED', message);
      this.events.append('DEVICE_CONNECTION_FAILED', { deviceId, payload: { error: message } });
      this.publishChanges();
      throw new HttpError(503, message);
    }
  }

  async wdaStatus(deviceId: string): Promise<IOSWdaStatusDTO> {
    const session = this.devices.get(deviceId);
    if (!session) throw new HttpError(404, 'Device not found');
    if (session.platform !== 'IOS') throw new HttpError(400, 'WDA status is available only for iOS devices');
    const candidate = this.discovery.getByDeviceId(deviceId);
    const configuration = session.configuration;
    return this.wdaDiagnostics.diagnose({
      deviceId,
      udid: configuration?.identifier ?? candidate?.identifier ?? null,
      wdaUrl: configuration?.wdaUrl ?? candidate?.suggestedWdaUrl ?? null,
      configured: Boolean(configuration),
      detected: Boolean(candidate),
      sessionConnected: session.connection.state === 'CONNECTED',
      previousError: session.connection.error,
      wdaBundleId: configuration?.wdaBundleId ?? null,
    });
  }

  applyStreamPolicy(command: { layout: 1 | 4 | 8 | 9 | 16 | 25 | 32; focusedId: string | null; fullscreenId: string | null; visibleDeviceIds: string[] }): void {
    this.sessions.applyStreamPolicy(command.layout, command.focusedId, command.fullscreenId, command.visibleDeviceIds);
    this.devices.getAll().forEach(device => {
      if (!device.configuration || device.configuration.driverMode === 'SIMULATED' || device.connection.state !== 'CONNECTED') return;
      this.previews.setFps(device.id, this.previewCaptureFps(device));
      void this.syncAndroidVideo(device.id).catch(error => {
        const message = error instanceof Error ? error.message : 'Video stream update failed';
        this.events.append('DEVICE_CONNECTION_FAILED', { deviceId: device.id, payload: { error: message } });
      });
      void this.drivers.applyStreamProfile(device.id, device.stream).catch(error => {
        const message = error instanceof Error ? error.message : 'Stream profile update failed';
        this.previews.stop(device.id);
        this.devices.setConnectionState(device.id, 'FAILED', message);
        this.events.append('DEVICE_CONNECTION_FAILED', { deviceId: device.id, payload: { error: message } });
        this.publishChanges();
      });
    });
    this.publishChanges();
  }

  private startPreview(deviceId: string): void {
    const session = this.devices.get(deviceId);
    if (!session?.configuration || session.configuration.driverMode === 'SIMULATED') return;
    // Android tiles use scrcpy H.264; adb screencap MJPEG is fallback-only (very slow).
    if (session.configuration.driverMode === 'ANDROID_ADB_SCRCPY') return;
    this.previews.ensure(deviceId, this.previewCaptureFps(session), () => this.drivers.monitorFrame(deviceId));
  }

  private ensurePreviewFallback(deviceId: string): void {
    const session = this.devices.get(deviceId);
    if (!session?.configuration || session.configuration.driverMode !== 'ANDROID_ADB_SCRCPY') return;
    this.previews.ensure(deviceId, this.previewCaptureFps(session), () => this.drivers.monitorFrame(deviceId));
  }

  private androidVideoProfile(session: DeviceSession): StreamProfile {
    const maxSide = Math.max(session.stream.width, session.stream.height);
    return {
      ...session.stream,
      fps: Math.max(15, Math.min(60, session.stream.fps || 15)),
      bitrateKbps: Math.max(2_000, session.stream.bitrateKbps || 2_000),
      width: Math.min(session.stream.width, maxSide),
      height: Math.min(session.stream.height, maxSide),
    };
  }

  private previewCaptureFps(session: { stream: { fps: number }; configuration?: { driverMode?: string } | null }): number {
    if (session.configuration?.driverMode === 'SIMULATED') return session.stream.fps;
    return Math.max(6, session.stream.fps);
  }

  private async startAndroidVideo(deviceId: string): Promise<void> {
    const session = this.devices.get(deviceId);
    if (!session?.configuration || session.configuration.driverMode !== 'ANDROID_ADB_SCRCPY') return;
    if (session.connection.state !== 'CONNECTED') return;
    await this.scrcpyVideos.ensure(deviceId, session.configuration.identifier, this.androidVideoProfile(session));
  }

  private async syncAndroidVideo(deviceId: string): Promise<void> {
    const session = this.devices.get(deviceId);
    if (!session?.configuration || session.configuration.driverMode !== 'ANDROID_ADB_SCRCPY') return;
    if (session.connection.state !== 'CONNECTED') return;
    await this.scrcpyVideos.applyProfile(deviceId, session.configuration.identifier, this.androidVideoProfile(session));
  }

  private attachVideoClient(deviceId: string, socket: import('ws').WebSocket): void {
    const session = this.devices.get(deviceId);
    if (!session?.configuration || session.configuration.driverMode !== 'ANDROID_ADB_SCRCPY' || session.connection.state !== 'CONNECTED') {
      socket.close(4409, 'Live video is not connected');
      return;
    }
    void this.startAndroidVideo(deviceId).then(() => {
      this.scrcpyVideos.attachClient(deviceId, socket);
    }).catch(error => {
      const message = error instanceof Error ? error.message : 'Unable to start scrcpy video';
      socket.close(1011, message);
    });
  }

  private async proxyIosMjpeg(wdaUrl: string | undefined, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const mjpegUrl = deriveWdaMjpegUrl(wdaUrl);
    if (!mjpegUrl) return false;
    const upstreamAbort = new AbortController();
    request.once('close', () => upstreamAbort.abort());
    try {
      const upstream = await fetch(mjpegUrl, { signal: upstreamAbort.signal });
      if (!upstream.ok || !upstream.body) return false;
      const contentType = upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=BoundaryLine';
      response.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Connection: 'close',
        'Access-Control-Allow-Origin': '*',
      });
      const reader = upstream.body.getReader();
      request.once('close', () => { void reader.cancel().catch(() => undefined); });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!response.write(Buffer.from(value))) {
          await new Promise<void>(resolve => response.once('drain', resolve));
        }
      }
      if (!response.writableEnded) response.end();
      return true;
    } catch {
      return false;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'content-type, last-event-id, x-omnideck-client');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/devices') {
        return this.json(response, { version: protocolVersion, devices: this.devices.getAll().map(toDeviceSummary) });
      }
      if (request.method === 'GET' && url.pathname === '/api/devices/discovery') {
        return this.json(response, { version: protocolVersion, devices: await this.discoverDevicesAsync() });
      }
      if (request.method === 'GET' && url.pathname === '/api/runtime') return this.json(response, this.snapshot());
      if (request.method === 'GET' && url.pathname === '/api/events') {
        const headerSequence = Number(request.headers['last-event-id'] ?? 0);
        const querySequence = Number(url.searchParams.get('since') ?? 0);
        return this.sse(request, response, Number.isFinite(querySequence) ? Math.max(headerSequence, querySequence) : headerSequence);
      }

      const wdaStatusPath = url.pathname.match(/^\/api\/devices\/([^/]+)\/wda-status$/);
      if (request.method === 'GET' && wdaStatusPath) {
        return this.json(response, { version: protocolVersion, wdaStatus: await this.wdaStatus(this.decodeId(wdaStatusPath[1])) });
      }

      const uiTreePath = url.pathname.match(/^\/api\/devices\/([^/]+)\/ui-tree$/);
      if (request.method === 'GET' && uiTreePath) {
        const deviceId = this.decodeId(uiTreePath[1]);
        if (!this.devices.get(deviceId)) throw new HttpError(404, 'Device not found');
        const uiTree = await this.controlPlane.getUiHierarchy(deviceId);
        return this.json(response, { version: protocolVersion, deviceId, uiTree });
      }

      const framePath = url.pathname.match(/^\/api\/devices\/([^/]+)\/frame$/);
      if (request.method === 'GET' && framePath) {
        const deviceId = this.decodeId(framePath[1]);
        const session = this.devices.get(deviceId);
        if (!session) throw new HttpError(404, 'Device not found');
        if (!session.configuration || session.configuration.driverMode === 'SIMULATED' || session.connection.state !== 'CONNECTED') {
          throw new HttpError(409, 'Live preview is not connected');
        }
        if (session.configuration.driverMode === 'ANDROID_ADB_SCRCPY') {
          this.ensurePreviewFallback(deviceId);
        } else {
          this.startPreview(deviceId);
        }
        const frame = this.previews.getLatest(deviceId) ?? await this.previews.waitForFrame(deviceId);
        response.writeHead(200, {
          'Content-Type': frame.contentType,
          'Content-Length': frame.data.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-OmniDeck-Captured-At': String(frame.capturedAt),
          'Access-Control-Allow-Origin': '*',
        });
        response.end(frame.data);
        return;
      }

      const mjpegPath = url.pathname.match(/^\/api\/devices\/([^/]+)\/mjpeg$/);
      if (request.method === 'GET' && mjpegPath) {
        const deviceId = this.decodeId(mjpegPath[1]);
        const session = this.devices.get(deviceId);
        if (!session) throw new HttpError(404, 'Device not found');
        if (!session.configuration || session.configuration.driverMode === 'SIMULATED' || session.connection.state !== 'CONNECTED') {
          throw new HttpError(409, 'Live preview is not connected');
        }
        if (session.configuration.driverMode === 'IOS_XCUITEST') {
          const proxied = await this.proxyIosMjpeg(session.configuration.wdaUrl, request, response);
          if (proxied) return;
          this.startPreview(deviceId);
        } else if (session.configuration.driverMode === 'ANDROID_ADB_SCRCPY') {
          this.ensurePreviewFallback(deviceId);
        } else {
          this.startPreview(deviceId);
        }
        const controller = new AbortController();
        request.on('close', () => controller.abort());
        await this.previews.attachMjpeg(deviceId, response, controller.signal);
        if (!response.writableEnded) response.end();
        return;
      }

      const detail = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
      if (request.method === 'GET' && detail) {
        const device = this.deviceDetail(this.decodeId(detail[1]));
        if (!device) throw new HttpError(404, 'Device not found');
        return this.json(response, { version: protocolVersion, device });
      }

      if (request.method === 'POST' && url.pathname === '/api/tasks/batch') {
        const command = batchTaskCommandSchema.parse(await this.body(request));
        const result = await this.idempotent(command.commandId, command, async () => ({
          status: 202,
          payload: { version: protocolVersion, commandId: command.commandId, tasks: await this.executeBatch(command) },
        }));
        return this.json(response, result.payload, result.status);
      }

      if (request.method === 'POST' && url.pathname === '/api/devices/configure') {
        const command = configureDeviceCommandSchema.parse(await this.body(request));
        const result = await this.idempotent(command.commandId, command, async () => ({
          status: 200,
          payload: { version: protocolVersion, commandId: command.commandId, device: this.configureDevice(command.configuration) },
        }));
        return this.json(response, result.payload, result.status);
      }

      const connectPath = url.pathname.match(/^\/api\/devices\/([^/]+)\/connect$/);
      if (request.method === 'POST' && connectPath) {
        const deviceId = this.decodeId(connectPath[1]);
        const command = connectDeviceCommandSchema.parse(await this.body(request));
        if (command.deviceId !== deviceId) throw new HttpError(400, 'deviceId does not match URL');
        const result = await this.idempotent(command.commandId, command, async () => ({
          status: 200,
          payload: { version: protocolVersion, commandId: command.commandId, device: await this.connectDevice(deviceId) },
        }));
        return this.json(response, result.payload, result.status);
      }

      const commandPath = url.pathname.match(/^\/api\/devices\/([^/]+)\/(pause|resume|stop|retry|take-control|release-control|disconnect|recover|restart-app|launch-app|stop-app)$/);
      if (request.method === 'POST' && commandPath) {
        const deviceId = this.decodeId(commandPath[1]);
        const action = commandPath[2];
        const parsed = action === 'launch-app' || action === 'stop-app'
          ? launchAppCommandSchema.parse(await this.body(request))
          : deviceCommandSchema.parse(await this.body(request));
        if (parsed.deviceId !== deviceId) throw new HttpError(400, 'deviceId does not match URL');
        if (!this.devices.get(deviceId)) throw new HttpError(404, 'Device not found');
        const appId = 'appId' in parsed && typeof parsed.appId === 'string' ? parsed.appId : undefined;
        const result = await this.idempotent(parsed.commandId, { action, ...parsed }, async () => {
          await this.executeDeviceAction(action, deviceId, appId);
          return {
            status: 200,
            payload: { version: protocolVersion, commandId: parsed.commandId, device: this.deviceSummary(deviceId) },
          };
        });
        return this.json(response, result.payload, result.status);
      }

      const tapPath = url.pathname.match(/^\/api\/devices\/([^/]+)\/tap$/);
      if (request.method === 'POST' && tapPath) {
        const deviceId = this.decodeId(tapPath[1]);
        const command = screenTapCommandSchema.parse(await this.body(request));
        if (command.deviceId !== deviceId) throw new HttpError(400, 'deviceId does not match URL');
        if (!this.devices.get(deviceId)) throw new HttpError(404, 'Device not found');
        const result = await this.idempotent(command.commandId, command, async () => {
          await this.executeScreenTap(deviceId, command.point, command.source);
          return {
            status: 200,
            payload: { version: protocolVersion, commandId: command.commandId, device: this.deviceSummary(deviceId) },
          };
        });
        return this.json(response, result.payload, result.status);
      }

      const manualPath = url.pathname.match(/^\/api\/devices\/([^/]+)\/(swipe|long-press|input-text|back|home)$/);
      if (request.method === 'POST' && manualPath) {
        const deviceId = this.decodeId(manualPath[1]);
        const action = manualPath[2];
        const rawBody = await this.body(request);
        const command = action === 'swipe'
          ? swipeCommandSchema.parse(rawBody)
          : action === 'long-press'
            ? longPressCommandSchema.parse(rawBody)
            : action === 'input-text'
              ? inputTextCommandSchema.parse(rawBody)
              : deviceCommandSchema.parse(rawBody);
        if (command.deviceId !== deviceId) throw new HttpError(400, 'deviceId does not match URL');
        if (!this.devices.get(deviceId)) throw new HttpError(404, 'Device not found');
        const result = await this.idempotent(command.commandId, { action, ...command }, async () => {
          await this.executeManualInput(action, deviceId, command);
          return {
            status: 200,
            payload: { version: protocolVersion, commandId: command.commandId, device: this.deviceSummary(deviceId) },
          };
        });
        return this.json(response, result.payload, result.status);
      }

      if (request.method === 'POST' && url.pathname === '/api/session/stream-policy') {
        const command = streamPolicyCommandSchema.parse(await this.body(request));
        const missing = command.targetDeviceIds.filter(deviceId => !this.devices.get(deviceId));
        if (missing.length) throw new HttpError(404, `Device not found: ${missing.join(', ')}`);
        const result = await this.idempotent(command.commandId, command, async () => {
          this.applyStreamPolicy(command);
          return { status: 200, payload: { version: protocolVersion, commandId: command.commandId } };
        });
        return this.json(response, result.payload, result.status);
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (response.headersSent || response.writableEnded) return;
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError || error instanceof ZodError ? 400 : 500;
      const message = error instanceof SyntaxError || error instanceof ZodError || error instanceof HttpError
        ? error.message
        : describeDriverError(error);
      return this.json(response, { error: message }, status);
    }
  }

  private sse(request: IncomingMessage, response: ServerResponse, since: number): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 1000\n\n');
    const write = (event: EventEnvelope) => response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    const subscription = this.events.subscribeSince(Math.max(0, since), write);
    subscription.replay.forEach(write);
    const unsubscribe = subscription.unsubscribe;
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    let closed = false;
    let connection: Connection;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.connections.delete(connection);
      if (!response.writableEnded) response.end();
    };
    connection = { close };
    this.connections.add(connection);
    request.once('close', close);
    response.once('close', close);
  }

  private captureBaseline(): void {
    this.devices.getAll().forEach(device => {
      this.previousDevices.set(device.id, JSON.stringify(toDeviceSummary(device)));
      this.collectTasks(device).forEach(task => this.previousTasks.set(task.id, { deviceId: task.deviceId, status: task.status }));
    });
    this.previousWorkers = this.workerSignature();
  }

  private publishChanges(): void {
    this.devices.getAll().forEach(device => {
      const summary = toDeviceSummary(device);
      const serialized = JSON.stringify(summary);
      const previousSerialized = this.previousDevices.get(device.id);
      const previous = previousSerialized ? JSON.parse(previousSerialized) as DeviceSummaryDTO : undefined;

      if (!previous) {
        this.events.append('DEVICE_ADDED', { deviceId: device.id, payload: { snapshot: summary } });
      } else if (previous.status !== summary.status) {
        this.events.append(summary.status === 'OFFLINE' ? 'DEVICE_OFFLINE' : 'DEVICE_RECOVERED', {
          deviceId: device.id,
          payload: { status: summary.status },
        });
      }
      if (previous?.health !== summary.health) {
        this.events.append('HEALTH_UPDATED', { deviceId: device.id, payload: { health: summary.health } });
      }
      if (previous?.agentStatus !== summary.agentStatus) {
        if (summary.agentStatus === 'HUMAN_CONTROL') this.events.append('HUMAN_CONTROL_STARTED', { deviceId: device.id });
        else if (previous?.agentStatus === 'HUMAN_CONTROL') {
          this.events.append('HUMAN_CONTROL_RELEASED', { deviceId: device.id, payload: { status: summary.agentStatus } });
        }
      }
      this.publishTaskChanges(device);
      if (serialized !== previousSerialized) {
        this.events.append('DEVICE_UPDATED', { deviceId: device.id, taskId: summary.currentTask?.id, payload: { snapshot: summary } });
        this.previousDevices.set(device.id, serialized);
      }
    });

    const workers = this.workerSignature();
    if (workers !== this.previousWorkers) {
      this.previousWorkers = workers;
      this.events.append('WORKER_POOL_UPDATED', {
        payload: { workers: this.scheduler.workers.snapshot(), resources: this.scheduler.resources.snapshot() },
      });
    }
  }

  private publishTaskChanges(device: DeviceSession): void {
    this.collectTasks(device).forEach(task => {
      const previous = this.previousTasks.get(task.id);
      if (!previous) this.events.append('TASK_CREATED', { deviceId: task.deviceId, taskId: task.id, payload: { task: cloneSnapshot(task) } });
      if (!previous || previous.status !== task.status) {
        const type = this.eventForTaskStatus(task.status);
        if (type) this.events.append(type, { deviceId: task.deviceId, taskId: task.id, payload: { status: task.status, error: task.error ?? null } });
      }
      this.previousTasks.set(task.id, { deviceId: task.deviceId, status: task.status });
    });
  }

  private collectTasks(device: DeviceSession): TaskInstance[] {
    const tasks = [...device.taskHistory, ...device.taskQueue];
    if (device.currentTask) tasks.push(device.currentTask);
    return Array.from(new Map(tasks.map(task => [task.id, task])).values());
  }

  private eventForTaskStatus(status: TaskStatus): EventType | null {
    if (status === 'WAITING') return 'TASK_QUEUED';
    if (status === 'RUNNING') return 'TASK_STARTED';
    if (status === 'PAUSED' || status === 'DEVICE_OFFLINE') return 'TASK_PAUSED';
    if (status === 'SUCCESS') return 'TASK_COMPLETED';
    if (status === 'FAILED' || status === 'STOPPED') return 'TASK_FAILED';
    return null;
  }

  private workerSignature(): string {
    return JSON.stringify({ workers: this.scheduler.workers.snapshot(), resources: this.scheduler.resources.snapshot() });
  }

  private async idempotent(commandId: string, command: unknown, run: () => Promise<HttpResult>): Promise<HttpResult> {
    const signature = this.commandSignature(command);
    const cached = this.commandCache.get(commandId);
    if (cached) {
      if (cached.signature !== signature) throw new HttpError(409, `commandId ${commandId} was already used for another command`);
      return cached.result;
    }
    const result = run();
    this.commandCache.set(commandId, { signature, result });
    if (this.commandCache.size > 2_000) this.commandCache.delete(this.commandCache.keys().next().value!);
    try { return await result; } catch (error) { this.commandCache.delete(commandId); throw error; }
  }

  private commandSignature(command: unknown): string {
    return createHash('sha256').update(JSON.stringify(command)).digest('hex');
  }

  private decodeId(value: string): string {
    try { return decodeURIComponent(value); } catch { throw new HttpError(400, 'Invalid device ID'); }
  }

  private makeGroups(devices: DeviceSession[]): RuntimeSnapshot['groups'] {
    return [
      { id: 'all', name: 'All devices', deviceIds: devices.map(device => device.id), preferredLayout: 32 },
      { id: 'android', name: 'Android', deviceIds: devices.filter(device => device.platform === 'ANDROID').map(device => device.id), preferredLayout: 25 },
      { id: 'ios', name: 'iPhone', deviceIds: devices.filter(device => device.platform === 'IOS').map(device => device.id), preferredLayout: 8 },
      { id: 'group-a', name: 'Test Group A', deviceIds: devices.slice(0, 16).map(device => device.id), preferredLayout: 16 },
      { id: 'group-b', name: 'Account Group B', deviceIds: devices.slice(16).map(device => device.id), preferredLayout: 16 },
    ];
  }

  private json(response: ServerResponse, payload: unknown, status = 200): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  }

  private body(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      let rejected = false;
      request.on('data', chunk => {
        if (rejected) return;
        data += chunk;
        if (data.length > 1_000_000) {
          rejected = true;
          reject(new HttpError(413, 'Request body too large'));
          request.destroy();
        }
      });
      request.on('end', () => {
        if (rejected) return;
        try { resolve(data ? JSON.parse(data) : {}); } catch (error) { reject(error); }
      });
      request.on('error', reject);
    });
  }

  private async ensureDriver(deviceId: string, configuration: NonNullable<DeviceSession['configuration']>): Promise<void> {
    const session = this.devices.get(deviceId);
    if (!session) throw new HttpError(404, 'Device not found');
    if (configuration.driverMode === 'SIMULATED') {
      await this.drivers.replace(new SimulatedDeviceDriver(session, this.driverOptions.driverLatencyMs ?? 20));
      return;
    }
    if (configuration.driverMode === 'ANDROID_ADB_SCRCPY') {
      await this.drivers.replace(new AndroidAdbScrcpyDriver(deviceId, {
        serial: configuration.identifier,
        adbPath: this.driverOptions.adbPath,
        scrcpyPath: this.driverOptions.scrcpyPath,
        streamProcessEnabled: this.driverOptions.startScrcpyProcess ?? false,
      }));
      return;
    }
    if (!configuration.wdaUrl) throw new HttpError(400, 'iOS XCUITest requires a WDA URL');
    await this.drivers.replace(new IOSXCUITestDriver(deviceId, {
      udid: configuration.identifier,
      wdaUrl: configuration.wdaUrl,
    }));
  }

  private restorePersistedConfigurations(): void {
    this.restoredState?.devices.forEach(({ deviceId, configuration }) => {
      const session = this.devices.get(deviceId);
      if (!session || session.platform !== configuration.platform) return;
      this.devices.configure(deviceId, configuration);
    });
  }

  private async restoreDesiredConnections(): Promise<void> {
    if (!this.desiredConnections.size) return;
    await Promise.allSettled(
      Array.from(this.desiredConnections)
        .filter(deviceId => Boolean(this.devices.get(deviceId)?.configuration))
        .map(async deviceId => {
          try {
            await this.connectDevice(deviceId);
          } catch {
            // Preserve explicit reconnect intent even if the current restore attempt fails.
          }
        }),
    );
  }

  private persistRuntimeState(): void {
    if (!this.stateStore) return;
    this.stateStore.save(this.devices.getAll()
      .filter(device => device.configuration)
      .map(device => ({
        deviceId: device.id,
        configuration: cloneSnapshot(device.configuration!),
        autoConnect: this.desiredConnections.has(device.id),
      })));
  }
}

function resolveBindings(
  devices: DeviceManager,
  androidDevices: AndroidBinding[],
  iosDevices: IOSBinding[],
  androidDriverMode: DriverMode,
  iosDriverMode: DriverMode,
): ResolvedBinding[] {
  const claimed = new Set<string>();
  const bindings: ResolvedBinding[] = [];

  if (androidDriverMode === 'ANDROID_ADB_SCRCPY') {
    androidDevices.forEach(device => {
      bindings.push({
        deviceId: resolveDeviceId(devices, 'ANDROID', device.deviceId, claimed),
        platform: 'ANDROID',
        driverMode: 'ANDROID_ADB_SCRCPY',
        serial: device.serial,
      });
    });
  }

  if (iosDriverMode === 'IOS_XCUITEST') {
    iosDevices.forEach(device => {
      bindings.push({
        deviceId: resolveDeviceId(devices, 'IOS', device.deviceId, claimed),
        platform: 'IOS',
        driverMode: 'IOS_XCUITEST',
        udid: device.udid,
        wdaUrl: device.wdaUrl,
      });
    });
  }

  return bindings;
}

function resolveDeviceId(devices: DeviceManager, platform: DeviceSession['platform'], requestedId: string | undefined, claimed: Set<string>): string {
  if (requestedId) {
    const session = devices.get(requestedId);
    if (!session) throw new Error(`Device slot ${requestedId} does not exist`);
    if (session.platform !== platform) throw new Error(`Device slot ${requestedId} is not a ${platform} slot`);
    if (claimed.has(requestedId)) throw new Error(`Device slot ${requestedId} is already bound`);
    claimed.add(requestedId);
    return requestedId;
  }
  const next = devices.getAll().find(session => session.platform === platform && !claimed.has(session.id));
  if (!next) throw new Error(`No available ${platform} device slot remains for native binding`);
  claimed.add(next.id);
  return next.id;
}

function isWdaConnectable(status: IOSWdaStatusDTO): boolean {
  return status.state === 'WDA_READY' || status.state === 'SESSION_CONNECTED';
}

function formatWdaReadinessBlocker(status: IOSWdaStatusDTO): string {
  const detail = status.lastError ?? status.nextAction;
  return `${status.state}: ${detail}`;
}
