import { z } from 'zod';
import type {
  AgentStatus,
  ConcurrencyConfig,
  DeviceGroup,
  DeviceMetrics,
  DeviceSession,
  DeviceStatus,
  HealthState,
  LayoutSize,
  Platform,
  StreamProfile,
  TaskContext,
  TaskInstance,
  TimelineEvent,
  DriverMode,
} from '../domain/types';
import type { DeviceConfiguration, DeviceConnection } from '../domain/types';
import type { DiscoveredDevice } from '../domain/deviceDiscovery';
import type { IOSWdaStatus } from '../domain/iosWdaDiagnostics';
import type { UiHierarchy } from '../domain/androidUiHierarchy';

export const protocolVersion = 'v1' as const;

/** Lightweight wall DTO. It intentionally excludes histories, memory, and live domain objects. */
export interface DeviceSummaryDTO {
  id: string;
  name: string;
  platform: Platform;
  model: string;
  status: DeviceStatus;
  agentStatus: AgentStatus;
  health: HealthState;
  currentApp: string;
  groupIds: string[];
  metrics: DeviceMetrics;
  stream: StreamProfile;
  currentTask: TaskInstance | null;
  queuedTaskCount: number;
  screenshotSeed: number;
  sessionRevision: number;
  configuration: DeviceConfiguration | null;
  connection: DeviceConnection;
  livePreview: boolean;
  /** Low-latency H.264 preview over WebSocket + WebCodecs (Android scrcpy-server). */
  previewVideoUrl: string | null;
  /** MJPEG fallback preview for iOS or when H.264 is unavailable. */
  previewStreamUrl: string | null;
}

export type DiscoveredDeviceDTO = DiscoveredDevice;
export type IOSWdaStatusDTO = IOSWdaStatus;
export type UiHierarchyDTO = UiHierarchy;

export interface DeviceDetailDTO extends DeviceSummaryDTO {
  agentSessionId: string;
  workerId: string | null;
  healthState: DeviceSession['healthState'];
  taskQueue: TaskInstance[];
  taskHistory: TaskInstance[];
  taskContext: TaskContext;
  actionHistory: TimelineEvent[];
  logs: TimelineEvent[];
}

export interface RuntimeSnapshot {
  version: typeof protocolVersion;
  devices: DeviceSummaryDTO[];
  workers: { active: number; queued: number; completed: number };
  resources: Record<'AI' | 'VLM' | 'ADB' | 'IOS', number>;
  config: ConcurrencyConfig;
  groups: DeviceGroup[];
  server: { startedAt: number; sessionEpoch: string; latestSequence: number };
}

export type EventType =
  | 'DEVICE_ADDED'
  | 'DEVICE_UPDATED'
  | 'DEVICE_OFFLINE'
  | 'DEVICE_RECOVERED'
  | 'TASK_CREATED'
  | 'TASK_QUEUED'
  | 'TASK_STARTED'
  | 'TASK_PAUSED'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'WORKER_POOL_UPDATED'
  | 'HEALTH_UPDATED'
  | 'HUMAN_CONTROL_STARTED'
  | 'HUMAN_CONTROL_RELEASED'
  | 'DEVICE_DISCOVERED'
  | 'DEVICE_CONFIGURED'
  | 'DEVICE_CONNECTING'
  | 'DEVICE_CONNECTED'
  | 'DEVICE_CONNECTION_FAILED';

export interface EventEnvelope {
  version: typeof protocolVersion;
  eventId: string;
  sequence: number;
  occurredAt: number;
  type: EventType;
  deviceId: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
}

export const eventEnvelopeSchema = z.object({
  version: z.literal(protocolVersion),
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.number().int().positive(),
  type: z.enum([
    'DEVICE_ADDED', 'DEVICE_UPDATED', 'DEVICE_OFFLINE', 'DEVICE_RECOVERED',
    'TASK_CREATED', 'TASK_QUEUED', 'TASK_STARTED', 'TASK_PAUSED', 'TASK_COMPLETED', 'TASK_FAILED',
    'WORKER_POOL_UPDATED', 'HEALTH_UPDATED', 'HUMAN_CONTROL_STARTED', 'HUMAN_CONTROL_RELEASED',
    'DEVICE_DISCOVERED', 'DEVICE_CONFIGURED', 'DEVICE_CONNECTING', 'DEVICE_CONNECTED', 'DEVICE_CONNECTION_FAILED',
  ]),
  deviceId: z.string().nullable(),
  taskId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});

const commandBase = z.object({
  commandId: z.string().trim().min(1).max(120),
  timestamp: z.number().int().positive(),
});

export const batchTaskCommandSchema = commandBase.extend({
  targetDeviceIds: z.array(z.string().trim().min(1)).min(1).max(128),
  goal: z.string().trim().min(1).max(2_000),
  priority: z.number().int().min(0).max(100).default(1),
});

export const deviceCommandSchema = commandBase.extend({
  deviceId: z.string().trim().min(1),
});

export const launchAppCommandSchema = deviceCommandSchema.extend({
  appId: z.string().trim().min(1).max(240).default('Omni Market'),
});

export const normalizedPointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});

export const screenTapCommandSchema = deviceCommandSchema.extend({
  point: normalizedPointSchema,
  source: z.enum(['LIVE_PREVIEW', 'FULLSCREEN_PREVIEW']).default('LIVE_PREVIEW'),
});

