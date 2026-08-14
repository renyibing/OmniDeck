import { DeviceManager } from './deviceManager';
import type { DeviceDriverAdapter, DevicePressKey, LongPressRequest, NormalizedPoint, ScrollWheelRequest, SwipeRequest } from './deviceDriver';
import { DriverRegistry } from './deviceDriver';
import { StreamManager } from './streamManager';
import { TaskScheduler } from './taskScheduler';
import type { DeviceSession, Platform, TaskInstance, TaskStatus, TimelineEvent } from './types';
import type { UiHierarchy } from './androidUiHierarchy';
import type { ResourceKind } from './workerPool';
import { ArtifactStore, type AgentArtifactRecord, type AgentArtifactSummary } from './artifactStore';
import type { AgentAction } from './agentActions';
import { describeAgentAction, isSensitiveGoalOrAction, parseAgentAction, redactAgentActionForLog } from './agentActions';
import type { AgentPlannerProvider } from './agentPlannerProvider';
import { DeterministicAgentPlannerProvider, normalizePlannerResponse } from './agentPlannerProvider';
import { addTaskLatency, addTaskPlannerUsage, AgentRunOrchestrator, finishTaskRun, recordTaskObservation, recordTaskStepFailure, recordTaskStepSuccess } from './agentRunOrchestrator';
import { resolveTapElement } from './agentStepEngine';
import type { AgentStepRecord } from './agentStepTrace';
import { appendAgentStepRecord, archiveStepTrace, createAgentStepRecord, getCurrentStepRecord, getRecentStepRecords, makeScreenshotArtifactRef, updateAgentStepRecord } from './agentStepTrace';
import type { AgentStateSnapshot } from './observationBuilder';
import { buildAgentObservation, buildAgentStateSnapshot, observationForState, summarizeUiHierarchy } from './observationBuilder';

type ControlPlaneListener = () => void;

export type TaskApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | null;

export interface TaskListFilter {
  status?: TaskStatus | 'ALL';
  deviceId?: string;
  batchId?: string;
  offset?: number;
  limit?: number;
}

export interface TaskSummary {
  taskId: string;
  batchId: string | null;
  deviceId: string;
  deviceName: string;
  platform: Platform;
  goal: string;
  status: TaskStatus;
  priority: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  artifactCount: number;
  latestArtifactAt: number | null;
  stepCount: number;
  maxSteps: number | null;
  currentStepIndex: number | null;
  completedSteps: number;
  failedStepIndex: number | null;
  runStartedAt: number | null;
  runEndedAt: number | null;
  lastObservationAt: number | null;
  lastVerificationAt: number | null;
  plannerProviderId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  plannerLatencyMs: number | null;
  actionLatencyMs: number | null;
  verificationLatencyMs: number | null;
  totalStepLatencyMs: number | null;
  totalRunLatencyMs: number | null;
  requiresApproval: boolean;
  approvalStatus: TaskApprovalStatus;
}

export interface TaskAuditBundle {
  task: TaskSummary;
  device: Pick<DeviceSession, 'id' | 'name' | 'platform' | 'status' | 'agentStatus' | 'currentApp' | 'sessionRevision'>;
  trace: AgentStepRecord[];
  artifacts: AgentArtifactRecord[];
  artifactSummary: AgentArtifactSummary;
  approvalStatus: TaskApprovalStatus;
}

export interface ControlPlaneOptions {
  autoExecute?: boolean;
  plannerProvider?: AgentPlannerProvider;
  artifactStore?: ArtifactStore;
}

export class ControlPlane {
  private readonly tasks = new Map<string, TaskInstance>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly deviceControllers = new Map<string, Set<AbortController>>();
  private readonly manualActionChains = new Map<string, Promise<void>>();
  private readonly listeners = new Set<ControlPlaneListener>();
  private readonly streamManager = new StreamManager();
  private readonly plannerProvider: AgentPlannerProvider;
  readonly artifactStore: ArtifactStore;
  private readonly autoExecute: boolean;
  private static readonly MANUAL_COMMAND_TIMEOUT_MS = 20_000;
  private static readonly MAX_AGENT_STEPS_PER_TASK = 24;

