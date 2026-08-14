import type { AgentStatus, DeviceConfiguration, DeviceConnectionState, DeviceSession, DeviceStatus, HealthState, Platform, TaskInstance } from './types';
import { StreamManager } from './streamManager';

const apps = ['Omni Market', 'Messages', 'Settings', 'Field Ops', 'Maps', 'Account Hub'];
const models = ['Pixel 9 Pro', 'Galaxy S25', 'iPhone 16 Pro', 'Pixel 8a', 'iPhone 15'];

export class DeviceManager {
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly streamManager = new StreamManager();

  constructor(count = 32) {
    for (let index = 0; index < count; index += 1) {
      const id = `device-${String(index + 1).padStart(2, '0')}`;
      const platform: Platform = index % 4 === 2 ? 'IOS' : 'ANDROID';
      const status: DeviceStatus = index === 13 || index === 27 ? 'OFFLINE' : index === 21 ? 'ERROR' : 'ONLINE';
      const health: HealthState = status === 'OFFLINE' ? 'OFFLINE' : status === 'ERROR' || index === 9 ? 'DEGRADED' : 'HEALTHY';
      const agentStatus: AgentStatus = status !== 'ONLINE' ? 'ERROR' : index < 8 ? 'RUNNING' : index === 18 || index === 19 ? 'HUMAN_CONTROL' : 'IDLE';
      const task = agentStatus === 'RUNNING' ? this.makeInitialTask(id, index) : null;
      const stream = this.streamManager.getProfile('PREVIEW', 32);
      this.sessions.set(id, {
        id,
        name: `${platform === 'IOS' ? 'iPhone' : 'Android'} ${String(index + 1).padStart(2, '0')}`,
        platform,
        model: models[index % models.length],
        status,
        agentStatus,
        health,
        healthState: { state: health, lastCheckAt: Date.now(), adbConnected: status === 'ONLINE', screenResponsive: status === 'ONLINE', appAlive: status === 'ONLINE', agentAlive: status === 'ONLINE' },
        agentSession: { id: `agent-${id}`, deviceId: id, status: agentStatus, workerId: index < 8 ? `worker-${index + 1}` : null, lastScreenshotAt: task ? Date.now() : null },
        deviceDriver: { deviceId: id, platform, transport: platform === 'ANDROID' ? 'ADB' : 'XCUITEST', connected: status === 'ONLINE' },
        configuration: null,
        connection: { state: status === 'ONLINE' ? 'CONNECTED' : 'DISCONNECTED', lastAttemptAt: null, connectedAt: status === 'ONLINE' ? Date.now() : null, error: null },
        screenStream: { deviceId: id, profile: stream, transport: platform === 'ANDROID' ? 'SCRCPY' : 'IOS_MIRROR', aiCaptureMode: 'SCREENSHOT_DRIVEN' },
        agentRuntime: { deviceId: id, sessionId: `runtime-${id}`, persistentWorker: false, analyzeVideo: false },
        currentApp: status === 'OFFLINE' ? 'Unavailable' : apps[index % apps.length],
        groupIds: [platform.toLowerCase(), index < 16 ? 'group-a' : 'group-b', `region-${index % 3 + 1}`],
        metrics: {
          fps: status === 'OFFLINE' ? 0 : index < 8 ? 10 : 5,
          latency: status === 'OFFLINE' ? 0 : 38 + (index * 13) % 96,
          cpu: status === 'OFFLINE' ? 0 : 18 + (index * 7) % 58,
          memory: status === 'OFFLINE' ? 0 : 31 + (index * 5) % 47,
          battery: 24 + (index * 11) % 73,
          temperature: status === 'OFFLINE' ? 0 : 28 + (index * 3) % 14,
          network: status === 'OFFLINE' ? 'OFFLINE' : index % 5 === 0 ? '5G' : 'WIFI',
        },
        stream,
        currentTask: task,
        taskQueue: [],
        taskHistory: [],
        taskContext: task ? { step: 2, lastObservation: 'Home screen loaded', variables: {} } : { variables: {} },
        actionHistory: this.seedHistory(index, task),
        memory: { accountSlot: index + 1, locale: index % 3 === 0 ? 'en-US' : 'zh-CN' },
        screenshotSeed: index % 8,
        sessionRevision: 1,
      });
    }
  }

  getAll(): DeviceSession[] { return Array.from(this.sessions.values()); }
  get(id: string): DeviceSession | undefined { return this.sessions.get(id); }
  count(): number { return this.sessions.size; }

