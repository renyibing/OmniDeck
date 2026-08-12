import { DeviceManager } from './deviceManager';
import type { DeviceDriverAdapter } from './deviceDriver';
import { DriverRegistry } from './deviceDriver';
import { StreamManager } from './streamManager';
import { TaskScheduler } from './taskScheduler';
import type { DeviceSession, Platform, TaskInstance, TaskStatus, TimelineEvent } from './types';
import type { ResourceKind } from './workerPool';

type ControlPlaneListener = () => void;

export interface ControlPlaneOptions {
  autoExecute?: boolean;
}

export class ControlPlane {
  private readonly tasks = new Map<string, TaskInstance>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<ControlPlaneListener>();
  private readonly streamManager = new StreamManager();
  private readonly autoExecute: boolean;

  constructor(
    readonly devices: DeviceManager,
    readonly scheduler: TaskScheduler,
    readonly drivers: DriverRegistry,
    options: ControlPlaneOptions = {},
  ) {
    this.autoExecute = options.autoExecute ?? true;
    devices.getAll().forEach(session => {
      if (!session.currentTask) return;
      this.tasks.set(session.currentTask.id, session.currentTask);
      if (session.currentTask.status === 'RUNNING') {
        scheduler.workers.enqueue(session.currentTask);
        this.start(session.currentTask);
      }
    });
  }

