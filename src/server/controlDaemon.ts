import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { ControlPlane, DeviceManager, DriverRegistry, SessionManager, SimulatedDeviceDriver, TaskScheduler } from '../domain';
import type { DeviceSession, TaskInstance, TaskStatus } from '../domain/types';
import { EventStore } from './eventStore';
import {
  batchTaskCommandSchema,
  cloneSnapshot,
  deviceCommandSchema,
  launchAppCommandSchema,
  protocolVersion,
  streamPolicyCommandSchema,
  toDeviceDetail,
  toDeviceSummary,
  toRuntimeSnapshot,
  type BatchTaskCommand,
  type DeviceDetailDTO,
  type DeviceSummaryDTO,
  type EventEnvelope,
  type EventType,
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
}

export class ControlDaemon {
  readonly devices: DeviceManager;
  readonly sessions: SessionManager;
  readonly scheduler: TaskScheduler;
  readonly drivers: DriverRegistry;
  readonly controlPlane: ControlPlane;
  readonly events = new EventStore();
  readonly startedAt = Date.now();
  readonly sessionEpoch = randomUUID();

  private readonly connections = new Set<Connection>();
  private readonly commandCache = new Map<string, CachedCommand>();
  private readonly previousDevices = new Map<string, string>();
  private readonly previousTasks = new Map<string, TaskState>();
  private previousWorkers = '';
  private readonly groups: RuntimeSnapshot['groups'];
  private readonly healthTimer: ReturnType<typeof setInterval> | null;
  private server: Server | null = null;

  constructor(options: ControlDaemonOptions = {}) {
    this.devices = new DeviceManager(options.deviceCount ?? 32);
    this.sessions = new SessionManager(this.devices);
    this.scheduler = new TaskScheduler(concurrency);
    this.drivers = new DriverRegistry();
    this.devices.getAll().forEach(device => this.drivers.register(new SimulatedDeviceDriver(device, options.driverLatencyMs ?? 20)));
    this.groups = this.makeGroups(this.devices.getAll());
    this.controlPlane = new ControlPlane(this.devices, this.scheduler, this.drivers, { autoExecute: options.autoExecute ?? true });
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
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject).listen(options.port ?? 4317, options.host ?? '127.0.0.1', () => resolve());
    });
    return this.server;
  }

  async close(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.connections.forEach(connection => connection.close());
    this.connections.clear();
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    this.server = null;
  }

  async executeBatch(command: BatchTaskCommand): Promise<TaskInstance[]> {
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
      case 'disconnect': await this.controlPlane.setOffline(deviceId); break;
      case 'recover': await this.controlPlane.recover(deviceId); break;
      case 'restart-app': await this.controlPlane.restartApp(deviceId); break;
      case 'launch-app': await this.controlPlane.launchApp(deviceId, appId); break;
      default: throw new HttpError(404, `Unsupported device action: ${action}`);
    }
  }

  applyStreamPolicy(command: { layout: 1 | 4 | 8 | 9 | 16 | 25 | 32; focusedId: string | null; fullscreenId: string | null; visibleDeviceIds: string[] }): void {
    this.sessions.applyStreamPolicy(command.layout, command.focusedId, command.fullscreenId, command.visibleDeviceIds);
    this.publishChanges();
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
      if (request.method === 'GET' && url.pathname === '/api/runtime') return this.json(response, this.snapshot());
      if (request.method === 'GET' && url.pathname === '/api/events') {
        const headerSequence = Number(request.headers['last-event-id'] ?? 0);
        const querySequence = Number(url.searchParams.get('since') ?? 0);
        return this.sse(request, response, Number.isFinite(querySequence) ? Math.max(headerSequence, querySequence) : headerSequence);
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

      const commandPath = url.pathname.match(/^\/api\/devices\/([^/]+)\/(pause|resume|stop|retry|take-control|release-control|disconnect|recover|restart-app|launch-app)$/);
      if (request.method === 'POST' && commandPath) {
        const deviceId = this.decodeId(commandPath[1]);
        const action = commandPath[2];
        const parsed = action === 'launch-app'
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

      if (request.method === 'POST' && url.pathname === '/api/session/stream-policy') {
        const command = streamPolicyCommandSchema.parse(await this.body(request));
        const result = await this.idempotent(command.commandId, command, async () => {
          this.applyStreamPolicy(command);
          return { status: 200, payload: { version: protocolVersion, commandId: command.commandId } };
        });
        return this.json(response, result.payload, result.status);
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError || error instanceof ZodError ? 400 : 500;
      const message = error instanceof Error ? error.message : 'Invalid request';
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
    this.events.since(Math.max(0, since)).forEach(write);
    const unsubscribe = this.events.subscribe(write);
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
    const signature = JSON.stringify(command);
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
}
