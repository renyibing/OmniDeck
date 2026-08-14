import type { AgentElementSelector } from './agentActions';
import type { DeviceScreenSize, NormalizedPoint } from './deviceDriver';
import type { UiElementNode, UiHierarchy } from './androidUiHierarchy';

export interface TapElementResolution {
  point: NormalizedPoint;
  selectedNode: UiElementNode;
  candidateCount: number;
  candidates: Array<Pick<UiElementNode, 'id' | 'text' | 'resourceId' | 'contentDesc' | 'className' | 'clickable' | 'enabled' | 'bounds'>>;
  originalCenter: { x: number; y: number };
  clampedCenter: { x: number; y: number };
  clamped: boolean;
}

export class NoUiElementMatchError extends Error {
  constructor(readonly selector: AgentElementSelector) {
    super(`No UI element matched selector ${JSON.stringify(selector)}`);
  }
}

export function resolveTapElement(hierarchy: UiHierarchy, screenSize: DeviceScreenSize, selector: AgentElementSelector): TapElementResolution {
  const candidates = hierarchy.nodes.filter(node => matchesSelector(node, selector));
  if (!candidates.length) throw new NoUiElementMatchError(selector);
  const selectedNode = [...candidates].sort(rankCandidate)[0];
  const originalCenter = { x: selectedNode.bounds.centerX, y: selectedNode.bounds.centerY };
  const maxX = Math.max(0, screenSize.width - 1);
  const maxY = Math.max(0, screenSize.height - 1);
  const clampedCenter = {
    x: clamp(originalCenter.x, 0, maxX),
    y: clamp(originalCenter.y, 0, maxY),
  };
  return {
    point: {
      x: maxX === 0 ? 0 : clampedCenter.x / maxX,
      y: maxY === 0 ? 0 : clampedCenter.y / maxY,
    },
    selectedNode,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 8).map(node => ({
      id: node.id,
      text: node.text,
      resourceId: node.resourceId,
      contentDesc: node.contentDesc,
      className: node.className,
      clickable: node.clickable,
      enabled: node.enabled,
      bounds: node.bounds,
    })),
    originalCenter,
    clampedCenter,
    clamped: originalCenter.x !== clampedCenter.x || originalCenter.y !== clampedCenter.y,
  };
}

function matchesSelector(node: UiElementNode, selector: AgentElementSelector): boolean {
  if (selector.text && node.text !== selector.text) return false;
  if (selector.resourceId && node.resourceId !== selector.resourceId && !node.resourceId.endsWith(`:id/${selector.resourceId}`)) return false;
  if (selector.contentDesc && node.contentDesc !== selector.contentDesc) return false;
  if (selector.className && node.className !== selector.className) return false;
  if (selector.mustBeClickable && !node.clickable) return false;
  if (selector.mustBeEnabled && !node.enabled) return false;
  return true;
}

function rankCandidate(left: UiElementNode, right: UiElementNode): number {
  return scoreCandidate(right) - scoreCandidate(left);
}

function scoreCandidate(node: UiElementNode): number {
  const visible = node.bounds.width > 0 && node.bounds.height > 0;
  const area = Math.min(1_000_000, node.bounds.width * node.bounds.height) / 1_000_000;
  return (node.enabled ? 100 : 0) + (node.clickable ? 50 : 0) + (visible ? 25 : 0) + area;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
