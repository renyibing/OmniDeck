import type { DeviceManager } from './deviceManager';
import type { DriverMode, Platform } from './types';
import { ProcessRunner } from './nativeProcess';

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
  suggestedWdaUrl?: string;
}

export interface DeviceDiscoveryOptions {
  driverMode?: DriverMode;
  androidDriverMode?: DriverMode;
  iosDriverMode?: DriverMode;
  androidIdentifier?: string;
  iosIdentifier?: string;
  hostDiscovery?: boolean;
  adbPath?: string;
  runner?: ProcessRunner;
  nativeCandidates?: Array<{
    deviceId: string;
    platform: Platform;
    name?: string;
    model?: string;
    identifier: string;
    driverMode: DriverMode;
    simulated?: boolean;
  }>;
}

export class DeviceDiscovery {
  private readonly runner: ProcessRunner;
  private readonly adbPath: string;
  private readonly defaults: DiscoveredDevice[];
  private readonly staticCandidates: DiscoveredDevice[] | null;
  private readonly hostDiscovery: boolean;
  private cached = new Map<string, DiscoveredDevice>();

  constructor(private readonly devices: DeviceManager, options: DeviceDiscoveryOptions = {}) {
    this.runner = options.runner ?? new ProcessRunner();
    this.adbPath = options.adbPath ?? 'adb';
    this.hostDiscovery = options.hostDiscovery === true;
    const androidDriverMode = options.androidDriverMode ?? options.driverMode ?? 'SIMULATED';
    const iosDriverMode = options.iosDriverMode ?? options.driverMode ?? 'SIMULATED';
    this.defaults = [
      {
        candidateId: 'candidate-device-01', deviceId: 'device-01', platform: 'ANDROID',
        name: 'Android 01', model: 'Pixel 9 Pro', identifier: 'omni-android-01',
        authorization: 'AUTHORIZED', transport: 'ADB', simulated: androidDriverMode === 'SIMULATED', driverMode: androidDriverMode,
      },
      {
        candidateId: 'candidate-device-03', deviceId: 'device-03', platform: 'IOS',
        name: 'iPhone 03', model: 'iPhone 16 Pro', identifier: 'omni-ios-03',
        authorization: 'AUTHORIZED', transport: 'XCUITEST', simulated: iosDriverMode === 'SIMULATED', driverMode: iosDriverMode,
        suggestedWdaUrl: this.suggestWdaUrl('device-03'),
      },
    ] as const;
    const seeds = options.nativeCandidates?.length
      ? options.nativeCandidates.map(candidate => ({
        candidateId: `candidate-${candidate.deviceId}`,
        deviceId: candidate.deviceId,
        platform: candidate.platform,
        name: candidate.name ?? (candidate.platform === 'IOS' ? `iPhone ${candidate.deviceId.slice(-2)}` : `Android ${candidate.deviceId.slice(-2)}`),
        model: candidate.model ?? (candidate.platform === 'IOS' ? 'iPhone 16 Pro' : 'Pixel 9 Pro'),
        identifier: candidate.identifier,
        authorization: 'AUTHORIZED' as const,
        transport: candidate.platform === 'ANDROID' ? 'ADB' as const : 'XCUITEST' as const,
        simulated: candidate.simulated ?? (candidate.driverMode === 'SIMULATED'),
        driverMode: candidate.driverMode,
        ...(candidate.platform === 'IOS' ? { suggestedWdaUrl: this.suggestWdaUrl(candidate.deviceId) } : {}),
      }))
      : null;
    this.staticCandidates = seeds?.map(candidate => ({
      ...candidate,
      identifier: candidate.platform === 'ANDROID' ? options.androidIdentifier ?? candidate.identifier : options.iosIdentifier ?? candidate.identifier,
    })).filter(candidate => this.devices.get(candidate.deviceId) !== undefined) as DiscoveredDevice[];
    this.cached = new Map((this.staticCandidates ?? this.defaults).map(candidate => [candidate.deviceId, candidate]));
  }

