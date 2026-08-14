import type { AgentActionLog } from './agentActions';
import type { ScreenshotArtifactRef } from './agentStepTrace';
import type { AgentObservation, UiHierarchySummary } from './observationBuilder';

export type AgentArtifactType =
  | 'AI_OBSERVATION_SCREENSHOT'
  | 'POST_ACTION_SCREENSHOT'
  | 'UI_HIERARCHY_SUMMARY'
  | 'PLANNER_REQUEST'
  | 'PLANNER_RESPONSE'
  | 'APPROVAL_DECISION';

export type ArtifactRetention = 'MEMORY_ONLY' | 'LOCAL_FILE' | 'REDACTED_ONLY';
export type ArtifactRedactionStatus = 'NOT_REQUIRED' | 'REDACTED' | 'NOT_REDACTED';

export interface AgentArtifactRecord {
  artifactId: string;
  type: AgentArtifactType;
  deviceId: string;
  taskInstanceId: string;
  stepId: string;
  createdAt: number;
  retention: ArtifactRetention;
  hasBinary: boolean;
  redactionStatus: ArtifactRedactionStatus;
  metadata: Record<string, unknown>;
  redactedPayload?: Record<string, unknown>;
}

export interface AgentArtifactSummary {
  taskInstanceId: string;
  deviceId: string;
  total: number;
  byType: Partial<Record<AgentArtifactType, number>>;
  latestAt: number | null;
}

export class ArtifactStore {
  private readonly records = new Map<string, AgentArtifactRecord[]>();

  add(record: Omit<AgentArtifactRecord, 'artifactId' | 'createdAt'> & { artifactId?: string; createdAt?: number }): AgentArtifactRecord {
    const createdAt = record.createdAt ?? Date.now();
    const artifactId = record.artifactId ?? `${record.taskInstanceId}:${record.stepId}:${record.type}:${createdAt}:${this.sizeForTask(record.deviceId, record.taskInstanceId) + 1}`;
    const stored: AgentArtifactRecord = sanitizeArtifactRecord({ ...record, artifactId, createdAt });
    const key = taskKey(stored.deviceId, stored.taskInstanceId);
    const bucket = this.records.get(key) ?? [];
    bucket.push(stored);
    if (bucket.length > 500) bucket.splice(0, bucket.length - 500);
    this.records.set(key, bucket);
    return cloneArtifact(stored);
  }

  addScreenshot(ref: ScreenshotArtifactRef, type: Extract<AgentArtifactType, 'AI_OBSERVATION_SCREENSHOT' | 'POST_ACTION_SCREENSHOT'>): AgentArtifactRecord {
    return this.add({
      artifactId: ref.artifactId,
      type,
      deviceId: ref.deviceId,
      taskInstanceId: ref.taskInstanceId,
      stepId: ref.stepId,
      retention: ref.retention,
      hasBinary: ref.hasBinary,
      redactionStatus: ref.redactionStatus,
      metadata: {
        purpose: ref.purpose,
        width: ref.width,
        height: ref.height,
        capturedAt: ref.capturedAt,
        source: ref.source,
      },
    });
  }

  addUiHierarchySummary(args: {
    deviceId: string;
    taskInstanceId: string;
    stepId: string;
    phase: 'OBSERVATION' | 'VERIFICATION';
    summary: UiHierarchySummary;
  }): AgentArtifactRecord {
    return this.add({
      type: 'UI_HIERARCHY_SUMMARY',
      deviceId: args.deviceId,
      taskInstanceId: args.taskInstanceId,
      stepId: args.stepId,
      retention: 'REDACTED_ONLY',
      hasBinary: false,
      redactionStatus: 'REDACTED',
      metadata: { phase: args.phase, nodeCount: args.summary.nodeCount, capturedAt: args.summary.capturedAt },
      redactedPayload: { uiHierarchySummary: args.summary },
    });
  }

  addPlannerRequest(args: {
    providerId: string;
    observation: AgentObservation;
    stepId: string;
  }): AgentArtifactRecord {
    return this.add({
      type: 'PLANNER_REQUEST',
      deviceId: args.observation.deviceId,
      taskInstanceId: args.observation.taskInstanceId,
      stepId: args.stepId,
      retention: 'REDACTED_ONLY',
      hasBinary: false,
      redactionStatus: 'REDACTED',
      metadata: {
        providerId: args.providerId,
        currentStep: args.observation.currentStep,
        uiNodes: args.observation.uiHierarchy.nodeCount,
        screenshot: `${args.observation.screenshot.width}x${args.observation.screenshot.height}`,
      },
      redactedPayload: {
        providerId: args.providerId,
        observation: sanitizeArtifactValue(args.observation),
      },
    });
  }

