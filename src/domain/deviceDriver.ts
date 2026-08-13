import type { DeviceHealth, DeviceSession, Platform, StreamProfile } from './types';
import type { UiHierarchy } from './androidUiHierarchy';

export interface ScreenshotRequest {
  purpose: 'AI' | 'MONITOR';
  width: number;
  height: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface SwipeRequest {
  from: NormalizedPoint;
  to: NormalizedPoint;
  durationMs?: number;
}

export interface LongPressRequest {
  point: NormalizedPoint;
  durationMs?: number;
}

/** Mouse wheel delta anchored at a normalized screen point. */
export interface ScrollWheelRequest {
  point: NormalizedPoint;
  deltaX: number;
  deltaY: number;
}

export type DevicePressKey =
  | 'Enter'
  | 'Backspace'
  | 'Delete'
  | 'Tab'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight';

export interface DeviceScreenSize {
  width: number;
  height: number;
}

export interface ScreenshotResult extends ScreenshotRequest {
  deviceId: string;
  capturedAt: number;
}

export interface MonitorFrame {
  deviceId: string;
  capturedAt: number;
  contentType: 'image/png' | 'image/jpeg';
  data: Buffer;
}

export interface DeviceDriverAdapter {
  readonly deviceId: string;
  readonly platform: Platform;
  connect(signal?: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
  screenshot(request: ScreenshotRequest, signal?: AbortSignal): Promise<ScreenshotResult>;
  monitorFrame?(signal?: AbortSignal): Promise<MonitorFrame>;
  getUiHierarchy(signal?: AbortSignal): Promise<UiHierarchy>;
  getScreenSize(signal?: AbortSignal): Promise<DeviceScreenSize>;
  tap(point: NormalizedPoint, signal?: AbortSignal): Promise<void>;
  swipe(request: SwipeRequest, signal?: AbortSignal): Promise<void>;
  scrollWheel?(request: ScrollWheelRequest, signal?: AbortSignal): Promise<void>;
  longPress(request: LongPressRequest, signal?: AbortSignal): Promise<void>;
  inputText(text: string, signal?: AbortSignal): Promise<void>;
  pressKey(key: DevicePressKey, signal?: AbortSignal): Promise<void>;
  back(signal?: AbortSignal): Promise<void>;
  home(signal?: AbortSignal): Promise<void>;
  launchApp(appId: string, signal?: AbortSignal): Promise<void>;
  restartApp(appId: string, signal?: AbortSignal): Promise<void>;
  stopApp(appId: string, signal?: AbortSignal): Promise<void>;
  performGoalStep(goal: string, signal?: AbortSignal): Promise<void>;
  health(signal?: AbortSignal): Promise<DeviceHealth>;
  applyStreamProfile?(profile: StreamProfile): Promise<void> | void;
}

export class DriverRegistry {
  private readonly drivers = new Map<string, DeviceDriverAdapter>();
  private readonly frameCache = new Map<string, { frame: MonitorFrame | null; capturedAt: number; pending: Promise<MonitorFrame> | null }>();

  register(driver: DeviceDriverAdapter): void {
    if (this.drivers.has(driver.deviceId)) throw new Error(`Driver already registered for ${driver.deviceId}`);
    this.drivers.set(driver.deviceId, driver);
  }

  has(deviceId: string): boolean {
    return this.drivers.has(deviceId);
  }

  async replace(driver: DeviceDriverAdapter): Promise<void> {
    const current = this.drivers.get(driver.deviceId);
    if (current) await current.disconnect();
    this.drivers.set(driver.deviceId, driver);
    this.frameCache.delete(driver.deviceId);
  }

  get(deviceId: string): DeviceDriverAdapter {
    const driver = this.drivers.get(deviceId);
    if (!driver) throw new Error(`No driver registered for ${deviceId}`);
    return driver;
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.drivers.values()).map(driver => driver.disconnect()));
  }

  async applyStreamProfile(deviceId: string, profile: StreamProfile): Promise<void> {
    await this.get(deviceId).applyStreamProfile?.(profile);
  }

  async monitorFrame(deviceId: string, signal?: AbortSignal): Promise<MonitorFrame> {
    const driver = this.get(deviceId);
    if (!driver.monitorFrame) throw new Error(`Live preview is not available for ${deviceId}`);
    const current = this.frameCache.get(deviceId) ?? { frame: null, capturedAt: 0, pending: null };
    this.frameCache.set(deviceId, current);
    // Only coalesce in-flight captures. Never serve a stale TTL cache — that capped
    // live preview at ~2 FPS and added hundreds of ms of perceived mirroring lag.
    if (current.pending) return current.pending;
    current.pending = driver.monitorFrame(signal).then(frame => {
      current.frame = frame;
      current.capturedAt = Date.now();
      return frame;
    }).finally(() => { current.pending = null; });
    return current.pending;
  }

  async tap(deviceId: string, point: NormalizedPoint, signal?: AbortSignal): Promise<void> {
    await this.get(deviceId).tap(point, signal);
  }

  async getUiHierarchy(deviceId: string, signal?: AbortSignal): Promise<UiHierarchy> {
    return this.get(deviceId).getUiHierarchy(signal);
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

  async tap(_point: NormalizedPoint, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async swipe(_request: SwipeRequest, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async longPress(_request: LongPressRequest, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async inputText(_text: string, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async pressKey(_key: DevicePressKey, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async back(signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async home(signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async launchApp(_appId: string, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async restartApp(_appId: string, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async stopApp(_appId: string, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }
  async performGoalStep(_goal: string, signal?: AbortSignal): Promise<void> { await this.requireConnection(signal); }

  async getUiHierarchy(signal?: AbortSignal): Promise<UiHierarchy> {
    await this.requireConnection(signal);
    return { capturedAt: Date.now(), root: null, nodes: [] };
  }

  async getScreenSize(signal?: AbortSignal): Promise<DeviceScreenSize> {
    await this.requireConnection(signal);
    return { width: 1080, height: 2400 };
  }

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
