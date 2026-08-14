import type { AgentActionLog } from './agentActions';
import type { ScreenshotResult } from './deviceDriver';
import type { UiBounds, UiHierarchy } from './androidUiHierarchy';
import type { DeviceSession, Platform, TaskInstance, TimelineEvent } from './types';
import type { AgentStepRecord } from './agentStepTrace';
import { getCurrentStepRecord, getRecentStepRecords } from './agentStepTrace';

export interface UiNodeSummary {
  id: string;
  text: string;
  resourceId: string;
  contentDesc: string;
  className: string;
  bounds: UiBounds;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
}

export interface UiHierarchySummary {
  capturedAt: number | null;
  nodeCount: number;
  actionableNodes: UiNodeSummary[];
}

export interface ScreenshotMetadata {
  purpose: 'AI';
  source: 'ON_DEMAND_SCREENSHOT';
  width: number;
  height: number;
  capturedAt: number;
}

export interface AgentObservation {
  deviceId: string;
  platform: Platform;
  currentApp: string;
  taskInstanceId: string;
  goal: string;
  currentStep: number;
  approvalGranted: boolean;
  screenshot: ScreenshotMetadata;
  uiHierarchy: UiHierarchySummary;
  lastActionResult: string | null;
  actionHistory: TimelineEvent[];
}

export interface AgentStateSnapshot {
  deviceId: string;
  taskInstanceId: string | null;
  status: TaskInstance['status'] | 'IDLE';
  currentStep: number;
  pendingApproval: AgentActionLog | null;
  lastPlannedAction: AgentActionLog | null;
  lastObservation: Pick<AgentObservation, 'deviceId' | 'platform' | 'currentApp' | 'taskInstanceId' | 'goal' | 'currentStep' | 'screenshot' | 'uiHierarchy' | 'lastActionResult'> | null;
  currentStepRecord: AgentStepRecord | null;
  recentStepRecords: AgentStepRecord[];
  lastVerification: AgentStepRecord['verification'] | null;
  approval: AgentStepRecord['approval'] | null;
  stepTimeline: TimelineEvent[];
}

export function buildAgentObservation(args: {
  session: DeviceSession;
  task: TaskInstance;
  screenshot: ScreenshotResult;
  hierarchy: UiHierarchy | null;
  historyLimit?: number;
}): AgentObservation {
  const historyLimit = args.historyLimit ?? 40;
  const actionHistory = args.session.actionHistory.slice(-historyLimit).map(event => ({ ...event, message: sanitizeTimelineMessage(event.message) }));
  return {
    deviceId: args.session.id,
    platform: args.session.platform,
    currentApp: args.session.currentApp,
    taskInstanceId: args.task.id,
    goal: args.task.goal,
    currentStep: args.session.taskContext.step ?? 0,
    approvalGranted: args.session.taskContext.variables.approvalGranted === true,
    screenshot: {
      purpose: 'AI',
      source: 'ON_DEMAND_SCREENSHOT',
      width: args.screenshot.width,
      height: args.screenshot.height,
      capturedAt: args.screenshot.capturedAt,
    },
    uiHierarchy: summarizeUiHierarchy(args.hierarchy),
    lastActionResult: latestActionResult(args.session.actionHistory),
    actionHistory,
  };
}

export function summarizeUiHierarchy(hierarchy: UiHierarchy | null, limit = 24): UiHierarchySummary {
  if (!hierarchy) return { capturedAt: null, nodeCount: 0, actionableNodes: [] };
  const meaningful = hierarchy.nodes
    .filter(node => node.text || node.resourceId || node.contentDesc || node.clickable || node.focused)
    .slice(0, limit)
    .map(node => ({
      id: node.id,
      text: node.text,
      resourceId: node.resourceId,
      contentDesc: node.contentDesc,
      className: node.className,
      bounds: node.bounds,
      clickable: node.clickable,
      enabled: node.enabled,
      focused: node.focused,
    }));
  return { capturedAt: hierarchy.capturedAt, nodeCount: hierarchy.nodes.length, actionableNodes: meaningful };
}

export function buildAgentStateSnapshot(session: DeviceSession): AgentStateSnapshot {
  const pendingApproval = session.taskContext.variables.pendingApproval as AgentActionLog | undefined;
  const lastPlannedAction = session.taskContext.variables.lastPlannedAction as AgentActionLog | undefined;
  const lastObservation = session.taskContext.variables.lastObservationSummary as AgentStateSnapshot['lastObservation'] | undefined;
  const recentStepRecords = getRecentStepRecords(session, 20);
  const currentStepRecord = getCurrentStepRecord(session);
  const lastVerification = [...recentStepRecords].reverse().find(record => record.verification)?.verification ?? null;
  const approval = currentStepRecord?.approval ?? null;
  return {
    deviceId: session.id,
    taskInstanceId: session.currentTask?.id ?? null,
    status: session.currentTask?.status ?? 'IDLE',
    currentStep: session.taskContext.step ?? 0,
    pendingApproval: pendingApproval ?? null,
    lastPlannedAction: lastPlannedAction ?? null,
    lastObservation: lastObservation ?? null,
    currentStepRecord,
    recentStepRecords,
    lastVerification,
    approval,
    stepTimeline: session.actionHistory.slice(-20).map(event => ({ ...event, message: sanitizeTimelineMessage(event.message) })),
  };
}

export function observationForState(observation: AgentObservation): AgentStateSnapshot['lastObservation'] {
  return {
    deviceId: observation.deviceId,
    platform: observation.platform,
    currentApp: observation.currentApp,
    taskInstanceId: observation.taskInstanceId,
    goal: observation.goal,
    currentStep: observation.currentStep,
    screenshot: observation.screenshot,
    uiHierarchy: observation.uiHierarchy,
    lastActionResult: observation.lastActionResult,
  };
}

function latestActionResult(history: TimelineEvent[]): string | null {
  const latest = [...history].reverse().find(event => event.kind === 'ACTION');
  return latest ? sanitizeTimelineMessage(latest.message).slice(0, 500) : null;
}

function sanitizeTimelineMessage(message: string): string {
  return message
    .replace(/(input_text[^\n]*?text=)[^\s]+/igu, '$1[REDACTED_TEXT]')
    .replace(/(shell\s+input\s+text\s+).+$/igu, '$1[REDACTED_TEXT]')
    .replace(/(input\s+text\s+).+$/igu, '$1[REDACTED_TEXT]');
}
