import { describe, expect, it, vi } from 'vitest';
import { AgentWorkerPool, RateLimiter, ResourceLimiter } from './workerPool';
import { ControlPlane } from './controlPlane';
import { DriverRegistry, SimulatedDeviceDriver } from './deviceDriver';
import { DeviceManager } from './deviceManager';
import { SessionManager } from './sessionManager';
import { StreamManager } from './streamManager';
import { TaskScheduler } from './taskScheduler';
import type { ConcurrencyConfig, TaskInstance } from './types';

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

describe('control plane lifecycle', () => {
  const makePlane = (count = 12, autoExecute = false, driverLatency = 0) => {
    const devices = new DeviceManager(count);
    const scheduler = new TaskScheduler({ maxConcurrentAI: 8, maxConcurrentVLM: 4, maxConcurrentADB: 12, maxConcurrentIOS: 4, timeoutMs: 500, maxRetries: 2, rateLimitPerMinute: 60 });
    const drivers = new DriverRegistry();
    devices.getAll().forEach(device => drivers.register(new SimulatedDeviceDriver(device, driverLatency)));
    return { devices, scheduler, plane: new ControlPlane(devices, scheduler, drivers, { autoExecute }) };
  };

  it('executes a task, records it, and releases resources', async () => {
    const { devices, plane } = makePlane(12, true);
    plane.stopDevice('device-01');
    const [task] = plane.submitBatch('Check the dashboard', ['device-01']);
    await new Promise(resolve => setTimeout(resolve, 20));
    const session = devices.get('device-01')!;
    expect(task.status).toBe('SUCCESS');
    expect(session.currentTask).toBeNull();
    expect(session.taskHistory.some(item => item.id === task.id && item.status === 'SUCCESS')).toBe(true);
    expect(plane.scheduler.workers.snapshot().active).toBeLessThanOrEqual(8);
    expect(plane.scheduler.resources.snapshot()).toEqual({ AI: 0, VLM: 0, ADB: 0, IOS: 0 });
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
