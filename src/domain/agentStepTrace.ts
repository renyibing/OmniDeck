import type { AgentActionLog } from './agentActions';
import type { AgentPlannerUsage } from './agentPlannerProvider';
import type { ArtifactRedactionStatus, ArtifactRetention } from './artifactStore';
import type { ScreenshotResult } from './deviceDriver';
import type { UiHierarchySummary } from './observationBuilder';
import type { DeviceSession, TaskInstance } from './types';

export type AgentStepStatus = 'PLANNED' | 'EXECUTING' | 'VERIFIED' | 'WAITING_APPROVAL' | 'FAILED' | 'FINISHED' | 'DEVICE_OFFLINE' | 'PAUSED';
export type AgentStepResult = 'SUCCESS' | 'ERROR';
export type AgentApprovalDecision = 'APPROVED' | 'REJECTED';

export interface ScreenshotArtifactRef {
  artifactId: string;
  id: string;
  deviceId: string;
  taskInstanceId: string;
  stepId: string;
  purpose: 'AI_OBSERVATION' | 'POST_ACTION_VERIFICATION';
  width: number;
  height: number;
  capturedAt: number;
  source: 'ON_DEMAND_SCREENSHOT';
  retention: ArtifactRetention;
  hasBinary: boolean;
  redactionStatus: ArtifactRedactionStatus;
}

export interface AgentStepRecord {
  stepId: string;
  deviceId: string;
  taskInstanceId: string;
  stepIndex: number;
  status: AgentStepStatus;
  plannerProviderId?: string;
  observation: {
    screenshot?: ScreenshotArtifactRef;
    uiHierarchySummary?: UiHierarchySummary;
    currentApp: string;
    lastActionResult?: string | null;
  };
  plannedAction?: AgentActionLog;
  execution?: {
    startedAt: number;
    finishedAt?: number;
    durationMs?: number;
    result?: AgentStepResult;
    error?: string;
  };
  verification?: {
    screenshot?: ScreenshotArtifactRef;
    uiHierarchySummary?: UiHierarchySummary;
    result: AgentStepResult;
    error?: string;
  };
  approval?: {
    required: boolean;
    reason?: string;
    decidedAt?: number;
    decision?: AgentApprovalDecision;
  };
  telemetry?: {
    plannerLatencyMs?: number;
    actionLatencyMs?: number;
    verificationLatencyMs?: number;
    totalStepLatencyMs?: number;
    usage?: AgentPlannerUsage;
  };
  createdAt: number;
  updatedAt: number;
}

export function createAgentStepRecord(session: DeviceSession, task: TaskInstance, stepIndex: number): AgentStepRecord {
  const now = Date.now();
  const existing = getMutableStepTrace(session);
  return {
    stepId: `${task.id}:step-${stepIndex}:record-${existing.length + 1}`,
    deviceId: session.id,
    taskInstanceId: task.id,
    stepIndex,
    status: 'PLANNED',
    observation: { currentApp: session.currentApp },
    createdAt: now,
    updatedAt: now,
  };
}

export function appendAgentStepRecord(session: DeviceSession, record: AgentStepRecord): AgentStepRecord {
  const trace = getMutableStepTrace(session);
  const cloned = cloneStepRecord(record);
  trace.push(cloned);
  if (trace.length > 100) trace.splice(0, trace.length - 100);
  return cloned;
}

export function updateAgentStepRecord(session: DeviceSession, stepId: string, updater: (record: AgentStepRecord) => void): AgentStepRecord | null {
  const record = getMutableStepTrace(session).find(item => item.stepId === stepId);
  if (!record) return null;
  updater(record);
  record.updatedAt = Date.now();
  return record;
}

export function getCurrentStepRecord(session: DeviceSession): AgentStepRecord | null {
  return getRecentStepRecords(session, 1)[0] ?? null;
}

export function getRecentStepRecords(session: DeviceSession, limit = 20): AgentStepRecord[] {
  const activeTrace = session.taskContext.stepTrace ?? [];
  const archivedTrace = Array.isArray(session.memory.recentStepTrace) ? session.memory.recentStepTrace as AgentStepRecord[] : [];
  return [...archivedTrace, ...activeTrace].slice(-limit).map(cloneStepRecord);
}

export function archiveStepTrace(session: DeviceSession): void {
  const trace = session.taskContext.stepTrace ?? [];
  if (!trace.length) return;
  const archivedTrace = Array.isArray(session.memory.recentStepTrace) ? session.memory.recentStepTrace as AgentStepRecord[] : [];
  session.memory.recentStepTrace = [...archivedTrace, ...trace].slice(-20).map(cloneStepRecord);
}

export function makeScreenshotArtifactRef(args: {
  screenshot: ScreenshotResult;
  taskInstanceId: string;
  stepId: string;
  purpose: ScreenshotArtifactRef['purpose'];
  retention?: ArtifactRetention;
  hasBinary?: boolean;
  redactionStatus?: ArtifactRedactionStatus;
}): ScreenshotArtifactRef {
  const artifactId = `${args.stepId}:${args.purpose}:${args.screenshot.capturedAt}`;
  return {
    artifactId,
    id: artifactId,
    deviceId: args.screenshot.deviceId,
    taskInstanceId: args.taskInstanceId,
    stepId: args.stepId,
    purpose: args.purpose,
    width: args.screenshot.width,
    height: args.screenshot.height,
    capturedAt: args.screenshot.capturedAt,
    source: 'ON_DEMAND_SCREENSHOT',
    retention: args.retention ?? 'MEMORY_ONLY',
    hasBinary: args.hasBinary ?? false,
    redactionStatus: args.redactionStatus ?? 'NOT_REQUIRED',
  };
}

export function cloneStepRecord(record: AgentStepRecord): AgentStepRecord {
  return JSON.parse(JSON.stringify(record)) as AgentStepRecord;
}

function getMutableStepTrace(session: DeviceSession): AgentStepRecord[] {
  session.taskContext.stepTrace ??= [];
  return session.taskContext.stepTrace;
}
