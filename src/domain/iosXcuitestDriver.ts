import type { DeviceHealth } from './types';
import type { DeviceDriverAdapter, ScreenshotRequest, ScreenshotResult } from './deviceDriver';

export interface IOSXCUITestDriverOptions {
  udid: string;
  wdaUrl: string;
  request?: typeof fetch;
}

/** WDA HTTP boundary. WDA installation/signing and MJPEG transport stay outside the domain. */
export class IOSXCUITestDriver implements DeviceDriverAdapter {
  readonly platform = 'IOS' as const;
  private readonly request: typeof fetch;
  private connected = false;

  constructor(readonly deviceId: string, private readonly options: IOSXCUITestDriverOptions) {
    this.request = options.request ?? fetch;
  }

  async connect(): Promise<void> {
    const response = await this.request(`${this.options.wdaUrl}/status`);
    if (!response.ok) throw new Error(`WebDriverAgent unavailable for ${this.options.udid}`);
    this.connected = true;
  }

  async disconnect(): Promise<void> { this.connected = false; }

  async screenshot(request: ScreenshotRequest): Promise<ScreenshotResult> {
    await this.command('/screenshot', 'GET');
    return { ...request, deviceId: this.deviceId, capturedAt: Date.now() };
  }

  async launchApp(appId: string): Promise<void> { await this.command('/wda/apps/launch', 'POST', { bundleId: appId }); }
  async restartApp(appId: string): Promise<void> { await this.command('/wda/apps/terminate', 'POST', { bundleId: appId }); await this.launchApp(appId); }
  async performGoalStep(): Promise<void> { await this.screenshot({ purpose: 'AI', width: 1440, height: 2560 }); }

  async health(): Promise<DeviceHealth> {
    try {
      const response = await this.request(`${this.options.wdaUrl}/status`);
      this.connected = response.ok;
    } catch { this.connected = false; }
    return { state: this.connected ? 'HEALTHY' : 'OFFLINE', lastCheckAt: Date.now(), adbConnected: false, screenResponsive: this.connected, appAlive: this.connected, agentAlive: this.connected };
  }

  private async command(path: string, method: 'GET' | 'POST', body?: unknown): Promise<void> {
    if (!this.connected) throw new Error(`iOS device ${this.options.udid} is not connected`);
    const response = await this.request(`${this.options.wdaUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`XCUITest command failed for ${this.options.udid}: ${path}`);
  }
}
