import type { DeviceHealth, DeviceSession, Platform } from './types';

export interface ScreenshotRequest {
  purpose: 'AI' | 'MONITOR';
  width: number;
  height: number;
}

export interface ScreenshotResult extends ScreenshotRequest {
  deviceId: string;
  capturedAt: number;
}

export interface DeviceDriverAdapter {
  readonly deviceId: string;
  readonly platform: Platform;
  connect(signal?: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
  screenshot(request: ScreenshotRequest, signal?: AbortSignal): Promise<ScreenshotResult>;
  launchApp(appId: string, signal?: AbortSignal): Promise<void>;
  restartApp(appId: string, signal?: AbortSignal): Promise<void>;
  performGoalStep(goal: string, signal?: AbortSignal): Promise<void>;
  health(signal?: AbortSignal): Promise<DeviceHealth>;
}

export class DriverRegistry {
  private readonly drivers = new Map<string, DeviceDriverAdapter>();

  register(driver: DeviceDriverAdapter): void {
    if (this.drivers.has(driver.deviceId)) throw new Error(`Driver already registered for ${driver.deviceId}`);
    this.drivers.set(driver.deviceId, driver);
  }

  get(deviceId: string): DeviceDriverAdapter {
    const driver = this.drivers.get(deviceId);
    if (!driver) throw new Error(`No driver registered for ${deviceId}`);
    return driver;
  }
}

export class SimulatedDeviceDriver implements DeviceDriverAdapter {
  readonly deviceId: string;
  readonly platform: Platform;
  private connected: boolean;

  constructor(session: DeviceSession, private readonly latencyMs = 2) {
    this.deviceId = session.id;
    this.platform = session.platform;
    this.connected = session.status === 'ONLINE';
  }

  async connect(signal?: AbortSignal): Promise<void> {
    await this.wait(signal);
    this.connected = true;
  }

  async disconnect(): Promise<void> { this.connected = false; }

  async screenshot(request: ScreenshotRequest, signal?: AbortSignal): Promise<ScreenshotResult> {
    await this.requireConnection(signal);
    return { ...request, deviceId: this.deviceId, capturedAt: Date.now() };
  }

  async launchApp(_appId: string, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async restartApp(_appId: string, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async performGoalStep(_goal: string, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }

  async health(signal?: AbortSignal): Promise<DeviceHealth> {
    await this.wait(signal);
    return {
      state: this.connected ? 'HEALTHY' : 'OFFLINE',
      lastCheckAt: Date.now(),
      adbConnected: this.connected,
      screenResponsive: this.connected,
      appAlive: this.connected,
      agentAlive: this.connected,
    };
  }

  private async requireConnection(signal?: AbortSignal): Promise<void> {
    await this.wait(signal);
    if (!this.connected) throw new Error(`Device ${this.deviceId} is offline`);
  }

  private wait(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(resolve, this.latencyMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }
}
