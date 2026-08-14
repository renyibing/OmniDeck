import { eventEnvelopeSchema, type AgentArtifactDTO, type AgentArtifactSummaryDTO, type AgentStateDTO, type AgentTaskTraceDTO, type DeviceConfigurationDTO, type DeviceDetailDTO, type DeviceSummaryDTO, type DiscoveredDeviceDTO, type EventEnvelope, type RuntimeSnapshot, type StreamPolicyCommand, type BatchTaskCommand, type IOSWdaStatusDTO, type TaskAuditDTO, type TaskSummaryDTO, type UiHierarchyDTO } from '../server/protocol';
import type { TaskStatus } from '../domain/types';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type DeviceAction = 'pause' | 'resume' | 'stop' | 'retry' | 'take-control' | 'release-control' | 'disconnect' | 'clear-configuration' | 'recover' | 'restart-app' | 'launch-app' | 'stop-app';
export type ScreenInputSource = 'INSPECTOR' | 'LIVE_PREVIEW' | 'FULLSCREEN_PREVIEW';
export type DevicePressKey =
  | 'Enter'
  | 'Backspace'
  | 'Delete'
  | 'Tab'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight';
export interface ScreenTapPoint { x: number; y: number; }
export interface SwipeCommandInput { from: ScreenTapPoint; to: ScreenTapPoint; durationMs?: number; }
export interface TaskArtifactsResponse { artifacts: AgentArtifactDTO[]; summary: AgentArtifactSummaryDTO; }
export interface TaskListResponse { tasks: TaskSummaryDTO[]; total: number; limit: number; offset: number; }
export interface TaskListFilter { status?: TaskStatus | 'ALL'; deviceId?: string; batchId?: string; limit?: number; offset?: number; }

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

  async getWdaStatus(deviceId: string, signal?: AbortSignal): Promise<IOSWdaStatusDTO> {
    const result = await this.request<{ wdaStatus: IOSWdaStatusDTO }>(`/devices/${encodeURIComponent(deviceId)}/wda-status`, { signal });
    return result.wdaStatus;
  }

  async getUiTree(deviceId: string, signal?: AbortSignal): Promise<UiHierarchyDTO> {
    const result = await this.request<{ uiTree: UiHierarchyDTO }>(`/devices/${encodeURIComponent(deviceId)}/ui-tree`, { signal });
    return result.uiTree;
  }

  async getAgentState(deviceId: string, signal?: AbortSignal): Promise<AgentStateDTO> {
    const result = await this.request<{ agentState: AgentStateDTO }>(`/devices/${encodeURIComponent(deviceId)}/agent-state`, { signal });
    return result.agentState;
  }

  async getTaskTrace(deviceId: string, taskId: string, signal?: AbortSignal): Promise<AgentTaskTraceDTO[]> {
    const result = await this.request<{ trace: AgentTaskTraceDTO[] }>(`/devices/${encodeURIComponent(deviceId)}/tasks/${encodeURIComponent(taskId)}/trace`, { signal });
    return result.trace;
  }

  async getTaskArtifacts(deviceId: string, taskId: string, signal?: AbortSignal): Promise<TaskArtifactsResponse> {
    const result = await this.request<TaskArtifactsResponse>(`/devices/${encodeURIComponent(deviceId)}/tasks/${encodeURIComponent(taskId)}/artifacts`, { signal });
    return result;
  }

  async getTasks(filter: TaskListFilter = {}, signal?: AbortSignal): Promise<TaskListResponse> {
    const params = new URLSearchParams();
    if (filter.status && filter.status !== 'ALL') params.set('status', filter.status);
    if (filter.deviceId) params.set('deviceId', filter.deviceId);
    if (filter.batchId) params.set('batchId', filter.batchId);
    if (filter.limit) params.set('limit', String(filter.limit));
    if (filter.offset) params.set('offset', String(filter.offset));
    const query = params.toString();
    return this.request<TaskListResponse>(`/tasks${query ? `?${query}` : ''}`, { signal });
  }

  async getTaskAudit(taskId: string, signal?: AbortSignal): Promise<TaskAuditDTO> {
    const result = await this.request<{ audit: TaskAuditDTO }>(`/tasks/${encodeURIComponent(taskId)}/audit`, { signal });
    return result.audit;
  }

  async discoverDevices(signal?: AbortSignal): Promise<DiscoveredDeviceDTO[]> {
    const result = await this.request<{ devices: DiscoveredDeviceDTO[] }>('/devices/discovery', { signal });
    return result.devices;
  }

  async configureDevice(configuration: DeviceConfigurationDTO, commandId = crypto.randomUUID()): Promise<DeviceSummaryDTO> {
    const result = await this.request<{ device: DeviceSummaryDTO }>('/devices/configure', {
      method: 'POST',
      body: { commandId, timestamp: Date.now(), configuration },
    });
    return result.device;
  }

  async connectDevice(deviceId: string, commandId = crypto.randomUUID()): Promise<DeviceSummaryDTO> {
    const result = await this.request<{ device: DeviceSummaryDTO }>(`/devices/${encodeURIComponent(deviceId)}/connect`, {
      method: 'POST',
      body: { commandId, deviceId, timestamp: Date.now() },
    });
    return result.device;
  }

  async submitBatch(command: BatchTaskCommand): Promise<void> {
    await this.request('/tasks/batch', { method: 'POST', body: command });
  }

  async approveTask(deviceId: string, taskId: string, commandId = crypto.randomUUID()): Promise<AgentStateDTO> {
    const result = await this.request<{ agentState: AgentStateDTO }>(`/devices/${encodeURIComponent(deviceId)}/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: 'POST',
      body: { commandId, deviceId, taskId, timestamp: Date.now() },
    });
    return result.agentState;
  }

  async rejectTask(deviceId: string, taskId: string, commandId = crypto.randomUUID()): Promise<AgentStateDTO> {
    const result = await this.request<{ agentState: AgentStateDTO }>(`/devices/${encodeURIComponent(deviceId)}/tasks/${encodeURIComponent(taskId)}/reject`, {
      method: 'POST',
      body: { commandId, deviceId, taskId, timestamp: Date.now() },
    });
    return result.agentState;
  }

  async deviceAction(deviceId: string, action: DeviceAction, commandId = crypto.randomUUID(), appId?: string, signal?: AbortSignal): Promise<DeviceSummaryDTO> {
    const result = await this.request<{ device: DeviceSummaryDTO }>(`/devices/${encodeURIComponent(deviceId)}/${action}`, {
      method: 'POST',
      body: { commandId, deviceId, timestamp: Date.now(), ...(action === 'launch-app' || action === 'stop-app' ? { appId: appId ?? 'Omni Market' } : {}) },
      signal,
    });
    return result.device;
  }

  async stopAppDevice(deviceId: string, appId: string, commandId = crypto.randomUUID()): Promise<void> {
    await this.deviceAction(deviceId, 'stop-app', commandId, appId);
  }

  async tapDevice(deviceId: string, point: ScreenTapPoint, source: 'LIVE_PREVIEW' | 'FULLSCREEN_PREVIEW' = 'LIVE_PREVIEW', signal?: AbortSignal, commandId = crypto.randomUUID()): Promise<void> {
    const { signal: requestSignal, dispose } = withRequestTimeout(signal, 25_000);
    try {
      await this.request(`/devices/${encodeURIComponent(deviceId)}/tap`, {
        method: 'POST',
        body: { commandId, deviceId, timestamp: Date.now(), point, source },
        signal: requestSignal,
      });
    } finally {
      dispose();
    }
  }

  async swipeDevice(deviceId: string, input: SwipeCommandInput, source: ScreenInputSource = 'INSPECTOR', signal?: AbortSignal, commandId = crypto.randomUUID()): Promise<void> {
    await this.request(`/devices/${encodeURIComponent(deviceId)}/swipe`, {
      method: 'POST',
      body: { commandId, deviceId, timestamp: Date.now(), ...input, source },
      signal,
    });
  }

  async longPressDevice(deviceId: string, point: ScreenTapPoint, durationMs = 650, source: ScreenInputSource = 'INSPECTOR', signal?: AbortSignal, commandId = crypto.randomUUID()): Promise<void> {
    await this.request(`/devices/${encodeURIComponent(deviceId)}/long-press`, {
      method: 'POST',
      body: { commandId, deviceId, timestamp: Date.now(), point, durationMs, source },
      signal,
    });
  }

  async inputTextDevice(deviceId: string, text: string, source: ScreenInputSource = 'INSPECTOR', signal?: AbortSignal, commandId = crypto.randomUUID()): Promise<void> {
    await this.request(`/devices/${encodeURIComponent(deviceId)}/input-text`, {
      method: 'POST',
      body: { commandId, deviceId, timestamp: Date.now(), text, source },
      signal,
    });
  }

  async pressKeyDevice(deviceId: string, key: DevicePressKey, source: ScreenInputSource = 'INSPECTOR', signal?: AbortSignal, commandId = crypto.randomUUID()): Promise<void> {
    await this.request(`/devices/${encodeURIComponent(deviceId)}/press-key`, {
      method: 'POST',
      body: { commandId, deviceId, timestamp: Date.now(), key, source },
      signal,
    });
  }

  async scrollWheelDevice(deviceId: string, point: ScreenTapPoint, deltaX: number, deltaY: number, source: ScreenInputSource = 'LIVE_PREVIEW', signal?: AbortSignal, commandId = crypto.randomUUID()): Promise<void> {
    await this.request(`/devices/${encodeURIComponent(deviceId)}/scroll`, {
      method: 'POST',
      body: { commandId, deviceId, timestamp: Date.now(), point, deltaX, deltaY, source },
      signal,
    });
  }

  async backDevice(deviceId: string, commandId = crypto.randomUUID()): Promise<void> {
    await this.request(`/devices/${encodeURIComponent(deviceId)}/back`, { method: 'POST', body: { commandId, deviceId, timestamp: Date.now() } });
  }

  async homeDevice(deviceId: string, commandId = crypto.randomUUID()): Promise<void> {
    await this.request(`/devices/${encodeURIComponent(deviceId)}/home`, { method: 'POST', body: { commandId, deviceId, timestamp: Date.now() } });
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
    let connectionGeneration = 0;

    const setState = (state: ConnectionState) => onState(state);
    const connect = () => {
      if (closed) return;
      reconnectTimer = null;
      const generation = ++connectionGeneration;
      setState(reconnectAttempt ? 'reconnecting' : 'connecting');
      const currentSource = new EventSource(`${this.apiBase}/events?since=${lastSequence}`);
      source = currentSource;
      currentSource.onopen = () => { if (closed || source !== currentSource) return; reconnectAttempt = 0; setState('connected'); };
      currentSource.onmessage = event => {
        if (closed || source !== currentSource) return;
        try {
          const envelope = eventEnvelopeSchema.parse(JSON.parse(event.data)) as EventEnvelope;
          if (envelope.sequence <= lastSequence) return;
          lastSequence = envelope.sequence;
          onEvent(envelope);
        } catch {
          setState('reconnecting');
        }
      };
      currentSource.onerror = () => {
        if (closed || source !== currentSource || generation !== connectionGeneration) return;
        currentSource.close();
        source = null;
        if (reconnectTimer !== null) return;
        reconnectAttempt += 1;
        setState('reconnecting');
        void this.getRuntime().then(runtime => {
          if (closed || generation !== connectionGeneration) return;
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
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}${path}`, {
        method: options.method ?? 'GET',
        headers: options.body ? { 'content-type': 'application/json', 'x-omnideck-client': 'web' } : { 'x-omnideck-client': 'web' },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error(error instanceof Error ? error.message : 'Control service request failed');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Control service request failed (${response.status})`);
    return payload as T;
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && /abort|canceled|cancelled|timed out|timeout/i.test(error.message)) return true;
  return false;
}

function withRequestTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('Request aborted'));
  if (signal?.aborted) {
    window.clearTimeout(timer);
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