  async discover(): Promise<DiscoveredDevice[]> {
    if (!this.hostDiscovery) return this.remember(this.staticCandidates?.length ? this.staticCandidates : this.defaults);

    const [android, ios] = await Promise.all([
      this.discoverAndroid(),
      this.discoverIOS(),
    ]);
    const discovered = this.mergeCandidates(this.staticCandidates ?? [], [...android, ...ios]);
    return this.remember(discovered.length ? discovered : this.defaults);
  }

  getByDeviceId(deviceId: string): DiscoveredDevice | undefined {
    return this.cached.get(deviceId);
  }

  private remember(candidates: DiscoveredDevice[]): DiscoveredDevice[] {
    this.cached = new Map(candidates.map(candidate => [candidate.deviceId, candidate]));
    return candidates.map(candidate => ({ ...candidate }));
  }

  private async discoverAndroid(): Promise<DiscoveredDevice[]> {
    try {
      const result = await this.runner.run({ command: this.adbPath, args: ['devices', '-l'], timeoutMs: 5_000 });
      if (result.code !== 0) return [];
      const lines = result.stdout.split('\n').map(line => line.trim()).filter(Boolean).filter(line => !line.startsWith('List of devices attached'));
      const sessions = this.devices.getAll().filter(device => device.platform === 'ANDROID');
      const used = new Set<string>();
      const candidates: DiscoveredDevice[] = [];

      lines.forEach((line, index) => {
        const [serial = '', state = ''] = line.split(/\s+/, 3);
        if (!serial) return;
        const deviceId = this.pickDeviceId('ANDROID', serial, used);
        if (!deviceId || !sessions.some(session => session.id === deviceId)) return;
        const model = decodeToken(line.match(/\bmodel:([^\s]+)/)?.[1]) ?? 'Android Device';
        const name = decodeToken(line.match(/\bdevice:([^\s]+)/)?.[1]) ?? `Android ${String(index + 1).padStart(2, '0')}`;
        candidates.push({
          candidateId: `candidate-${deviceId}`,
          deviceId,
          platform: 'ANDROID',
          name,
          model,
          identifier: serial,
          authorization: mapAndroidAuthorization(state),
          transport: 'ADB',
          simulated: false,
          driverMode: 'ANDROID_ADB_SCRCPY',
        });
      });

      return candidates;
    } catch {
      return [];
    }
  }

  private async discoverIOS(): Promise<DiscoveredDevice[]> {
    const devicectl = await this.discoverIOSWithDevicectl();
    if (devicectl !== null) return devicectl;

    try {
      const result = await this.runner.run({ command: 'xcrun', args: ['xcdevice', 'list'], timeoutMs: 8_000 });
      if (result.code !== 0) return [];
      const payload = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      const used = new Set<string>();
      const candidates: DiscoveredDevice[] = [];

      payload
        .filter(device => device.simulator === false && device.platform === 'com.apple.platform.iphoneos')
        .forEach((device, index) => {
          const identifier = String(device.identifier ?? '');
          if (!identifier) return;
          const deviceId = this.pickDeviceId('IOS', identifier, used);
          if (!deviceId) return;
          candidates.push({
            candidateId: `candidate-${deviceId}`,
            deviceId,
            platform: 'IOS',
            name: String(device.name ?? `iPhone ${String(index + 1).padStart(2, '0')}`),
            model: String(device.modelName ?? 'iPhone'),
            identifier,
            authorization: device.available === true && !device.error ? 'AUTHORIZED' : 'TRUST_REQUIRED',
            transport: 'XCUITEST',
            simulated: false,
            driverMode: 'IOS_XCUITEST',
            suggestedWdaUrl: this.suggestWdaUrl(deviceId),
          });
        });

      return candidates;
    } catch {
      return [];
    }
  }

