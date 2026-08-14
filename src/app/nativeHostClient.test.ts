import { describe, expect, it } from 'vitest';
import { isNativeHostAvailable, nativeProcessKindsForDevice, shouldLoadNativeProcessLogs } from './nativeHostClient';

describe('native host client helpers', () => {
  it('detects non-Tauri test environment as unavailable', () => {
    expect(isNativeHostAvailable()).toBe(false);
  });

  it('maps selected devices to device-scoped native process kinds', () => {
    expect(nativeProcessKindsForDevice({ id: 'device-01', platform: 'ANDROID' })).toEqual(['SCRCPY']);
    expect(nativeProcessKindsForDevice({ id: 'device-03', platform: 'IOS' })).toEqual(['IPROXY']);
    expect(nativeProcessKindsForDevice(null)).toEqual([]);
  });

  it('loads native process logs only for a selected supported device', () => {
    expect(shouldLoadNativeProcessLogs(true, { id: 'device-01', platform: 'ANDROID' })).toBe(true);
    expect(shouldLoadNativeProcessLogs(true, { id: 'device-03', platform: 'IOS' })).toBe(true);
    expect(shouldLoadNativeProcessLogs(true, null)).toBe(false);
    expect(shouldLoadNativeProcessLogs(false, { id: 'device-01', platform: 'ANDROID' })).toBe(false);
  });
});
