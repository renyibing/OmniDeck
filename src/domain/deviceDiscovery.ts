import type { DeviceManager } from './deviceManager';
import type { DriverMode, Platform } from './types';

export type DiscoveryAuthorization = 'AUTHORIZED' | 'TRUST_REQUIRED' | 'UNAUTHORIZED';
export type DiscoveryTransport = 'ADB' | 'XCUITEST';

export interface DiscoveredDevice {
  candidateId: string;
  deviceId: string;
  platform: Platform;
  name: string;
  model: string;
  identifier: string;
  authorization: DiscoveryAuthorization;
  transport: DiscoveryTransport;
  simulated: boolean;
  driverMode: DriverMode;
}

export interface DeviceDiscoveryOptions {
  driverMode?: DriverMode;
  androidDriverMode?: DriverMode;
  iosDriverMode?: DriverMode;
  androidIdentifier?: string;
  iosIdentifier?: string;
}

/** Simulates host-side discovery without executing ADB, XCUITest, or shell commands. */
export class DeviceDiscovery {
  private readonly candidates: DiscoveredDevice[];

  constructor(private readonly devices: DeviceManager, options: DeviceDiscoveryOptions = {}) {
    const androidDriverMode = options.androidDriverMode ?? options.driverMode ?? 'SIMULATED';
    const iosDriverMode = options.iosDriverMode ?? options.driverMode ?? 'SIMULATED';
    this.candidates = [
      {
        candidateId: 'candidate-device-01', deviceId: 'device-01', platform: 'ANDROID',
        name: 'Android 01', model: 'Pixel 9 Pro', identifier: 'omni-android-01',
        authorization: 'AUTHORIZED', transport: 'ADB', simulated: androidDriverMode === 'SIMULATED', driverMode: androidDriverMode,
      },
      {
        candidateId: 'candidate-device-03', deviceId: 'device-03', platform: 'IOS',
        name: 'iPhone 03', model: 'iPhone 16 Pro', identifier: 'omni-ios-03',
        authorization: 'AUTHORIZED', transport: 'XCUITEST', simulated: iosDriverMode === 'SIMULATED', driverMode: iosDriverMode,
      },
    ].map(candidate => ({
      ...candidate,
      identifier: candidate.platform === 'ANDROID' ? options.androidIdentifier ?? candidate.identifier : options.iosIdentifier ?? candidate.identifier,
    })).filter(candidate => this.devices.get(candidate.deviceId) !== undefined) as DiscoveredDevice[];
  }

  discover(): DiscoveredDevice[] {
    return this.candidates.map(candidate => ({ ...candidate }));
  }

  getByDeviceId(deviceId: string): DiscoveredDevice | undefined {
    return this.candidates.find(candidate => candidate.deviceId === deviceId);
  }
}
