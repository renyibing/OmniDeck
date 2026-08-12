import { describe, expect, it } from 'vitest';
import { findByContentDesc, findByResourceId, findByText, parseUiAutomatorXml } from './androidUiHierarchy';

describe('Android UIAutomator hierarchy parser', () => {
  it('parses bounds, text, resource-id, content-desc, and common state flags', () => {
    const hierarchy = parseUiAutomatorXml(`UI hierchary dumped to: /dev/tty
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" focused="false" bounds="[0,0][1080,2400]">
    <node index="1" text="Open &amp; Check" resource-id="com.example:id/open" class="android.widget.Button" package="com.example" content-desc="Open button" clickable="true" enabled="true" focused="false" bounds="[48,120][360,220]" />
  </node>
</hierarchy>`);

    expect(hierarchy.root?.className).toBe('android.widget.FrameLayout');
    expect(hierarchy.nodes).toHaveLength(2);
    expect(hierarchy.nodes[1]).toMatchObject({
      text: 'Open & Check',
      resourceId: 'com.example:id/open',
      contentDesc: 'Open button',
      className: 'android.widget.Button',
      clickable: true,
      enabled: true,
      focused: false,
      bounds: { left: 48, top: 120, right: 360, bottom: 220, width: 312, height: 100, centerX: 204, centerY: 170 },
    });
    expect(findByText(hierarchy, 'Open & Check')[0].id).toBe(hierarchy.nodes[1].id);
    expect(findByResourceId(hierarchy, 'open')[0].id).toBe(hierarchy.nodes[1].id);
    expect(findByContentDesc(hierarchy, 'Open button')[0].id).toBe(hierarchy.nodes[1].id);
  });

  it('preserves offscreen negative bounds from real UIAutomator dumps', () => {
    const hierarchy = parseUiAutomatorXml(`
<hierarchy rotation="0">
  <node index="0" text="Drawer" resource-id="com.example:id/drawer" class="android.view.ViewGroup" package="com.example" content-desc="Side drawer" clickable="false" enabled="true" focused="false" bounds="[-12,-5][1080,2400]" />
</hierarchy>`);

    expect(hierarchy.nodes[0].bounds).toEqual({
      left: -12,
      top: -5,
      right: 1080,
      bottom: 2400,
      width: 1092,
      height: 2405,
      centerX: 534,
      centerY: 1197.5,
    });
  });
});
