import type { DeviceManager } from './deviceManager';
import type { Platform } from './types';

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
  simulated: true;
}

/** Simulates host-side discovery without executing ADB, XCUITest, or shell commands. */
export class DeviceDiscovery {
  private readonly candidates: DiscoveredDevice[];

  constructor(private readonly devices: DeviceManager) {
    this.candidates = [
      {
        candidateId: 'candidate-device-01', deviceId: 'device-01', platform: 'ANDROID',
        name: 'Android 01', model: 'Pixel 9 Pro', identifier: 'omni-android-01',
        authorization: 'AUTHORIZED', transport: 'ADB', simulated: true,
      },
      {
        candidateId: 'candidate-device-03', deviceId: 'device-03', platform: 'IOS',
        name: 'iPhone 03', model: 'iPhone 16 Pro', identifier: 'omni-ios-03',
        authorization: 'AUTHORIZED', transport: 'XCUITEST', simulated: true,
      },
    ].filter(candidate => this.devices.get(candidate.deviceId) !== undefined) as DiscoveredDevice[];
  }

  discover(): DiscoveredDevice[] {
    return this.candidates.map(candidate => ({ ...candidate }));
  }

  getByDeviceId(deviceId: string): DiscoveredDevice | undefined {
    return this.candidates.find(candidate => candidate.deviceId === deviceId);
  }
}
