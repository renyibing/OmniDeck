import { DeviceManager } from './deviceManager';
import type { DeviceDriverAdapter, DevicePressKey, LongPressRequest, NormalizedPoint, ScrollWheelRequest, SwipeRequest } from './deviceDriver';
import { DriverRegistry } from './deviceDriver';
import { StreamManager } from './streamManager';
import { TaskScheduler } from './taskScheduler';
import type { DeviceSession, Platform, TaskInstance, TaskStatus, TimelineEvent } from './types';
import type { UiHierarchy } from './androidUiHierarchy';
import type { ResourceKind } from './workerPool';

type ControlPlaneListener = () => void;

export interface ControlPlaneOptions {
  autoExecute?: boolean;
}

export class ControlPlane {
  private readonly tasks = new Map<string, TaskInstance>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly deviceControllers = new Map<string, Set<AbortController>>();
  private readonly manualActionChains = new Map<string, Promise<void>>();
  private readonly listeners = new Set<ControlPlaneListener>();
  private readonly streamManager = new StreamManager();
  private readonly autoExecute: boolean;
  private static readonly MANUAL_COMMAND_TIMEOUT_MS = 20_000;

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
    const targets = deviceIds.filter(deviceId => this.devices.get(deviceId));
    const tasks = this.scheduler.createInstances(goal, targets, priority);
    tasks.forEach(task => {
      this.tasks.set(task.id, task);
      const session = this.devices.get(task.deviceId)!;
      if (session.status !== 'ONLINE') {
        task.status = 'DEVICE_OFFLINE';
        task.updatedAt = Date.now();
        session.currentTask = task;
        session.agentStatus = 'ERROR';
        session.agentSession.status = 'ERROR';
        this.record(session, 'SYSTEM', 'Task created while device is offline; resume after recovery');
        return;
      }
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
    await this.runDriverCommand(deviceId, (driver, signal) => driver.restartApp(this.devices.get(deviceId)?.currentApp ?? '', signal));
    const session = this.devices.get(deviceId);
    if (session) this.record(session, 'ACTION', `Restarted ${session.currentApp}`);
    this.emit();
  }

  async launchApp(deviceId: string, appId = 'Omni Market'): Promise<void> {
    await this.runDriverCommand(deviceId, (driver, signal) => driver.launchApp(appId, signal));
    const session = this.devices.get(deviceId);
    if (session) {
      session.currentApp = appId;
      this.record(session, 'ACTION', `Launched ${appId}`);
    }
    this.emit();
  }

  async tapDevice(deviceId: string, point: NormalizedPoint, source: 'LIVE_PREVIEW' | 'FULLSCREEN_PREVIEW' = 'LIVE_PREVIEW'): Promise<void> {
    await this.runManualAction(deviceId, 'tap', `x=${percent(point.x)} y=${percent(point.y)}`, source, (driver, signal) => driver.tap(point, signal));
  }

  async swipeDevice(deviceId: string, request: SwipeRequest, source = 'INSPECTOR'): Promise<void> {
    await this.runManualAction(deviceId, 'swipe', `from=${percent(request.from.x)},${percent(request.from.y)} to=${percent(request.to.x)},${percent(request.to.y)} durationMs=${request.durationMs ?? 350}`, source, (driver, signal) => driver.swipe(request, signal));
  }

  async scrollWheelDevice(deviceId: string, request: ScrollWheelRequest, source = 'LIVE_PREVIEW'): Promise<void> {
    await this.runManualAction(
      deviceId,
      'scroll_wheel',
      `x=${percent(request.point.x)} y=${percent(request.point.y)} deltaX=${Math.round(request.deltaX)} deltaY=${Math.round(request.deltaY)}`,
      source,
      async (driver, signal) => {
        if (driver.scrollWheel) {
          await driver.scrollWheel(request, signal);
          return;
        }
        const dominant = Math.abs(request.deltaX) > Math.abs(request.deltaY);
        const magnitude = Math.min(0.32, Math.max(0.07, (Math.abs(dominant ? request.deltaX : request.deltaY) / 120) * 0.11));
        const from = request.point;
        const to = dominant
          ? { x: clampPercent(from.x + Math.sign(request.deltaX) * magnitude), y: from.y }
          : { x: from.x, y: clampPercent(from.y + Math.sign(-request.deltaY) * magnitude) };
        const distance = Math.hypot(to.x - from.x, to.y - from.y);
        const durationMs = Math.min(900, Math.max(180, Math.round(180 + distance * 700)));
        await driver.swipe({ from, to, durationMs }, signal);
      },
    );
  }

  async longPressDevice(deviceId: string, request: LongPressRequest, source = 'INSPECTOR'): Promise<void> {
    await this.runManualAction(deviceId, 'long_press', `x=${percent(request.point.x)} y=${percent(request.point.y)} durationMs=${request.durationMs ?? 650}`, source, (driver, signal) => driver.longPress(request, signal));
  }

  async inputTextDevice(deviceId: string, text: string, source = 'INSPECTOR'): Promise<void> {
    await this.runManualAction(deviceId, 'input_text', `redactedLength=${text.length}`, source, (driver, signal) => driver.inputText(text, signal));
  }

  async pressKeyDevice(deviceId: string, key: DevicePressKey, source = 'INSPECTOR'): Promise<void> {
    await this.runManualAction(deviceId, 'press_key', `key=${key}`, source, (driver, signal) => driver.pressKey(key, signal));
  }

  async backDevice(deviceId: string, source = 'INSPECTOR'): Promise<void> {
    await this.runManualAction(deviceId, 'back', 'key=BACK', source, (driver, signal) => driver.back(signal));
  }

  async homeDevice(deviceId: string, source = 'INSPECTOR'): Promise<void> {
    await this.runManualAction(deviceId, 'home', 'key=HOME', source, (driver, signal) => driver.home(signal));
  }

  async stopAppDevice(deviceId: string, appId?: string, source = 'INSPECTOR'): Promise<void> {
    const targetApp = appId ?? this.devices.get(deviceId)?.currentApp ?? '';
    await this.runManualAction(deviceId, 'stop_app', `app=${targetApp}`, source, (driver, signal) => driver.stopApp(targetApp, signal));
  }

  async getUiHierarchy(deviceId: string): Promise<UiHierarchy> {
    const started = Date.now();
    const hierarchy = await this.readDriverData(deviceId, (driver, signal) => driver.getUiHierarchy(signal));
    const session = this.devices.get(deviceId);
    if (session) {
      this.record(session, 'OBSERVE', `Read UI hierarchy nodes=${hierarchy.nodes.length} source=SELECTED_DETAIL durationMs=${Date.now() - started} result=SUCCESS`);
      this.emit();
    }
    return hierarchy;
  }

  takeHumanControl(deviceId: string): void {
    const session = this.devices.get(deviceId);
    if (!session || session.status !== 'ONLINE') return;
    this.abortDeviceCommands(deviceId, 'Human control started');
    this.manualActionChains.delete(deviceId);
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

  releaseHumanControl(deviceId: string): void {
    const session = this.devices.get(deviceId);
    if (!session || session.agentStatus !== 'HUMAN_CONTROL') return;
    this.abortDeviceCommands(deviceId, 'Human control released');
    this.manualActionChains.delete(deviceId);
    session.agentStatus = session.currentTask ? 'PAUSED' : 'IDLE';
    session.agentSession.status = session.agentStatus;
    this.record(session, 'SYSTEM', 'Human control released; agent remains paused');
    this.emit();
  }

  async setOffline(deviceId: string): Promise<void> {
    const session = this.devices.get(deviceId);
    if (!session) return;
    this.abortDeviceCommands(deviceId, 'Device offline');
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
      await this.verifyTaskAction(session, driver, controller.signal);
      await driver.screenshot({ purpose: 'AI', width: capture.width, height: capture.height }, controller.signal);
      this.record(session, 'OBSERVE', 'Captured post-action verification screenshot');
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

  private async runDriverCommand(deviceId: string, command: (driver: DeviceDriverAdapter, signal: AbortSignal) => Promise<void>): Promise<void> {
    await this.enqueueManualDriverCommand(deviceId, command);
  }

  private enqueueManualDriverCommand<T>(
    deviceId: string,
    command: (driver: DeviceDriverAdapter, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const previous = this.manualActionChains.get(deviceId) ?? Promise.resolve();
    const run = previous.then(
      () => this.runManualDriverData(deviceId, command),
      () => this.runManualDriverData(deviceId, command),
    );
    this.manualActionChains.set(deviceId, run.then(() => undefined, () => undefined));
    return run;
  }

  /** Human screen input is serialized per device and does not consume the global IOS/ADB pool. */
  private async runManualDriverData<T>(
    deviceId: string,
    command: (driver: DeviceDriverAdapter, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const session = this.devices.get(deviceId);
    if (!session || session.status !== 'ONLINE') throw new Error(`Device ${deviceId} is offline`);
    const controller = new AbortController();
    const timeoutMs = Math.min(this.scheduler.config.timeoutMs, ControlPlane.MANUAL_COMMAND_TIMEOUT_MS);
    const timeout = setTimeout(() => controller.abort(new Error('Device command timeout')), timeoutMs);
    this.trackDeviceCommand(deviceId, controller);
    try {
      return await command(this.drivers.get(deviceId), controller.signal);
    } finally {
      clearTimeout(timeout);
      this.untrackDeviceCommand(deviceId, controller);
    }
  }

  private async readDriverData<T>(deviceId: string, command: (driver: DeviceDriverAdapter, signal: AbortSignal) => Promise<T>): Promise<T> {
    const session = this.devices.get(deviceId);
    if (!session || session.status !== 'ONLINE') throw new Error(`Device ${deviceId} is offline`);
    const resource = this.platformResource(session.platform);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Device command timeout')), this.scheduler.config.timeoutMs);
    this.trackDeviceCommand(deviceId, controller);
    let acquired = false;
    try {
      await this.scheduler.resources.acquireWait(resource, controller.signal);
      acquired = true;
      return await command(this.drivers.get(deviceId), controller.signal);
    } finally {
      clearTimeout(timeout);
      this.untrackDeviceCommand(deviceId, controller);
      if (acquired) this.scheduler.resources.release(resource);
    }
  }

  private async runManualAction(deviceId: string, action: string, target: string, source: string, command: (driver: DeviceDriverAdapter, signal: AbortSignal) => Promise<void>): Promise<void> {
    const session = this.requireManualControl(deviceId);
    const started = Date.now();
    try {
      await this.runDriverCommand(deviceId, command);
      this.record(session, 'ACTION', `action=${action} target=${target} source=${source} durationMs=${Date.now() - started} result=SUCCESS`);
      await this.verifyAfterAction(session, action);
      this.emit();
    } catch (error) {
      const message = describeDriverError(error);
      this.record(session, 'ACTION', `action=${action} target=${target} source=${source} durationMs=${Date.now() - started} result=ERROR error=${message}`);
      this.emit();
      throw error;
    }
  }

  private requireManualControl(deviceId: string): DeviceSession {
    const session = this.devices.get(deviceId);
    if (!session || session.status !== 'ONLINE') throw new Error(`Device ${deviceId} is offline`);
    if (session.agentStatus !== 'HUMAN_CONTROL') throw new Error(`Take human control of ${deviceId} before sending screen input`);
    return session;
  }

  private async verifyAfterAction(session: DeviceSession, action: string): Promise<void> {
    if (session.platform !== 'ANDROID') return;
    const started = Date.now();
    try {
      const hierarchy = await this.readDriverData(session.id, (driver, signal) => driver.getUiHierarchy(signal));
      this.record(session, 'OBSERVE', `action=${action} verification=UI_HIERARCHY_AFTER_ACTION nodes=${hierarchy.nodes.length} durationMs=${Date.now() - started} result=SUCCESS`);
    } catch (error) {
      this.record(session, 'OBSERVE', `action=${action} verification=UI_HIERARCHY_AFTER_ACTION durationMs=${Date.now() - started} result=ERROR error=${describeDriverError(error)}`);
    }
  }

  private async verifyTaskAction(session: DeviceSession, driver: DeviceDriverAdapter, signal: AbortSignal): Promise<void> {
    if (session.platform !== 'ANDROID') return;
    const started = Date.now();
    try {
      const hierarchy = await driver.getUiHierarchy(signal);
      session.taskContext.lastObservation = `UI hierarchy nodes=${hierarchy.nodes.length}`;
      this.record(session, 'OBSERVE', `taskAction=goal_step verification=UI_HIERARCHY_AFTER_ACTION nodes=${hierarchy.nodes.length} durationMs=${Date.now() - started} result=SUCCESS`);
    } catch (error) {
      this.record(session, 'OBSERVE', `taskAction=goal_step verification=UI_HIERARCHY_AFTER_ACTION durationMs=${Date.now() - started} result=ERROR error=${describeDriverError(error)}`);
    }
  }

  private platformResource(platform: Platform): ResourceKind { return platform === 'ANDROID' ? 'ADB' : 'IOS'; }

  private abort(taskId: string, reason: string): void {
    this.controllers.get(taskId)?.abort(new Error(reason));
  }

  private trackDeviceCommand(deviceId: string, controller: AbortController): void {
    const controllers = this.deviceControllers.get(deviceId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.deviceControllers.set(deviceId, controllers);
  }

  private untrackDeviceCommand(deviceId: string, controller: AbortController): void {
    const controllers = this.deviceControllers.get(deviceId);
    if (!controllers) return;
    controllers.delete(controller);
    if (!controllers.size) this.deviceControllers.delete(deviceId);
  }

  private abortDeviceCommands(deviceId: string, reason: string): void {
    this.deviceControllers.get(deviceId)?.forEach(controller => controller.abort(new Error(reason)));
  }

  private record(session: DeviceSession, kind: TimelineEvent['kind'], message: string): void {
    session.actionHistory.push({ id: `${session.id}-${Date.now()}-${session.actionHistory.length}`, time: new Date().toLocaleTimeString([], { hour12: false }), kind, message });
    if (session.actionHistory.length > 100) session.actionHistory.splice(0, session.actionHistory.length - 100);
    session.screenshotSeed = (session.screenshotSeed + 1) % 8;
  }

  private emit(): void { this.listeners.forEach(listener => listener()); }
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function clampPercent(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function describeDriverError(error: unknown): string {
  const nativeError = nativeToolErrorLike(error);
  if (nativeError) {
    const command = redactSensitiveCommand(nativeError.command);
    const stderr = redactSensitiveText(nativeError.stderr.trim());
    return [nativeError.message, command ? `command=${command}` : null, stderr ? `stderr=${stderr}` : null].filter(Boolean).join(' ');
  }
  return error instanceof Error ? error.message : 'Unknown error';
}

function nativeToolErrorLike(error: unknown): { message: string; command: string; stderr: string } | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { message?: unknown; command?: unknown; stderr?: unknown };
  if (typeof candidate.command !== 'string') return null;
  return {
    message: typeof candidate.message === 'string' ? candidate.message : 'Native tool failed',
    command: candidate.command,
    stderr: typeof candidate.stderr === 'string' ? candidate.stderr : '',
  };
}

export function redactSensitiveCommand(command: string): string {
  return command.replace(/(\bshell\s+input\s+text\s+).+$/u, '$1[REDACTED_TEXT]');
}

function redactSensitiveText(value: string): string {
  if (!value) return '';
  return value.replace(/(\binput\s+text\s+).+$/u, '$1[REDACTED_TEXT]').slice(0, 500);
}
