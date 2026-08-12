import { afterEach, describe, expect, it } from 'vitest';
import { ControlDaemon } from './controlDaemon';

const daemons: ControlDaemon[] = [];

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
});

describe('Control Daemon HTTP/SSE protocol', () => {
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
  });

  it('validates commands and enforces URL/device target agreement', async () => {
    const { baseUrl } = await start();
    const invalid = await json(baseUrl, '/api/tasks/batch', postBody({ goal: 'missing command metadata' }));
    const mismatch = await json(baseUrl, '/api/devices/device-01/pause', postBody({ commandId: 'mismatch-1', timestamp: Date.now(), deviceId: 'device-02' }));

    expect(invalid.response.status).toBe(400);
    expect(mismatch.response.status).toBe(400);
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
});