  addPlannerResponse(args: {
    providerId: string;
    deviceId: string;
    taskInstanceId: string;
    stepId: string;
    action?: AgentActionLog;
    error?: string;
  }): AgentArtifactRecord {
    return this.add({
      type: 'PLANNER_RESPONSE',
      deviceId: args.deviceId,
      taskInstanceId: args.taskInstanceId,
      stepId: args.stepId,
      retention: 'REDACTED_ONLY',
      hasBinary: false,
      redactionStatus: 'REDACTED',
      metadata: {
        providerId: args.providerId,
        actionType: typeof args.action?.type === 'string' ? args.action.type : null,
        result: args.error ? 'ERROR' : 'SUCCESS',
      },
      redactedPayload: sanitizeArtifactValue({ action: args.action ?? null, error: args.error ?? null }) as Record<string, unknown>,
    });
  }

  addApprovalDecision(args: {
    deviceId: string;
    taskInstanceId: string;
    stepId: string;
    actionType: string | null;
    decision: 'APPROVED' | 'REJECTED';
    decidedAt: number;
  }): AgentArtifactRecord {
    return this.add({
      type: 'APPROVAL_DECISION',
      deviceId: args.deviceId,
      taskInstanceId: args.taskInstanceId,
      stepId: args.stepId,
      retention: 'REDACTED_ONLY',
      hasBinary: false,
      redactionStatus: 'REDACTED',
      metadata: {
        actionType: args.actionType,
        decision: args.decision,
        decidedAt: args.decidedAt,
      },
      redactedPayload: { decision: args.decision, actionType: args.actionType, decidedAt: args.decidedAt },
    });
  }

  listTaskArtifacts(deviceId: string, taskInstanceId: string, limit = 50): AgentArtifactRecord[] {
    return (this.records.get(taskKey(deviceId, taskInstanceId)) ?? []).slice(-limit).map(cloneArtifact);
  }

  summarizeTask(deviceId: string, taskInstanceId: string): AgentArtifactSummary {
    const records = this.records.get(taskKey(deviceId, taskInstanceId)) ?? [];
    const byType: AgentArtifactSummary['byType'] = {};
    records.forEach(record => { byType[record.type] = (byType[record.type] ?? 0) + 1; });
    return {
      taskInstanceId,
      deviceId,
      total: records.length,
      byType,
      latestAt: records.at(-1)?.createdAt ?? null,
    };
  }

  private sizeForTask(deviceId: string, taskInstanceId: string): number {
    return this.records.get(taskKey(deviceId, taskInstanceId))?.length ?? 0;
  }
}

export function sanitizeArtifactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveString(value);
  if (Array.isArray(value)) return value.map(sanitizeArtifactValue);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    if (key === 'text' && typeof entry === 'string') {
      output.redactedLength = entry.length;
      return;
    }
    output[key] = sanitizeArtifactValue(entry);
  });
  return output;
}

function sanitizeArtifactRecord(record: AgentArtifactRecord): AgentArtifactRecord {
  return {
    ...record,
    metadata: sanitizeArtifactValue(record.metadata) as Record<string, unknown>,
    redactedPayload: record.redactedPayload ? sanitizeArtifactValue(record.redactedPayload) as Record<string, unknown> : undefined,
  };
}

function redactSensitiveString(value: string): string {
  return value
    .replace(/(input\s+text\s*[:：]\s*)([^\n;]+)/giu, '$1[REDACTED_TEXT]')
    .replace(/(shell\s+input\s+text\s+).+$/giu, '$1[REDACTED_TEXT]')
    .replace(/(text=)([^\s]+)/giu, '$1[REDACTED_TEXT]')
    .replace(/(password|secret|token|credential)(\s*[:=]\s*)([^\s;]+)/giu, '$1$2[REDACTED]');
}

function taskKey(deviceId: string, taskInstanceId: string): string {
  return `${deviceId}\u0000${taskInstanceId}`;
}

function cloneArtifact(record: AgentArtifactRecord): AgentArtifactRecord {
  return JSON.parse(JSON.stringify(record)) as AgentArtifactRecord;
}
