import { describe, expect, it } from 'vitest';
import { parseWdaSourceXml } from './iosUiHierarchy';

const source = `
<XCUIElementTypeApplication name="抖音" bundleId="com.ss.iphone.ugc.Aweme">
  <XCUIElementTypeWindow>
    <XCUIElementTypeAlert name="允许“抖音”使用无线数据？">
      <XCUIElementTypeButton name="无线局域网与蜂窝网络" label="无线局域网与蜂窝网络" enabled="true" visible="true" accessible="true" x="54" y="300" width="280" height="44" />
      <XCUIElementTypeButton name="仅限无线局域网" label="仅限无线局域网" enabled="true" visible="true" accessible="true" x="54" y="350" width="280" height="44" />
      <XCUIElementTypeButton name="不允许" label="不允许" enabled="true" visible="true" accessible="true" x="54" y="400" width="280" height="44" />
    </XCUIElementTypeAlert>
    <XCUIElementTypeButton name="同意并继续" label="同意并继续" enabled="true" visible="true" accessible="true" x="40" y="700" width="310" height="48" />
    <XCUIElementTypeButton name="不同意" label="不同意" enabled="true" visible="true" accessible="true" x="40" y="760" width="310" height="36" />
  </XCUIElementTypeWindow>
</XCUIElementTypeApplication>
`;

describe('parseWdaSourceXml', () => {
  it('extracts visible iOS alert buttons with point-space bounds', () => {
    const hierarchy = parseWdaSourceXml(source);
    const wlanOnly = hierarchy.nodes.find(node => node.text === '仅限无线局域网');
    const agree = hierarchy.nodes.find(node => node.text === '同意并继续');
    expect(wlanOnly).toMatchObject({
      className: 'XCUIElementTypeButton',
      clickable: true,
      enabled: true,
      bounds: { left: 54, top: 350, width: 280, height: 44, centerX: 194, centerY: 372 },
    });
    expect(agree?.clickable).toBe(true);
    expect(hierarchy.nodes[0]?.text).toBe('无线局域网与蜂窝网络');
  });
});