  private async discoverIOSWithDevicectl(): Promise<DiscoveredDevice[] | null> {
    try {
      const result = await this.runner.run({ command: 'xcrun', args: ['devicectl', 'list', 'devices', '--json-output', '-'], timeoutMs: 8_000 });
      if (result.code !== 0) return null;
      const payload = JSON.parse(result.stdout) as { result?: { devices?: Array<Record<string, unknown>> } };
      if (!Array.isArray(payload.result?.devices)) return null;
      const used = new Set<string>();
      const candidates: DiscoveredDevice[] = [];

      payload.result.devices.forEach((device, index) => {
        const hardware = objectValue(device.hardwareProperties);
        const properties = objectValue(device.deviceProperties);
        const connection = objectValue(device.connectionProperties);
        if (hardware.platform !== 'iOS' || hardware.reality !== 'physical') return;
        const identifier = String(hardware.udid ?? device.identifier ?? '');
        if (!identifier) return;
        const deviceId = this.pickDeviceId('IOS', identifier, used);
        if (!deviceId) return;
        candidates.push({
          candidateId: `candidate-${deviceId}`,
          deviceId,
          platform: 'IOS',
          name: String(properties.name ?? `iPhone ${String(index + 1).padStart(2, '0')}`),
          model: String(hardware.marketingName ?? hardware.productType ?? 'iPhone'),
          identifier,
          authorization: connection.pairingState === 'paired' ? 'AUTHORIZED' : 'TRUST_REQUIRED',
          transport: 'XCUITEST',
          simulated: false,
          driverMode: 'IOS_XCUITEST',
          suggestedWdaUrl: this.suggestWdaUrl(deviceId),
        });
      });

      return candidates;
    } catch {
      return null;
    }
  }

  private mergeCandidates(staticCandidates: DiscoveredDevice[], hostCandidates: DiscoveredDevice[]): DiscoveredDevice[] {
    const hostByIdentity = new Map(hostCandidates.map(candidate => [identityKey(candidate), candidate]));
    const merged = staticCandidates.map(candidate => {
      const detected = hostByIdentity.get(identityKey(candidate));
      if (!detected) return candidate;
      hostByIdentity.delete(identityKey(candidate));
      return {
        ...detected,
        candidateId: candidate.candidateId,
        deviceId: candidate.deviceId,
        driverMode: candidate.driverMode,
        simulated: candidate.simulated,
      };
    });
    return [...merged, ...hostByIdentity.values()];
  }

  private pickDeviceId(platform: Platform, identifier: string, used: Set<string>): string | undefined {
    const remembered = Array.from(this.cached.values()).find(candidate => candidate.platform === platform && candidate.identifier === identifier)?.deviceId;
    if (remembered && !used.has(remembered) && this.devices.get(remembered)) {
      used.add(remembered);
      return remembered;
    }
    const configured = this.devices.getAll().find(device => device.platform === platform && device.configuration?.identifier === identifier)?.id;
    if (configured && !used.has(configured)) {
      used.add(configured);
      return configured;
    }
    const next = this.devices.getAll().find(device => device.platform === platform && !used.has(device.id));
    if (!next) return undefined;
    used.add(next.id);
    return next.id;
  }

  private suggestWdaUrl(deviceId: string): string {
    const iosSlot = this.devices.getAll().filter(device => device.platform === 'IOS').findIndex(device => device.id === deviceId);
    return `http://127.0.0.1:${8100 + Math.max(0, iosSlot)}`;
  }
}

function identityKey(candidate: Pick<DiscoveredDevice, 'platform' | 'identifier'>): string {
  return `${candidate.platform}:${candidate.identifier}`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function decodeToken(value: string | undefined): string | undefined {
  return value?.replace(/_/g, ' ');
}

function mapAndroidAuthorization(state: string): DiscoveryAuthorization {
  if (state === 'device') return 'AUTHORIZED';
  if (state === 'unauthorized') return 'UNAUTHORIZED';
  return 'TRUST_REQUIRED';
}
