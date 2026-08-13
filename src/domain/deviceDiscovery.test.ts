import { describe, expect, it, vi } from 'vitest';
import { DeviceDiscovery } from './deviceDiscovery';
import { DeviceManager } from './deviceManager';
import type { ProcessRunner } from './nativeProcess';

describe('host device discovery', () => {
  it('merges a configured Android binding with two devicectl iPhones and preserves configured iOS slots', async () => {
    const devices = new DeviceManager(8);
    devices.configure('device-03', iosConfiguration('device-03', 'ios-udid-x', 'iPhoneX'));
    devices.configure('device-07', iosConfiguration('device-07', 'ios-udid-pro', 'Hoskins iPhone'));
    const runner = {
      run: vi.fn(async ({ command, args }: { command: string; args: string[] }) => {
        if (command === 'adb') return { code: 0, stdout: 'List of devices attached\nandroid-01 device model:M2012K11AC device:alioth\n', stderr: '' };
        expect(args).toEqual(['devicectl', 'list', 'devices', '--json-output', '-']);
        return { code: 0, stdout: JSON.stringify(devicectlPayload()), stderr: '' };
      }),
    } as unknown as ProcessRunner;
    const discovery = new DeviceDiscovery(devices, {
      hostDiscovery: true,
      runner,
      nativeCandidates: [{
        deviceId: 'device-01',
        platform: 'ANDROID',
        identifier: 'android-01',
        driverMode: 'ANDROID_ADB_SCRCPY',
      }],
    });

    const candidates = await discovery.discover();

    expect(candidates).toHaveLength(3);
    expect(candidates.find(candidate => candidate.identifier === 'android-01')).toMatchObject({ deviceId: 'device-01', name: 'alioth' });
    expect(candidates.find(candidate => candidate.identifier === 'ios-udid-x')).toMatchObject({ deviceId: 'device-03', name: 'iPhoneX', model: 'iPhone XR', suggestedWdaUrl: 'http://127.0.0.1:8100' });
    expect(candidates.find(candidate => candidate.identifier === 'ios-udid-pro')).toMatchObject({ deviceId: 'device-07', name: 'Hoskins iPhone', model: 'iPhone 13 Pro', suggestedWdaUrl: 'http://127.0.0.1:8101' });
  });

  it('falls back to xcdevice when devicectl is unavailable', async () => {
    const devices = new DeviceManager(4);
    const runner = {
      run: vi.fn(async ({ args }: { args: string[] }) => args[0] === 'devicectl'
        ? { code: 1, stdout: '', stderr: 'unsupported' }
        : { code: 0, stdout: JSON.stringify([{ simulator: false, available: true, platform: 'com.apple.platform.iphoneos', identifier: 'fallback-udid', name: 'Fallback iPhone', modelName: 'iPhone 12' }]), stderr: '' }),
    } as unknown as ProcessRunner;

    const candidates = await new DeviceDiscovery(devices, { hostDiscovery: true, runner }).discover();

    expect(candidates.find(candidate => candidate.identifier === 'fallback-udid')).toMatchObject({ name: 'Fallback iPhone', authorization: 'AUTHORIZED' });
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: ['xcdevice', 'list'] }));
  });

  it('drops host bindings and static seeds that are not currently attached', async () => {
    const devices = new DeviceManager(8);
    const runner = {
      run: vi.fn(async ({ command, args }: { command: string; args: string[] }) => {
        if (command === 'adb') return { code: 0, stdout: 'List of devices attached\n', stderr: '' };
        if (args[0] === 'devicectl') return { code: 0, stdout: JSON.stringify({ result: { devices: [] } }), stderr: '' };
        return { code: 0, stdout: '[]', stderr: '' };
      }),
    } as unknown as ProcessRunner;
    const discovery = new DeviceDiscovery(devices, {
      hostDiscovery: true,
      runner,
      nativeCandidates: [{
        deviceId: 'device-01',
        platform: 'ANDROID',
        identifier: 'android-01',
        driverMode: 'ANDROID_ADB_SCRCPY',
      }],
    });

    const candidates = await discovery.discover();

    expect(candidates).toHaveLength(0);
  });
});

function iosConfiguration(deviceId: string, identifier: string, name: string) {
  return {
    deviceId,
    platform: 'IOS' as const,
    name,
    identifier,
    appId: 'com.omnideck.market.ios',
    transport: 'XCUITEST' as const,
    orientation: 'PORTRAIT' as const,
    driverMode: 'IOS_XCUITEST' as const,
    wdaUrl: 'http://127.0.0.1:8100',
    configuredAt: Date.now(),
  };
}

function devicectlPayload() {
  const device = (udid: string, name: string, marketingName: string) => ({
    identifier: `core-${udid}`,
    connectionProperties: { pairingState: 'paired' },
    deviceProperties: { name, bootState: 'booted' },
    hardwareProperties: { platform: 'iOS', reality: 'physical', udid, marketingName },
  });
  return { result: { devices: [device('ios-udid-pro', 'Hoskins iPhone', 'iPhone 13 Pro'), device('ios-udid-x', 'iPhoneX', 'iPhone XR')] } };
}
