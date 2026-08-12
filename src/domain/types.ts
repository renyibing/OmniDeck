export const LAYOUTS = [1, 4, 8, 9, 16, 25, 32] as const;
export type LayoutSize = (typeof LAYOUTS)[number];
export type Platform = 'ANDROID' | 'IOS';
export type DeviceStatus = 'ONLINE' | 'OFFLINE' | 'ERROR';
export type AgentStatus = 'IDLE' | 'WAITING' | 'RUNNING' | 'PAUSED' | 'HUMAN_CONTROL' | 'ERROR';
export type TaskStatus = 'IDLE' | 'WAITING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'PAUSED' | 'STOPPED' | 'DEVICE_OFFLINE';
export type HealthState = 'HEALTHY' | 'DEGRADED' | 'OFFLINE';
export type StreamMode = 'BACKGROUND' | 'PREVIEW' | 'FOCUSED' | 'FULLSCREEN';

export interface DeviceMetrics {
  fps: number;
  latency: number;
  cpu: number;
  memory: number;
  battery: number;
  temperature: number;
  network: 'WIFI' | '5G' | '4G' | 'OFFLINE';
}

export interface StreamProfile {
  mode: StreamMode;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
}

export interface TaskInstance {
  id: string;
  batchId?: string;
  deviceId: string;
  goal: string;
  status: TaskStatus;
  priority: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  kind: 'OBSERVE' | 'THINK' | 'ACTION' | 'SYSTEM';
  message: string;
}

export interface AgentSession {
  id: string;
  deviceId: string;
  status: AgentStatus;
  workerId: string | null;
  lastScreenshotAt: number | null;
}

export interface TaskContext {
  goal?: string;
  step?: number;
  lastObservation?: string;
  variables: Record<string, unknown>;
}

export interface DeviceHealth {
  state: HealthState;
  lastCheckAt: number;
  adbConnected: boolean;
  screenResponsive: boolean;
  appAlive: boolean;
  agentAlive: boolean;
}

export interface DeviceDriverState {
  deviceId: string;
  platform: Platform;
  transport: 'ADB' | 'XCUITEST';
  connected: boolean;
}

export interface ScreenStream {
  deviceId: string;
  profile: StreamProfile;
  transport: 'SCRCPY' | 'IOS_MIRROR';
  aiCaptureMode: 'SCREENSHOT_DRIVEN';
}

export interface AgentRuntime {
  deviceId: string;
  sessionId: string;
  persistentWorker: false;
  analyzeVideo: false;
}

export interface DeviceSession {
  id: string;
  name: string;
  platform: Platform;
  model: string;
  status: DeviceStatus;
  agentStatus: AgentStatus;
  health: HealthState;
  healthState: DeviceHealth;
  agentSession: AgentSession;
  deviceDriver: DeviceDriverState;
  screenStream: ScreenStream;
  agentRuntime: AgentRuntime;
  currentApp: string;
  groupIds: string[];
  metrics: DeviceMetrics;
  stream: StreamProfile;
  currentTask: TaskInstance | null;
  taskQueue: TaskInstance[];
  taskHistory: TaskInstance[];
  taskContext: TaskContext;
  actionHistory: TimelineEvent[];
  memory: Record<string, unknown>;
  screenshotSeed: number;
  sessionRevision: number;
}

export interface DeviceGroup {
  id: string;
  name: string;
  deviceIds: string[];
  preferredLayout: LayoutSize;
}

export interface WorkspacePreset {
  id: string;
  name: string;
  layout: LayoutSize;
  deviceIds: string[];
  groupId: string;
}

export interface ConcurrencyConfig {
  maxConcurrentAI: number;
  maxConcurrentVLM: number;
  maxConcurrentADB: number;
  maxConcurrentIOS: number;
  timeoutMs: number;
  maxRetries: number;
  rateLimitPerMinute?: number;
}