  constructor(
    readonly devices: DeviceManager,
    readonly scheduler: TaskScheduler,
    readonly drivers: DriverRegistry,
    options: ControlPlaneOptions = {},
  ) {
    this.autoExecute = options.autoExecute ?? true;
    this.plannerProvider = options.plannerProvider ?? new DeterministicAgentPlannerProvider();
    this.artifactStore = options.artifactStore ?? new ArtifactStore();
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
    finishTaskRun(task, task.finishedAt);
    const session = this.devices.get(task.deviceId);
    if (session?.currentTask?.id === task.id) {
      archiveStepTrace(session);
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
    this.markCurrentStepInterrupted(session, 'PAUSED', 'Task paused');
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
    finishTaskRun(task, task.finishedAt);
    this.markCurrentStepInterrupted(session, 'FAILED', 'Task stopped');
    archiveStepTrace(session);
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
    const started = Date.now();
    await this.runDriverCommand(deviceId, (driver, signal) => driver.restartApp(this.devices.get(deviceId)?.currentApp ?? '', signal));
    const session = this.devices.get(deviceId);
    if (session) this.record(session, 'ACTION', `action=restart_app target=app=${session.currentApp} source=API_COMMAND durationMs=${Date.now() - started} result=SUCCESS`);
    this.emit();
  }

  async launchApp(deviceId: string, appId = 'Omni Market'): Promise<void> {
    const started = Date.now();
    await this.runDriverCommand(deviceId, (driver, signal) => driver.launchApp(appId, signal));
    const session = this.devices.get(deviceId);
    if (session) {
      session.currentApp = appId;
      this.record(session, 'ACTION', `action=launch_app target=app=${appId} source=API_COMMAND durationMs=${Date.now() - started} result=SUCCESS`);
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

  getAgentState(deviceId: string): AgentStateSnapshot {
    const session = this.devices.get(deviceId);
    if (!session) throw new Error(`Device ${deviceId} not found`);
    return buildAgentStateSnapshot(session);
  }

  getTaskTrace(deviceId: string, taskId: string, limit = 50): AgentStepRecord[] {
    const session = this.requireTaskOnDevice(deviceId, taskId);
    return getRecentStepRecords(session, Math.min(100, Math.max(1, limit)))
      .filter(record => record.taskInstanceId === taskId)
      .slice(-limit);
  }

  getTaskArtifacts(deviceId: string, taskId: string, limit = 50): AgentArtifactRecord[] {
    this.requireTaskOnDevice(deviceId, taskId);
    return this.artifactStore.listTaskArtifacts(deviceId, taskId, Math.min(100, Math.max(1, limit)));
  }

  getTaskArtifactSummary(deviceId: string, taskId: string): AgentArtifactSummary {
    this.requireTaskOnDevice(deviceId, taskId);
    return this.artifactStore.summarizeTask(deviceId, taskId);
  }

  listTasks(filter: TaskListFilter = {}): { tasks: TaskSummary[]; total: number; offset: number; limit: number } {
    const limit = normalizeListLimit(filter.limit, 100);
    const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
    const status = filter.status && filter.status !== 'ALL' ? filter.status : null;
    const all = this.devices.getAll()
      .flatMap(session => this.collectUniqueTasks(session).map(task => this.summarizeTask(session, task)))
      .filter(task => !status || task.status === status)
      .filter(task => !filter.deviceId || task.deviceId === filter.deviceId)
      .filter(task => !filter.batchId || task.batchId === filter.batchId)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.taskId.localeCompare(b.taskId));
    return { tasks: all.slice(offset, offset + limit), total: all.length, offset, limit };
  }

  getTaskAudit(deviceId: string, taskId: string, limit = 50): TaskAuditBundle {
    const session = this.requireTaskOnDevice(deviceId, taskId);
    const task = this.findTaskInSession(session, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const boundedLimit = normalizeListLimit(limit, 50);
    const trace = this.getTaskTrace(deviceId, taskId, boundedLimit);
    const artifacts = this.getTaskArtifacts(deviceId, taskId, boundedLimit);
    const artifactSummary = this.getTaskArtifactSummary(deviceId, taskId);
    const taskSummary = this.summarizeTask(session, task);
    return {
      task: taskSummary,
      device: {
        id: session.id,
        name: session.name,
        platform: session.platform,
        status: session.status,
        agentStatus: session.agentStatus,
        currentApp: session.currentApp,
        sessionRevision: session.sessionRevision,
      },
      trace,
      artifacts,
      artifactSummary,
      approvalStatus: taskSummary.approvalStatus,
    };
  }

  approveTask(deviceId: string, taskId: string): AgentStateSnapshot {
    const session = this.devices.get(deviceId);
    const task = session?.currentTask;
    if (!session || !task || task.id !== taskId) throw new Error(`Task ${taskId} is not active on ${deviceId}`);
    if (task.status !== 'WAITING_APPROVAL') throw new Error(`Task ${taskId} is not waiting for approval`);
    const pendingStepId = typeof session.taskContext.variables.pendingApprovalStepId === 'string'
      ? session.taskContext.variables.pendingApprovalStepId
      : getCurrentStepRecord(session)?.stepId;
    const decidedAt = Date.now();
    const pendingAction = session.taskContext.variables.pendingApproval as Record<string, unknown> | null | undefined;
    if (pendingStepId) {
      updateAgentStepRecord(session, pendingStepId, record => {
        record.approval = { ...(record.approval ?? { required: true }), required: true, decision: 'APPROVED', decidedAt };
      });
      this.artifactStore.addApprovalDecision({
        deviceId,
        taskInstanceId: taskId,
        stepId: pendingStepId,
        actionType: typeof pendingAction?.type === 'string' ? pendingAction.type : null,
        decision: 'APPROVED',
        decidedAt,
      });
    }
    session.taskContext.variables.approvalGranted = true;
    session.taskContext.variables.pendingApproval = null;
    session.taskContext.variables.pendingApprovalStepId = null;
    task.status = 'PAUSED';
    task.updatedAt = Date.now();
    this.record(session, 'SYSTEM', `Human approval granted for task=${task.id}; resuming only ${deviceId}`);
    this.resumeDevice(deviceId);
    return buildAgentStateSnapshot(session);
  }

  async rejectTask(deviceId: string, taskId: string): Promise<AgentStateSnapshot> {
    const session = this.devices.get(deviceId);
    const task = session?.currentTask;
    if (!session || !task || task.id !== taskId) throw new Error(`Task ${taskId} is not active on ${deviceId}`);
    if (task.status !== 'WAITING_APPROVAL') throw new Error(`Task ${taskId} is not waiting for approval`);
    const pendingStepId = typeof session.taskContext.variables.pendingApprovalStepId === 'string'
      ? session.taskContext.variables.pendingApprovalStepId
      : getCurrentStepRecord(session)?.stepId;
    const decidedAt = Date.now();
    const pendingAction = session.taskContext.variables.pendingApproval as Record<string, unknown> | null | undefined;
    if (pendingStepId) {
      updateAgentStepRecord(session, pendingStepId, record => {
        record.status = 'FAILED';
        record.approval = { ...(record.approval ?? { required: true }), required: true, decision: 'REJECTED', decidedAt };
        record.verification = { result: 'ERROR', error: 'Human approval rejected' };
      });
      this.artifactStore.addApprovalDecision({
        deviceId,
        taskInstanceId: taskId,
        stepId: pendingStepId,
        actionType: typeof pendingAction?.type === 'string' ? pendingAction.type : null,
        decision: 'REJECTED',
        decidedAt,
      });
    }
    session.taskContext.variables.pendingApproval = null;
    session.taskContext.variables.pendingApprovalStepId = null;
    session.taskContext.variables.lastPlannedAction = null;
    this.record(session, 'SYSTEM', `Human approval rejected for task=${task.id}`);
    await this.completeTask(task.id, 'FAILED', 'Human approval rejected');
    return buildAgentStateSnapshot(session);
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
      this.markCurrentStepInterrupted(session, 'PAUSED', 'Human takeover');
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
      this.markCurrentStepInterrupted(session, 'DEVICE_OFFLINE', 'Device offline');
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
    const existing = session.taskContext.goal === task.goal ? session.taskContext : null;
    const step = existing?.step ?? task.currentStepIndex ?? 0;
    task.maxSteps ??= ControlPlane.MAX_AGENT_STEPS_PER_TASK;
    task.currentStepIndex = step;
    session.taskContext = {
      goal: task.goal,
      step,
      lastObservation: existing?.lastObservation,
      stepTrace: existing?.stepTrace,
      variables: existing?.variables ?? {},
    };
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
    let currentStepRecord: AgentStepRecord | null = null;
    try {
      if (!this.scheduler.rateLimiter.tryAcquire()) throw new Error('AI rate limit exceeded');
      await this.scheduler.resources.acquireWait('AI', controller.signal);
      ai = true;
      await this.scheduler.resources.acquireWait('VLM', controller.signal);
      vlm = true;
      await this.scheduler.resources.acquireWait(platformResource, controller.signal);
      platform = true;
      const driver = this.drivers.get(task.deviceId);
      const orchestrator = new AgentRunOrchestrator({
        task,
        maxSteps: task.maxSteps ?? ControlPlane.MAX_AGENT_STEPS_PER_TASK,
        plannerProviderId: this.plannerProvider.id,
        shouldContinue: () => task.status === 'RUNNING',
        runStep: ({ stepIndex, signal }) => this.executeAgentStep(session, task, driver, stepIndex, signal),
        onMaxSteps: async stepIndex => {
          const maxSteps = task.maxSteps ?? ControlPlane.MAX_AGENT_STEPS_PER_TASK;
          const maxRecord = appendAgentStepRecord(session, createAgentStepRecord(session, task, stepIndex));
          updateAgentStepRecord(session, maxRecord.stepId, record => {
            record.status = 'FAILED';
            record.verification = { result: 'ERROR', error: `Max agent steps reached (${maxSteps})` };
          });
          currentStepRecord = maxRecord;
          recordTaskStepFailure(task, stepIndex);
          await this.completeTask(task.id, 'FAILED', `Max agent steps reached (${maxSteps})`);
        },
      });
      await orchestrator.run(controller.signal);
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      const timedOut = reason instanceof Error && reason.message === 'Task timeout';
      const message = describeDriverError(reason);
      const record = currentStepRecord ?? getCurrentStepRecord(session);
      if (record && task.status !== 'WAITING_APPROVAL') {
        const stepStatus: AgentStepRecord['status'] = task.status === 'DEVICE_OFFLINE'
          ? 'DEVICE_OFFLINE'
          : task.status === 'PAUSED' || task.status === 'STOPPED'
            ? 'PAUSED'
            : 'FAILED';
        updateAgentStepRecord(session, record.stepId, step => {
          if (step.status === 'FINISHED' || step.status === 'WAITING_APPROVAL') return;
          step.status = stepStatus;
          step.execution = {
            startedAt: step.execution?.startedAt ?? Date.now(),
            finishedAt: Date.now(),
            durationMs: step.execution?.startedAt ? Date.now() - step.execution.startedAt : 0,
            result: 'ERROR',
            error: message,
          };
        });
      }
      if ((!controller.signal.aborted || timedOut) && task.status !== 'DEVICE_OFFLINE') {
        await this.completeTask(task.id, 'FAILED', message);
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

  private async executeAgentStep(
    session: DeviceSession,
    task: TaskInstance,
    driver: DeviceDriverAdapter,
    currentStep: number,
    signal: AbortSignal,
  ): Promise<'CONTINUE' | 'FINISHED' | 'WAITING_APPROVAL'> {
    const totalStarted = Date.now();
    let plannerLatencyMs = 0;
    let actionLatencyMs = 0;
    let verificationLatencyMs = 0;
    const currentStepRecord = appendAgentStepRecord(session, createAgentStepRecord(session, task, currentStep));

    const capture = this.streamManager.requestAIScreenshot();
    const screenshot = await driver.screenshot({ purpose: 'AI', width: capture.width, height: capture.height }, signal);
    const observationScreenshotRef = makeScreenshotArtifactRef({ screenshot, taskInstanceId: task.id, stepId: currentStepRecord.stepId, purpose: 'AI_OBSERVATION' });
    this.artifactStore.addScreenshot(observationScreenshotRef, 'AI_OBSERVATION_SCREENSHOT');
    session.agentSession.lastScreenshotAt = screenshot.capturedAt;
    const hierarchy = await this.tryReadTaskHierarchy(session, driver, signal);
    const observation = buildAgentObservation({ session, task, screenshot, hierarchy });
    const observationSummary = observationForState(observation);
    session.taskContext.lastObservation = `step=${currentStep} screenshot=${screenshot.width}x${screenshot.height} uiNodes=${observation.uiHierarchy.nodeCount}`;
    session.taskContext.variables.lastObservationSummary = observationSummary;
    recordTaskObservation(task, currentStep, screenshot.capturedAt);
    updateAgentStepRecord(session, currentStepRecord.stepId, record => {
      record.observation = {
        screenshot: observationScreenshotRef,
        uiHierarchySummary: observation.uiHierarchy,
        currentApp: session.currentApp,
        lastActionResult: observation.lastActionResult,
      };
    });
    this.artifactStore.addUiHierarchySummary({
      deviceId: session.id,
      taskInstanceId: task.id,
      stepId: currentStepRecord.stepId,
      phase: 'OBSERVATION',
      summary: observation.uiHierarchy,
    });
    this.record(session, 'OBSERVE', `Agent observation step=${currentStep} screenshot=${screenshot.width}x${screenshot.height} source=ON_DEMAND_SCREENSHOT uiNodes=${observation.uiHierarchy.nodeCount}`);

    this.artifactStore.addPlannerRequest({ providerId: this.plannerProvider.id, observation, stepId: currentStepRecord.stepId });
    let plannedAction: AgentAction;
    let plannerUsage = undefined as ReturnType<typeof normalizePlannerResponse>['usage'];
    const plannerStarted = Date.now();
    try {
      const plannerResult = normalizePlannerResponse(await this.plannerProvider.plan(observation, signal));
      plannerLatencyMs = Date.now() - plannerStarted;
      plannedAction = parseAgentAction(plannerResult.action);
      plannerUsage = plannerResult.usage;
      addTaskPlannerUsage(task, plannerResult.usage);
      this.artifactStore.addPlannerResponse({
        providerId: this.plannerProvider.id,
        deviceId: session.id,
        taskInstanceId: task.id,
        stepId: currentStepRecord.stepId,
        action: redactAgentActionForLog(plannedAction),
      });
    } catch (error) {
      plannerLatencyMs = Date.now() - plannerStarted;
      addTaskLatency(task, { plannerMs: plannerLatencyMs, totalStepMs: Date.now() - totalStarted });
      updateAgentStepRecord(session, currentStepRecord.stepId, record => {
        record.telemetry = { ...(record.telemetry ?? {}), plannerLatencyMs, totalStepLatencyMs: Date.now() - totalStarted };
      });
      this.artifactStore.addPlannerResponse({
        providerId: this.plannerProvider.id,
        deviceId: session.id,
        taskInstanceId: task.id,
        stepId: currentStepRecord.stepId,
        error: describeDriverError(error),
      });
      recordTaskStepFailure(task, currentStep);
      throw error;
    }
    this.assertActionTargetsTask(plannedAction, task);
    session.taskContext.variables.lastPlannedAction = redactAgentActionForLog(plannedAction);
    updateAgentStepRecord(session, currentStepRecord.stepId, record => {
      record.status = 'PLANNED';
      record.plannerProviderId = this.plannerProvider.id;
      record.plannedAction = redactAgentActionForLog(plannedAction);
      record.telemetry = { ...(record.telemetry ?? {}), plannerLatencyMs, usage: plannerUsage };
    });
    this.record(session, 'THINK', describeAgentAction(plannedAction));

    if (plannedAction.type === 'request_human' || (isSensitiveGoalOrAction(task.goal, plannedAction) && session.taskContext.variables.approvalGranted !== true)) {
      addTaskLatency(task, { plannerMs: plannerLatencyMs, totalStepMs: Date.now() - totalStarted });
      updateAgentStepRecord(session, currentStepRecord.stepId, record => {
        record.telemetry = { ...(record.telemetry ?? {}), plannerLatencyMs, totalStepLatencyMs: Date.now() - totalStarted, usage: plannerUsage };
      });
      this.pauseForApproval(session, task, plannedAction, currentStepRecord.stepId);
      return 'WAITING_APPROVAL';
    }

    if (plannedAction.type === 'finish') {
      updateAgentStepRecord(session, currentStepRecord.stepId, record => {
        record.status = 'FINISHED';
        record.execution = { startedAt: Date.now(), finishedAt: Date.now(), durationMs: 0, result: 'SUCCESS' };
      });
      addTaskLatency(task, { plannerMs: plannerLatencyMs, totalStepMs: Date.now() - totalStarted });
      updateAgentStepRecord(session, currentStepRecord.stepId, record => {
        record.telemetry = { ...(record.telemetry ?? {}), plannerLatencyMs, totalStepLatencyMs: Date.now() - totalStarted, usage: plannerUsage };
      });
      this.record(session, 'ACTION', `agentAction=finish actionId=${plannedAction.actionId} result=SUCCESS reason=${plannedAction.reason}`);
      await this.completeTask(task.id, 'SUCCESS');
      return 'FINISHED';
    }

    const executionStarted = Date.now();
    updateAgentStepRecord(session, currentStepRecord.stepId, record => {
      record.status = 'EXECUTING';
      record.execution = { startedAt: executionStarted };
    });
    await this.executeAgentAction(session, task, driver, plannedAction, hierarchy, signal);
    actionLatencyMs = Date.now() - executionStarted;
    updateAgentStepRecord(session, currentStepRecord.stepId, record => {
      record.execution = { startedAt: executionStarted, finishedAt: Date.now(), durationMs: actionLatencyMs, result: 'SUCCESS' };
    });
    const nextStep = currentStep + 1;
    session.taskContext.step = nextStep;
    const verificationStarted = Date.now();
    const verification = await this.verifyTaskAction(session, driver, signal, plannedAction.type);
    this.artifactStore.addUiHierarchySummary({
      deviceId: session.id,
      taskInstanceId: task.id,
      stepId: currentStepRecord.stepId,
      phase: 'VERIFICATION',
      summary: summarizeUiHierarchy(verification.hierarchy),
    });
    const postCapture = this.streamManager.requestAIScreenshot();
    const postScreenshot = await driver.screenshot({ purpose: 'AI', width: postCapture.width, height: postCapture.height }, signal);
    verificationLatencyMs = Date.now() - verificationStarted;
    const postScreenshotRef = makeScreenshotArtifactRef({ screenshot: postScreenshot, taskInstanceId: task.id, stepId: currentStepRecord.stepId, purpose: 'POST_ACTION_VERIFICATION' });
    this.artifactStore.addScreenshot(postScreenshotRef, 'POST_ACTION_SCREENSHOT');
    updateAgentStepRecord(session, currentStepRecord.stepId, record => {
      record.status = 'VERIFIED';
      record.verification = {
        screenshot: postScreenshotRef,
        uiHierarchySummary: summarizeUiHierarchy(verification.hierarchy),
        result: verification.error ? 'ERROR' : 'SUCCESS',
        error: verification.error,
      };
      record.telemetry = {
        ...(record.telemetry ?? {}),
        plannerLatencyMs,
        actionLatencyMs,
        verificationLatencyMs,
        totalStepLatencyMs: Date.now() - totalStarted,
        usage: plannerUsage,
      };
    });
    recordTaskStepSuccess(task, nextStep, Date.now());
    addTaskLatency(task, { plannerMs: plannerLatencyMs, actionMs: actionLatencyMs, verificationMs: verificationLatencyMs, totalStepMs: Date.now() - totalStarted });
    this.record(session, 'OBSERVE', `Captured post-action verification screenshot agentAction=${plannedAction.type}`);
    return 'CONTINUE';
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

  private assertActionTargetsTask(action: AgentAction, task: TaskInstance): void {
    if (action.deviceId !== task.deviceId) throw new Error(`Planner action targeted ${action.deviceId}, expected ${task.deviceId}`);
    if (action.taskInstanceId !== task.id) throw new Error(`Planner action targeted task ${action.taskInstanceId}, expected ${task.id}`);
  }

  private requireTaskOnDevice(deviceId: string, taskId: string): DeviceSession {
    const session = this.devices.get(deviceId);
    if (!session) throw new Error(`Device ${deviceId} not found`);
    const task = this.tasks.get(taskId) ?? this.findTaskInSession(session, taskId);
    if (!task || task.id !== taskId) throw new Error(`Task ${taskId} not found`);
    if (task.deviceId !== deviceId) throw new Error(`Task ${taskId} belongs to ${task.deviceId}, not ${deviceId}`);
    return session;
  }

  private collectUniqueTasks(session: DeviceSession): TaskInstance[] {
    const tasks = [...session.taskHistory, ...session.taskQueue];
    if (session.currentTask) tasks.push(session.currentTask);
    return Array.from(new Map(tasks.map(task => [task.id, task])).values());
  }

  private findTaskInSession(session: DeviceSession, taskId: string): TaskInstance | undefined {
    return this.collectUniqueTasks(session).find(task => task.id === taskId);
  }

  private summarizeTask(session: DeviceSession, task: TaskInstance): TaskSummary {
    const trace = getRecentStepRecords(session, 100).filter(record => record.taskInstanceId === task.id);
    const artifactSummary = this.artifactStore.summarizeTask(session.id, task.id);
    const approval = summarizeApproval(task, trace);
    return {
      taskId: task.id,
      batchId: task.batchId ?? null,
      deviceId: task.deviceId,
      deviceName: session.name,
      platform: session.platform,
      goal: task.goal,
      status: task.status,
      priority: task.priority,
      attempts: task.attempts,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt ?? null,
      finishedAt: task.finishedAt ?? null,
      error: task.error ?? null,
      artifactCount: artifactSummary.total,
      latestArtifactAt: artifactSummary.latestAt,
      stepCount: trace.length,
      maxSteps: task.maxSteps ?? null,
      currentStepIndex: task.currentStepIndex ?? null,
      completedSteps: task.completedSteps ?? 0,
      failedStepIndex: task.failedStepIndex ?? null,
      runStartedAt: task.runStartedAt ?? null,
      runEndedAt: task.runEndedAt ?? null,
      lastObservationAt: task.lastObservationAt ?? null,
      lastVerificationAt: task.lastVerificationAt ?? null,
      plannerProviderId: task.plannerProviderId ?? null,
      promptTokens: task.tokenUsage?.known ? task.tokenUsage.promptTokens : null,
      completionTokens: task.tokenUsage?.known ? task.tokenUsage.completionTokens : null,
      totalTokens: task.tokenUsage?.known ? task.tokenUsage.totalTokens : null,
      estimatedCostUsd: task.tokenUsage?.estimatedCostUsd ?? null,
      plannerLatencyMs: task.latencyMs?.plannerMs ?? null,
      actionLatencyMs: task.latencyMs?.actionMs ?? null,
      verificationLatencyMs: task.latencyMs?.verificationMs ?? null,
      totalStepLatencyMs: task.latencyMs?.totalStepMs ?? null,
      totalRunLatencyMs: task.latencyMs?.totalRunMs ?? null,
      requiresApproval: approval.requiresApproval,
      approvalStatus: approval.status,
    };
  }

  private async tryReadTaskHierarchy(session: DeviceSession, driver: DeviceDriverAdapter, signal: AbortSignal): Promise<UiHierarchy | null> {
    if (session.platform !== 'ANDROID' && session.platform !== 'IOS') return null;
    const started = Date.now();
    try {
      const hierarchy = await driver.getUiHierarchy(signal);
      this.record(session, 'OBSERVE', `taskObservation=UI_HIERARCHY nodes=${hierarchy.nodes.length} durationMs=${Date.now() - started} result=SUCCESS`);
      return hierarchy;
    } catch (error) {
      this.record(session, 'OBSERVE', `taskObservation=UI_HIERARCHY durationMs=${Date.now() - started} result=ERROR error=${describeDriverError(error)}`);
      return null;
    }
  }

  private pauseForApproval(session: DeviceSession, task: TaskInstance, action: AgentAction, stepId?: string): void {
    task.status = 'WAITING_APPROVAL';
    task.updatedAt = Date.now();
    session.agentStatus = 'WAITING';
    session.agentSession.status = 'WAITING';
    session.agentSession.workerId = null;
    session.taskContext.variables.pendingApproval = redactAgentActionForLog(action);
    session.taskContext.variables.pendingApprovalStepId = stepId ?? null;
    if (stepId) {
      updateAgentStepRecord(session, stepId, record => {
        record.status = 'WAITING_APPROVAL';
        record.approval = { required: true, reason: action.reason };
      });
    }
    this.record(session, 'SYSTEM', `Task waiting for human approval task=${task.id} ${describeAgentAction(action)}`);
    const promoted = this.scheduler.workers.release(task.id);
    if (promoted) this.activate(promoted);
    this.drainDeviceQueues();
    this.emit();
  }

  private async executeAgentAction(
    session: DeviceSession,
    task: TaskInstance,
    driver: DeviceDriverAdapter,
    action: AgentAction,
    observedHierarchy: UiHierarchy | null,
    signal: AbortSignal,
  ): Promise<void> {
    const started = Date.now();
    try {
      switch (action.type) {
        case 'tap_element': {
          const hierarchy = observedHierarchy ?? await driver.getUiHierarchy(signal);
          const screenSize = await driver.getScreenSize(signal);
          const resolution = resolveTapElement(hierarchy, screenSize, action.selector);
          await driver.tap(resolution.point, signal);
          this.record(session, 'ACTION', `${describeAgentAction(action)} target=node:${resolution.selectedNode.id} candidates=${resolution.candidateCount} point=${percent(resolution.point.x)},${percent(resolution.point.y)} clamped=${resolution.clamped} originalCenter=${Math.round(resolution.originalCenter.x)},${Math.round(resolution.originalCenter.y)} durationMs=${Date.now() - started} result=SUCCESS`);
          return;
        }
        case 'tap':
          await driver.tap(action.point, signal);
          this.record(session, 'ACTION', `${describeAgentAction(action)} point=${percent(action.point.x)},${percent(action.point.y)} durationMs=${Date.now() - started} result=SUCCESS`);
          return;
        case 'swipe':
          await driver.swipe({ from: action.from, to: action.to, durationMs: action.durationMs }, signal);
          this.record(session, 'ACTION', `${describeAgentAction(action)} from=${percent(action.from.x)},${percent(action.from.y)} to=${percent(action.to.x)},${percent(action.to.y)} durationMs=${Date.now() - started} result=SUCCESS`);
          return;
        case 'input_text':
          await driver.inputText(action.text, signal);
          this.record(session, 'ACTION', `${describeAgentAction(action)} redactedLength=${action.text.length} durationMs=${Date.now() - started} result=SUCCESS`);
          return;
        case 'press_key':
          await driver.pressKey(action.key, signal);
          this.record(session, 'ACTION', `${describeAgentAction(action)} key=${action.key} durationMs=${Date.now() - started} result=SUCCESS`);
          return;
        case 'back':
          await driver.back(signal);
          this.record(session, 'ACTION', `${describeAgentAction(action)} durationMs=${Date.now() - started} result=SUCCESS`);
          return;
        case 'home':
          await driver.home(signal);
          this.record(session, 'ACTION', `${describeAgentAction(action)} durationMs=${Date.now() - started} result=SUCCESS`);
          return;
        case 'launch_app':
          await driver.launchApp(action.appId, signal);
          session.currentApp = action.appId;
          this.record(session, 'ACTION', `${describeAgentAction(action)} app=${action.appId} durationMs=${Date.now() - started} result=SUCCESS`);
          return;
        case 'wait':
          await delay(Math.min(action.durationMs, 5_000), signal);
          this.record(session, 'ACTION', `${describeAgentAction(action)} waitMs=${action.durationMs} durationMs=${Date.now() - started} result=SUCCESS`);
          return;
        case 'request_human':
        case 'finish':
          return;
        default:
          exhaustiveAction(action);
      }
    } catch (error) {
      const message = describeDriverError(error);
      this.record(session, 'ACTION', `${describeAgentAction(action)} durationMs=${Date.now() - started} result=ERROR error=${message}`);
      task.updatedAt = Date.now();
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

  private async verifyTaskAction(session: DeviceSession, driver: DeviceDriverAdapter, signal: AbortSignal, action = 'goal_step'): Promise<{ hierarchy: UiHierarchy | null; error?: string }> {
    if (session.platform !== 'ANDROID' && session.platform !== 'IOS') return { hierarchy: null };
    const started = Date.now();
    try {
      const hierarchy = await driver.getUiHierarchy(signal);
      session.taskContext.lastObservation = `UI hierarchy nodes=${hierarchy.nodes.length}`;
      session.taskContext.variables.lastUiHierarchySummary = summarizeUiHierarchy(hierarchy);
      this.record(session, 'OBSERVE', `taskAction=goal_step verification=UI_HIERARCHY_AFTER_ACTION agentAction=${action} nodes=${hierarchy.nodes.length} durationMs=${Date.now() - started} result=SUCCESS`);
      return { hierarchy };
    } catch (error) {
      const message = describeDriverError(error);
      this.record(session, 'OBSERVE', `taskAction=goal_step verification=UI_HIERARCHY_AFTER_ACTION agentAction=${action} durationMs=${Date.now() - started} result=ERROR error=${message}`);
      return { hierarchy: null, error: message };
    }
  }

  private markCurrentStepInterrupted(session: DeviceSession, status: Extract<AgentStepRecord['status'], 'FAILED' | 'DEVICE_OFFLINE' | 'PAUSED'>, error: string): void {
    const current = getCurrentStepRecord(session);
    if (!current || current.taskInstanceId !== session.currentTask?.id) return;
    updateAgentStepRecord(session, current.stepId, record => {
      if (record.status === 'FINISHED' || record.status === 'WAITING_APPROVAL' || record.status === 'FAILED' || record.status === 'DEVICE_OFFLINE') return;
      const startedAt = record.execution?.startedAt ?? Date.now();
      record.status = status;
      record.execution = {
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        result: 'ERROR',
        error,
      };
    });
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

function normalizeListLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(1, Math.trunc(value ?? fallback)));
}

function summarizeApproval(task: TaskInstance, trace: AgentStepRecord[]): { requiresApproval: boolean; status: TaskApprovalStatus } {
  const latest = [...trace].reverse().find(record => record.approval);
  if (latest?.approval?.decision) return { requiresApproval: true, status: latest.approval.decision };
  const required = task.status === 'WAITING_APPROVAL' || trace.some(record => record.approval?.required);
  return { requiresApproval: required, status: required ? 'PENDING' : null };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function exhaustiveAction(value: never): never {
  throw new Error(`Unsupported agent action: ${JSON.stringify(value)}`);
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