export const swipeCommandSchema = deviceCommandSchema.extend({
  from: normalizedPointSchema,
  to: normalizedPointSchema,
  durationMs: z.number().int().min(0).max(5_000).default(350),
  source: z.enum(['INSPECTOR', 'FULLSCREEN_PREVIEW']).default('INSPECTOR'),
});

export const longPressCommandSchema = deviceCommandSchema.extend({
  point: normalizedPointSchema,
  durationMs: z.number().int().min(350).max(5_000).default(650),
  source: z.enum(['INSPECTOR', 'FULLSCREEN_PREVIEW']).default('INSPECTOR'),
});

export const inputTextCommandSchema = deviceCommandSchema.extend({
  text: z.string().min(1).max(2_000),
  source: z.enum(['INSPECTOR', 'FULLSCREEN_PREVIEW']).default('INSPECTOR'),
});

export const streamPolicyCommandSchema = commandBase.extend({
  layout: z.union([z.literal(1), z.literal(4), z.literal(8), z.literal(9), z.literal(16), z.literal(25), z.literal(32)]),
  focusedId: z.string().nullable(),
  fullscreenId: z.string().nullable(),
  visibleDeviceIds: z.array(z.string()).max(128),
  targetDeviceIds: z.array(z.string().trim().min(1)).min(1).max(128),
});

const platformSchema = z.enum(['ANDROID', 'IOS']);
export const deviceConfigurationSchema = z.object({
  deviceId: z.string().trim().min(1),
  platform: platformSchema,
  name: z.string().trim().min(1).max(120),
  identifier: z.string().trim().min(1).max(240),
  appId: z.string().trim().min(1).max(240),
  transport: z.enum(['ADB', 'XCUITEST']),
  orientation: z.literal('PORTRAIT'),
  driverMode: z.enum(['SIMULATED', 'ANDROID_ADB_SCRCPY', 'IOS_XCUITEST']).default('SIMULATED'),
  wdaBundleId: z.string().trim().max(240).optional(),
  wdaUrl: z.string().url().max(500).optional(),
});

export const configureDeviceCommandSchema = commandBase.extend({
  configuration: deviceConfigurationSchema,
});

export const connectDeviceCommandSchema = deviceCommandSchema;

export type DeviceConfigurationDTO = Omit<DeviceConfiguration, 'configuredAt'>;
export type ConfiguredDeviceConfigurationDTO = DeviceConfiguration;
export interface ConnectionAttemptDTO extends DeviceConnection {
  deviceId: string;
}

export type BatchTaskCommand = z.infer<typeof batchTaskCommandSchema>;
export type DeviceCommand = z.infer<typeof deviceCommandSchema>;
export type LaunchAppCommand = z.infer<typeof launchAppCommandSchema>;
export type ScreenTapCommand = z.infer<typeof screenTapCommandSchema>;
export type SwipeCommand = z.infer<typeof swipeCommandSchema>;
export type LongPressCommand = z.infer<typeof longPressCommandSchema>;
export type InputTextCommand = z.infer<typeof inputTextCommandSchema>;
export type StreamPolicyCommand = z.infer<typeof streamPolicyCommandSchema>;

export const cloneSnapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const toDeviceSummary = (session: DeviceSession): DeviceSummaryDTO => cloneSnapshot({
  id: session.id,
  name: session.name,
  platform: session.platform,
  model: session.model,
  status: session.status,
  agentStatus: session.agentStatus,
  health: session.health,
  currentApp: session.currentApp,
  groupIds: session.groupIds,
  metrics: session.metrics,
  stream: session.stream,
  currentTask: session.currentTask,
  queuedTaskCount: session.taskQueue.length,
  screenshotSeed: session.screenshotSeed,
  sessionRevision: session.sessionRevision,
  configuration: session.configuration,
  connection: session.connection,
  livePreview: Boolean(session.configuration && session.configuration.driverMode !== 'SIMULATED' && session.connection.state === 'CONNECTED'),
  previewVideoUrl: session.configuration?.driverMode === 'ANDROID_ADB_SCRCPY' && session.connection.state === 'CONNECTED'
    ? `/api/devices/${encodeURIComponent(session.id)}/video`
    : null,
  previewStreamUrl: session.configuration && session.configuration.driverMode !== 'SIMULATED' && session.connection.state === 'CONNECTED'
    ? `/api/devices/${encodeURIComponent(session.id)}/mjpeg`
    : null,
});

export const toDeviceDetail = (session: DeviceSession): DeviceDetailDTO => cloneSnapshot({
  ...toDeviceSummary(session),
  agentSessionId: session.agentSession.id,
  workerId: session.agentSession.workerId,
  healthState: session.healthState,
  taskQueue: session.taskQueue,
  taskHistory: session.taskHistory,
  taskContext: session.taskContext,
  actionHistory: session.actionHistory,
  logs: session.actionHistory,
});

export const toRuntimeSnapshot = (args: {
  devices: DeviceSummaryDTO[];
  workers: RuntimeSnapshot['workers'];
  resources: RuntimeSnapshot['resources'];
  config: ConcurrencyConfig;
  groups: DeviceGroup[];
  startedAt: number;
  sessionEpoch: string;
  latestSequence: number;
}): RuntimeSnapshot => cloneSnapshot({
  version: protocolVersion,
  devices: args.devices,
  workers: args.workers,
  resources: args.resources,
  config: args.config,
  groups: args.groups,
  server: { startedAt: args.startedAt, sessionEpoch: args.sessionEpoch, latestSequence: args.latestSequence },
});

export const isLayoutSize = (value: number): value is LayoutSize => [1, 4, 8, 9, 16, 25, 32].includes(value);
