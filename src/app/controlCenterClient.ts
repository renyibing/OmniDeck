import type { DeviceDetailDTO, DeviceSummaryDTO, EventEnvelope, RuntimeSnapshot, StreamPolicyCommand, BatchTaskCommand } from '../server/protocol';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type DeviceAction = 'pause' | 'resume' | 'stop' | 'retry' | 'take-control' | 'release-control' | 'disconnect' | 'recover' | 'restart-app' | 'launch-app';

type RuntimeResponse = RuntimeSnapshot;
type EventHandler = (event: EventEnvelope) => void;
type StateHandler = (state: ConnectionState) => void;
type ResyncHandler = (runtime: RuntimeSnapshot) => void;

export class ControlCenterClient {
  private readonly apiBase: string;

  constructor(apiBase = '/api') {
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  async getRuntime(signal?: AbortSignal): Promise<RuntimeSnapshot> {
    return this.request<RuntimeResponse>('/runtime', { signal });
  }

  async getDevices(signal?: AbortSignal): Promise<DeviceSummaryDTO[]> {
    const result = await this.request<{ devices: DeviceSummaryDTO[] }>('/devices', { signal });
    return result.devices;
  }

  async getDeviceDetail(deviceId: string, signal?: AbortSignal): Promise<DeviceDetailDTO> {
    const result = await this.request<{ device: DeviceDetailDTO }>(`/devices/${encodeURIComponent(deviceId)}`, { signal });
    return result.device;
  }

  async submitBatch(command: BatchTaskCommand): Promise<void> {
    await this.request('/tasks/batch', { method: 'POST', body: command });
  }

  async deviceAction(deviceId: string, action: DeviceAction, commandId = crypto.randomUUID(), appId?: string): Promise<void> {
    await this.request(`/devices/${encodeURIComponent(deviceId)}/${action}`, {
      method: 'POST',
      body: { commandId, deviceId, timestamp: Date.now(), ...(action === 'launch-app' ? { appId: appId ?? 'Omni Market' } : {}) },
    });
  }

  async applyStreamPolicy(command: StreamPolicyCommand): Promise<void> {
    await this.request('/session/stream-policy', { method: 'POST', body: command });
  }

  subscribe(
    since: number,
    onEvent: EventHandler,
    onState: StateHandler,
    onResync: ResyncHandler,
  ): () => void {
    let lastSequence = since;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let closed = false;
    let reconnectAttempt = 0;

    const setState = (state: ConnectionState) => onState(state);
    const connect = () => {
      if (closed) return;
      setState(reconnectAttempt ? 'reconnecting' : 'connecting');
      source = new EventSource(`${this.apiBase}/events?since=${lastSequence}`);
      source.onopen = () => { reconnectAttempt = 0; setState('connected'); };
      source.onmessage = event => {
        try {
          const envelope = JSON.parse(event.data) as EventEnvelope;
          if (envelope.sequence <= lastSequence) return;
          lastSequence = envelope.sequence;
          onEvent(envelope);
        } catch {
          setState('reconnecting');
        }
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        reconnectAttempt += 1;
        setState('reconnecting');
        void this.getRuntime().then(runtime => {
          lastSequence = runtime.server.latestSequence;
          onResync(runtime);
        }).catch(() => undefined);
        const delay = Math.min(8_000, 500 * 2 ** Math.min(reconnectAttempt - 1, 4));
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      source?.close();
      source = null;
      setState('disconnected');
    };
  }

  private async request<T = unknown>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'content-type': 'application/json', 'x-omnideck-client': 'web' } : { 'x-omnideck-client': 'web' },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Control service request failed (${response.status})`);
    return payload as T;
  }
}
