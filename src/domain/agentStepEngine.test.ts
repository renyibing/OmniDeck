import { describe, expect, it } from 'vitest';
import { parseUiAutomatorXml } from './androidUiHierarchy';
import { NoUiElementMatchError, resolveTapElement } from './agentStepEngine';

const hierarchy = parseUiAutomatorXml(`
<hierarchy rotation="0">
  <node index="0" text="Open" resource-id="com.example:id/open" class="android.widget.TextView" package="com.example" content-desc="Open label" clickable="false" enabled="true" focused="false" bounds="[10,20][110,220]" />
  <node index="1" text="Open" resource-id="com.example:id/open_button" class="android.widget.Button" package="com.example" content-desc="Open button" clickable="true" enabled="true" focused="false" bounds="[20,40][220,240]" />
  <node index="2" text="Offscreen" resource-id="com.example:id/offscreen" class="android.widget.Button" package="com.example" content-desc="Offscreen button" clickable="true" enabled="true" focused="false" bounds="[-100,-100][80,80]" />
</hierarchy>`);

describe('selector-driven tap_element resolution', () => {
  it('resolves text selectors to the best clickable center point', () => {
    const result = resolveTapElement(hierarchy, { width: 1080, height: 2400 }, { text: 'Open', mustBeEnabled: true, mustBeClickable: false });
    expect(result.selectedNode.className).toBe('android.widget.Button');
    expect(result.candidateCount).toBe(2);
    expect(result.point.x).toBeCloseTo(120 / 1079, 4);
    expect(result.point.y).toBeCloseTo(140 / 2399, 4);
  });

  it('resolves resourceId and contentDesc selectors', () => {
    expect(resolveTapElement(hierarchy, { width: 1080, height: 2400 }, { resourceId: 'open_button', mustBeClickable: true, mustBeEnabled: true }).selectedNode.id).toBe('node-2');
    expect(resolveTapElement(hierarchy, { width: 1080, height: 2400 }, { contentDesc: 'Open label', mustBeClickable: false, mustBeEnabled: true }).selectedNode.id).toBe('node-1');
  });

  it('clamps offscreen bounds to the current screen size', () => {
    const result = resolveTapElement(hierarchy, { width: 1080, height: 2400 }, { text: 'Offscreen', mustBeClickable: true, mustBeEnabled: true });
    expect(result.clamped).toBe(true);
    expect(result.point).toEqual({ x: 0, y: 0 });
    expect(result.originalCenter).toEqual({ x: -10, y: -10 });
  });

  it('fails clearly without fixed-coordinate fallback when no element matches', () => {
    expect(() => resolveTapElement(hierarchy, { width: 1080, height: 2400 }, { text: 'Missing', mustBeClickable: false, mustBeEnabled: true })).toThrow(NoUiElementMatchError);
  });
});
