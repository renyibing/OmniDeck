import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeviceConfiguration } from '../domain/types';

export interface PersistedDeviceState {
  deviceId: string;
  configuration: DeviceConfiguration;
  autoConnect: boolean;
}

interface PersistedRuntimeStateV1 {
  version: 1;
  updatedAt: number;
  devices: PersistedDeviceState[];
}

export type PersistedRuntimeState = PersistedRuntimeStateV1;

export class RuntimeStateStore {
  constructor(private readonly filePath: string) {}

  load(): PersistedRuntimeState | null {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return null;
      const parsed = JSON.parse(raw) as Partial<PersistedRuntimeState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.devices)) return null;
      return {
        version: 1,
        updatedAt: Number(parsed.updatedAt ?? Date.now()),
        devices: parsed.devices.filter(isPersistedDeviceState),
      };
    } catch {
      return null;
    }
  }

  save(devices: PersistedDeviceState[]): void {
    const payload: PersistedRuntimeState = {
      version: 1,
      updatedAt: Date.now(),
      devices,
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    renameSync(tempPath, this.filePath);
  }
}

function isPersistedDeviceState(value: unknown): value is PersistedDeviceState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedDeviceState>;
  return typeof candidate.deviceId === 'string'
    && typeof candidate.autoConnect === 'boolean'
    && Boolean(candidate.configuration)
    && typeof candidate.configuration?.deviceId === 'string'
    && typeof candidate.configuration?.platform === 'string'
    && typeof candidate.configuration?.identifier === 'string'
    && typeof candidate.configuration?.appId === 'string'
    && typeof candidate.configuration?.transport === 'string'
    && typeof candidate.configuration?.orientation === 'string'
    && typeof candidate.configuration?.driverMode === 'string'
    && typeof candidate.configuration?.configuredAt === 'number';
}