  configure(id: string, configuration: DeviceConfiguration): DeviceSession | undefined {
    return this.update(id, session => ({
      ...session,
      name: configuration.name,
      currentApp: configuration.appId,
      configuration,
      deviceDriver: configuration.driverMode === 'SIMULATED'
        ? session.deviceDriver
        : { ...session.deviceDriver, connected: false },
      connection: configuration.driverMode === 'SIMULATED'
        ? session.connection
        : { ...session.connection, state: 'DISCONNECTED', connectedAt: null, error: null },
    }));
  }

  clearConfiguration(id: string): DeviceSession | undefined {
    const slot = Number(id.replace('device-', ''));
    return this.update(id, session => ({
      ...session,
      name: `${session.platform === 'IOS' ? 'iPhone' : 'Android'} ${String(Number.isFinite(slot) ? slot : id.slice(-2)).padStart(2, '0')}`,
      configuration: null,
      deviceDriver: { ...session.deviceDriver, connected: false },
      connection: { state: 'DISCONNECTED', lastAttemptAt: null, connectedAt: null, error: null },
    }));
  }

  setConnectionState(id: string, state: DeviceConnectionState, error: string | null = null): void {
    this.update(id, session => ({
      ...session,
      connection: {
        ...session.connection,
        state,
        lastAttemptAt: state === 'CONNECTING' || state === 'FAILED' ? Date.now() : session.connection.lastAttemptAt,
        connectedAt: state === 'CONNECTED' ? Date.now() : session.connection.connectedAt,
        error,
      },
    }));
  }

  update(id: string, updater: (session: DeviceSession) => DeviceSession): DeviceSession | undefined {
    const current = this.sessions.get(id);
    if (!current) return undefined;
    const next = updater(current);
    if (next !== current) Object.assign(current, next);
    return current;
  }

  setOffline(id: string): void {
    this.update(id, session => ({
      ...session,
      status: 'OFFLINE',
      health: 'OFFLINE',
      healthState: { ...session.healthState, state: 'OFFLINE', lastCheckAt: Date.now(), adbConnected: false, screenResponsive: false, appAlive: false },
      deviceDriver: { ...session.deviceDriver, connected: false },
      connection: { ...session.connection, state: 'DISCONNECTED', error: 'Device connection lost' },
      agentStatus: 'ERROR',
      agentSession: { ...session.agentSession, status: 'ERROR', workerId: null },
      metrics: { ...session.metrics, fps: 0, network: 'OFFLINE' },
      currentTask: session.currentTask ? this.markTaskOffline(session.currentTask) : null,
    }));
  }

  private markTaskOffline(task: TaskInstance): TaskInstance {
    task.status = 'DEVICE_OFFLINE';
    task.updatedAt = Date.now();
    return task;
  }

  recover(id: string): void {
    this.update(id, session => ({
      ...session,
      status: 'ONLINE',
      health: 'HEALTHY',
      healthState: { state: 'HEALTHY', lastCheckAt: Date.now(), adbConnected: true, screenResponsive: true, appAlive: true, agentAlive: true },
      deviceDriver: { ...session.deviceDriver, connected: true },
      connection: { ...session.connection, state: 'CONNECTED', connectedAt: Date.now(), error: null },
      agentStatus: session.currentTask?.status === 'DEVICE_OFFLINE' ? 'PAUSED' : 'IDLE',
      agentSession: { ...session.agentSession, status: session.currentTask?.status === 'DEVICE_OFFLINE' ? 'PAUSED' : 'IDLE' },
      metrics: { ...session.metrics, fps: 5, network: 'WIFI' },
    }));
  }

  private makeInitialTask(deviceId: string, index: number): TaskInstance {
    const now = Date.now();
    return { id: `seed-task-${index}`, deviceId, goal: 'Verify account dashboard', status: 'RUNNING', priority: 1, attempts: 0, createdAt: now, updatedAt: now, maxSteps: 10, currentStepIndex: 2, completedSteps: 2 };
  }

  private seedHistory(index: number, task: TaskInstance | null) {
    if (!task) return [{ id: `event-${index}-0`, time: '09:41:08', kind: 'SYSTEM' as const, message: 'Agent session ready' }];
    return [
      { id: `event-${index}-1`, time: '09:42:11', kind: 'OBSERVE' as const, message: 'Captured high-resolution screenshot' },
      { id: `event-${index}-2`, time: '09:42:13', kind: 'THINK' as const, message: 'Dashboard is visible; checking account state' },
      { id: `event-${index}-3`, time: '09:42:14', kind: 'ACTION' as const, message: 'Tapped account overview' },
    ];
  }
}