  subscribe(listener: ControlPlaneListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submitBatch(goal: string, deviceIds: string[], priority = 1): TaskInstance[] {
    const eligible = deviceIds.filter(deviceId => this.devices.get(deviceId)?.status === 'ONLINE');
    const tasks = this.scheduler.createInstances(goal, eligible, priority);
    tasks.forEach(task => {
      this.tasks.set(task.id, task);
      const session = this.devices.get(task.deviceId)!;
      if (this.isDeviceBusy(session)) {
        session.taskQueue.push(task);
        this.record(session, 'SYSTEM', 'Task queued behind the device’s current task');
      } else {
        session.currentTask = this.scheduler.workers.enqueue(task);
        this.syncTaskState(session, session.currentTask);
        if (session.currentTask.status === 'RUNNING') this.start(session.currentTask);
      }
    });
    this.emit();
    return tasks;
  }

  async completeTask(taskId: string, status: Extract<TaskStatus, 'SUCCESS' | 'FAILED'> = 'SUCCESS', error?: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (['SUCCESS', 'FAILED', 'STOPPED'].includes(task.status)) return;
    task.status = status;
    task.error = error;
    task.finishedAt = Date.now();
    task.updatedAt = task.finishedAt;
    const session = this.devices.get(task.deviceId);
    if (session?.currentTask?.id === task.id) {
      session.taskHistory.push(task);
      session.currentTask = null;
      session.taskContext = { variables: {} };
      session.agentStatus = 'IDLE';
      session.agentSession.status = 'IDLE';
      session.agentSession.workerId = null;
      this.record(session, 'SYSTEM', status === 'SUCCESS' ? 'Task completed' : `Task failed: ${error ?? 'Unknown error'}`);
    }
    const promoted = this.scheduler.workers.finish(task.id);
    if (promoted) this.activate(promoted);
    this.drainDeviceQueues();
    this.emit();
  }

  pauseDevice(deviceId: string): void {
    const session = this.devices.get(deviceId);
    const task = session?.currentTask;
    if (!session || !task || (task.status !== 'RUNNING' && task.status !== 'WAITING')) return;
    this.abort(task.id, 'Task paused');
    const promoted = this.scheduler.workers.release(task.id);
    this.scheduler.workers.cancel(task.id);
    task.status = 'PAUSED';
    task.updatedAt = Date.now();
    session.agentStatus = 'PAUSED';
    session.agentSession.status = 'PAUSED';
    session.agentSession.workerId = null;
    this.record(session, 'SYSTEM', 'Task paused');
    if (promoted) this.activate(promoted);
    this.drainDeviceQueues();
    this.emit();
  }

  resumeDevice(deviceId: string): void {
    const session = this.devices.get(deviceId);
    const task = session?.currentTask;
    if (!session || !task || (task.status !== 'PAUSED' && task.status !== 'DEVICE_OFFLINE') || session.status !== 'ONLINE') return;
    const resumed = this.scheduler.workers.enqueue(task);
    this.syncTaskState(session, resumed);
    this.record(session, 'SYSTEM', resumed.status === 'RUNNING' ? 'Task resumed' : 'Task waiting for AI worker');
    if (resumed.status === 'RUNNING') this.start(resumed);
    this.emit();
  }

  stopDevice(deviceId: string): void {
    const session = this.devices.get(deviceId);
    const task = session?.currentTask;
    if (!session || !task) return;
    this.abort(task.id, 'Task stopped');
    const promoted = this.scheduler.workers.release(task.id);
    this.scheduler.workers.cancel(task.id);
    task.status = 'STOPPED';
    task.finishedAt = Date.now();
    task.updatedAt = task.finishedAt;
    session.taskHistory.push(task);
    session.currentTask = null;
    session.agentStatus = 'IDLE';
    session.agentSession.status = 'IDLE';
    session.agentSession.workerId = null;
    this.record(session, 'SYSTEM', 'Task stopped');
    if (promoted) this.activate(promoted);
    this.drainDeviceQueues();
    this.emit();
  }

  retryDevice(deviceId: string): void {
    const session = this.devices.get(deviceId);
    if (!session || session.currentTask || session.status !== 'ONLINE') return;
    let index = -1;
    for (let cursor = session.taskHistory.length - 1; cursor >= 0; cursor -= 1) {
      if (session.taskHistory[cursor].status === 'FAILED') { index = cursor; break; }
    }
    if (index < 0) return;
    const task = session.taskHistory[index];
    const retried = this.scheduler.workers.retry(task);
    if (retried.status === 'FAILED') return;
    session.taskHistory.splice(index, 1);
    session.currentTask = retried;
    this.syncTaskState(session, retried);
    this.record(session, 'SYSTEM', retried.status === 'RUNNING' ? 'Task retry started' : 'Task retry queued');
    if (retried.status === 'RUNNING') this.start(retried);
    this.emit();
  }

  async restartApp(deviceId: string): Promise<void> {
    await this.runDriverCommand(deviceId, driver => driver.restartApp(this.devices.get(deviceId)?.currentApp ?? ''));
    const session = this.devices.get(deviceId);
    if (session) this.record(session, 'ACTION', `Restarted ${session.currentApp}`);
    this.emit();
  }

  async launchApp(deviceId: string, appId = 'Omni Market'): Promise<void> {
    await this.runDriverCommand(deviceId, driver => driver.launchApp(appId));
    const session = this.devices.get(deviceId);
    if (session) {
      session.currentApp = appId;
      this.record(session, 'ACTION', `Launched ${appId}`);
    }
    this.emit();
  }

  takeHumanControl(deviceId: string): void {
    const session = this.devices.get(deviceId);
    if (!session || session.status !== 'ONLINE') return;
    if (session.currentTask) {
      this.abort(session.currentTask.id, 'Human takeover');
      const promoted = this.scheduler.workers.release(session.currentTask.id);
      this.scheduler.workers.cancel(session.currentTask.id);
      session.currentTask.status = 'PAUSED';
      if (promoted) this.activate(promoted);
    }
    session.agentStatus = 'HUMAN_CONTROL';
    session.agentSession.status = 'HUMAN_CONTROL';
    session.agentSession.workerId = null;
    this.record(session, 'SYSTEM', 'Human control started');
    this.emit();
  }

  async setOffline(deviceId: string): Promise<void> {
    const session = this.devices.get(deviceId);
    if (!session) return;
    if (session.currentTask) {
      this.abort(session.currentTask.id, 'Device offline');
      const promoted = this.scheduler.workers.release(session.currentTask.id);
      this.scheduler.workers.cancel(session.currentTask.id);
      if (promoted) this.activate(promoted);
    }
    this.devices.setOffline(deviceId);
    this.record(session, 'SYSTEM', 'Device connection lost; task preserved for resume');
    this.emit();
    await this.drivers.get(deviceId).disconnect();
  }

  async recover(deviceId: string): Promise<void> {
    const driver = this.drivers.get(deviceId);
    await driver.connect();
    this.devices.recover(deviceId);
    const session = this.devices.get(deviceId);
    if (session) this.record(session, 'SYSTEM', 'Device recovered; interrupted task is paused');
    this.emit();
  }

  async checkHealth(deviceId: string): Promise<void> {
    const session = this.devices.get(deviceId);
    if (!session) return;
    const health = await this.drivers.get(deviceId).health();
    session.healthState = health;
    session.health = health.state;
    if (health.state === 'OFFLINE' && session.status !== 'OFFLINE') await this.setOffline(deviceId);
    this.emit();
  }

  async checkAllHealth(): Promise<void> {
    await Promise.allSettled(this.devices.getAll().map(session => this.checkHealth(session.id)));
  }

  private isDeviceBusy(session: DeviceSession): boolean {
    return session.currentTask !== null && !['SUCCESS', 'FAILED', 'STOPPED'].includes(session.currentTask.status);
  }

  private activate(task: TaskInstance): void {
    const session = this.devices.get(task.deviceId);
    if (!session) return;
    if (this.isDeviceBusy(session) && session.currentTask?.id !== task.id) {
      session.taskQueue.push(task);
      return;
    }
    session.currentTask = task;
    this.syncTaskState(session, task);
    this.start(task);
  }

  private enqueueNextDeviceTask(session: DeviceSession): void {
    if (session.currentTask || session.status !== 'ONLINE') return;
    const next = session.taskQueue.shift();
    if (!next) return;
    if (!this.scheduler.workers.isActive(next.id)) {
      const activated = this.scheduler.workers.enqueue(next);
      if (activated.status !== 'RUNNING') {
        session.currentTask = activated;
        this.syncTaskState(session, activated);
        return;
      }
    }
    session.currentTask = next;
    this.syncTaskState(session, next);
    if (next.status === 'RUNNING') this.start(next);
  }

  private drainDeviceQueues(): void {
    this.devices.getAll().forEach(session => this.enqueueNextDeviceTask(session));
  }

  private syncTaskState(session: DeviceSession, task: TaskInstance): void {
    session.agentStatus = task.status === 'RUNNING' ? 'RUNNING' : 'WAITING';
    session.agentSession.status = session.agentStatus;
    session.agentSession.workerId = task.status === 'RUNNING' ? `worker:${task.id}` : null;
    session.taskContext = { goal: task.goal, step: 0, variables: {} };
  }

  private start(task: TaskInstance): void {
    if (!this.autoExecute || this.controllers.has(task.id)) return;
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    void this.execute(task, controller);
  }

  private async execute(task: TaskInstance, controller: AbortController): Promise<void> {
    const session = this.devices.get(task.deviceId);
    if (!session) return;
    const timeout = setTimeout(() => controller.abort(new Error('Task timeout')), this.scheduler.config.timeoutMs);
    const platformResource = this.platformResource(session.platform);
    let ai = false;
    let vlm = false;
    let platform = false;
    try {
      if (!this.scheduler.rateLimiter.tryAcquire()) throw new Error('AI rate limit exceeded');
      await this.scheduler.resources.acquireWait('AI', controller.signal);
      ai = true;
      await this.scheduler.resources.acquireWait('VLM', controller.signal);
      vlm = true;
      await this.scheduler.resources.acquireWait(platformResource, controller.signal);
      platform = true;
      const driver = this.drivers.get(task.deviceId);
      const capture = this.streamManager.requestAIScreenshot();
      await driver.screenshot({ purpose: 'AI', width: capture.width, height: capture.height }, controller.signal);
      this.record(session, 'OBSERVE', 'Captured high-resolution AI screenshot');
      session.taskContext.step = 1;
      await driver.performGoalStep(task.goal, controller.signal);
      this.record(session, 'ACTION', 'Executed a device-scoped goal step');
      session.taskContext.step = 2;
      await driver.screenshot({ purpose: 'AI', width: capture.width, height: capture.height }, controller.signal);
      await this.completeTask(task.id, 'SUCCESS');
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      const timedOut = reason instanceof Error && reason.message === 'Task timeout';
      if (!controller.signal.aborted || timedOut) {
        await this.completeTask(task.id, 'FAILED', reason instanceof Error ? reason.message : 'Unknown error');
      }
    } finally {
      clearTimeout(timeout);
      if (ai) this.scheduler.resources.release('AI');
      if (vlm) this.scheduler.resources.release('VLM');
      if (platform) this.scheduler.resources.release(platformResource);
      if (this.controllers.get(task.id) === controller) {
        this.controllers.delete(task.id);
        if (task.status === 'RUNNING' && session.currentTask?.id === task.id && this.scheduler.workers.isActive(task.id)) {
          this.start(task);
        }
      }
    }
  }

  private async runDriverCommand(deviceId: string, command: (driver: DeviceDriverAdapter) => Promise<void>): Promise<void> {
    const session = this.devices.get(deviceId);
    if (!session || session.status !== 'ONLINE') throw new Error(`Device ${deviceId} is offline`);
    const resource = this.platformResource(session.platform);
    if (!this.scheduler.resources.acquire(resource)) throw new Error(`${resource} concurrency limit reached`);
    try { await command(this.drivers.get(deviceId)); } finally { this.scheduler.resources.release(resource); }
  }

  private platformResource(platform: Platform): ResourceKind { return platform === 'ANDROID' ? 'ADB' : 'IOS'; }

  private abort(taskId: string, reason: string): void {
    this.controllers.get(taskId)?.abort(new Error(reason));
  }

  private record(session: DeviceSession, kind: TimelineEvent['kind'], message: string): void {
    session.actionHistory.push({ id: `${session.id}-${Date.now()}-${session.actionHistory.length}`, time: new Date().toLocaleTimeString([], { hour12: false }), kind, message });
    if (session.actionHistory.length > 100) session.actionHistory.splice(0, session.actionHistory.length - 100);
  }

  private emit(): void { this.listeners.forEach(listener => listener()); }
}
