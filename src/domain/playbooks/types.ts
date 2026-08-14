import type { AgentAction } from '../agentActions';
import type { NormalizedPoint } from '../deviceDriver';
import type { AgentObservation } from '../observationBuilder';

export interface FeedScrollPlaybook {
  id: 'douyin.feed_scroll' | 'kuaishou.feed_scroll';
  name: string;
  appId: string;
  iosAppId: string;
  aliases: RegExp;
  swipeFrom: NormalizedPoint;
  swipeTo: NormalizedPoint;
  swipeDurationMs: number;
  dwellMs: number;
  popupText: RegExp;
  defaultCount: number;
  maxCount: number;
}

export interface FeedScrollGoal {
  playbook: FeedScrollPlaybook;
  count: number;
  dwellMs: number;
}

export type PlannerBase = Pick<AgentAction, 'actionId' | 'deviceId' | 'taskInstanceId' | 'source'>;

export type FeedScrollPlanner = (
  observation: AgentObservation,
  base: PlannerBase,
  goal: FeedScrollGoal,
) => AgentAction;
