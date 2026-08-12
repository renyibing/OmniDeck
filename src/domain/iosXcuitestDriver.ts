import type { DeviceHealth, StreamProfile } from './types';
import type { DeviceDriverAdapter, LongPressRequest, MonitorFrame, NormalizedPoint, ScreenshotRequest, ScreenshotResult, SwipeRequest } from './deviceDriver';
import type { UiHierarchy } from './androidUiHierarchy';

export interface IOSXCUITestDriverOptions {
  udid: string;
  wdaUrl: string;
  request?: typeof fetch;
}

export class WdaConnectionError extends Error {
  constructor(readonly details: { deviceId: string; udid: string; url: string; operation: string; cause: unknown }) {
    super(makeWdaConnectionMessage(details), { cause: details.cause });
    this.name = 'WdaConnectionError';
  }
}

/** WDA HTTP boundary. WDA installation/signing and MJPEG transport stay outside the domain. */
export class IOSXCUITestDriver implements DeviceDriverAdapter {
  readonly platform = 'IOS' as const;
  private readonly request: typeof fetch;
  private readonly wdaUrl: string;
  private connected = false;
  private sessionId: string | null = null;
  private streamProfile: StreamProfile | null = null;

  constructor(readonly deviceId: string, private readonly options: IOSXCUITestDriverOptions) {
    this.request = options.request ?? fetch;
    this.wdaUrl = normalizeWdaUrl(options.wdaUrl);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const response = await this.requestWda('/status', { signal }, 'status check');
    if (!response.ok) throw new Error(`WebDriverAgent status check failed for ${this.deviceId} (${this.options.udid}) at ${this.wdaUrl}/status: HTTP ${response.status}`);
    const sessionResponse = await this.requestWda('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: { firstMatch: [{}], alwaysMatch: {} } }),
      signal,
    }, 'session creation');
    if (!sessionResponse.ok) throw new Error(`Unable to create XCUITest session for ${this.deviceId} (${this.options.udid}) at ${this.wdaUrl}/session: HTTP ${sessionResponse.status}`);
    const payload = await sessionResponse.json() as { sessionId?: string; value?: { sessionId?: string } };
    this.sessionId = payload.sessionId ?? payload.value?.sessionId ?? null;
    if (!this.sessionId) throw new Error(`XCUITest session response was empty for ${this.deviceId} (${this.options.udid})`);
    this.connected = true;
    await this.applyPreviewSettings(signal);
  }

  async disconnect(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.requestWda(`/session/${encodeURIComponent(this.sessionId)}`, { method: 'DELETE' }, 'session cleanup');
      } catch {
        // Ignore session cleanup failures; the next connect creates a fresh session.
      }
    }
    this.sessionId = null;
    this.streamProfile = null;
    this.connected = false;
  }

  async screenshot(request: ScreenshotRequest, signal?: AbortSignal): Promise<ScreenshotResult> {
    await this.command('/screenshot', 'GET', undefined, signal);
    return { ...request, deviceId: this.deviceId, capturedAt: Date.now() };
  }

  async monitorFrame(signal?: AbortSignal): Promise<MonitorFrame> {
    if (!this.connected) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) is not connected`);
    const response = await this.requestWda('/screenshot', { signal }, 'preview capture');
    if (!response.ok) throw new Error(`iOS preview capture failed for ${this.deviceId} (${this.options.udid}): HTTP ${response.status}`);
    const payload = await response.json() as { value?: string };
    if (!payload.value) throw new Error(`iOS preview response was empty for ${this.deviceId} (${this.options.udid})`);
    return { deviceId: this.deviceId, capturedAt: Date.now(), contentType: 'image/png', data: Buffer.from(payload.value, 'base64') };
  }

  async applyStreamProfile(profile: StreamProfile): Promise<void> {
    this.streamProfile = profile;
    if (!this.connected || !this.sessionId) return;
    await this.applyPreviewSettings();
  }

  async tap(point: NormalizedPoint, signal?: AbortSignal): Promise<void> {
    const { width, height } = await this.readViewport(signal);
    const normalizedX = Math.min(1, Math.max(0, point.x));
    const normalizedY = Math.min(1, Math.max(0, point.y));
    await this.command('/wda/tap', 'POST', {
      x: Math.round(normalizedX * Math.max(1, width - 1)),
      y: Math.round(normalizedY * Math.max(1, height - 1)),
    }, signal);
  }

  async getUiHierarchy(_signal?: AbortSignal): Promise<UiHierarchy> {
    throw new Error(`iOS UI hierarchy retrieval is not implemented for ${this.deviceId} (${this.options.udid}); use WDA readiness first and add a /source adapter before enabling this action`);
  }

  async getScreenSize(signal?: AbortSignal): Promise<{ width: number; height: number }> {
    return this.readViewport(signal);
  }

  async swipe(_request: SwipeRequest, _signal?: AbortSignal): Promise<void> {
    throw new Error(`iOS swipe is not implemented for ${this.deviceId} (${this.options.udid})`);
  }

  async longPress(_request: LongPressRequest, _signal?: AbortSignal): Promise<void> {
    throw new Error(`iOS long press is not implemented for ${this.deviceId} (${this.options.udid})`);
  }

  async inputText(_text: string, _signal?: AbortSignal): Promise<void> {
    throw new Error(`iOS text input is not implemented for ${this.deviceId} (${this.options.udid})`);
  }

  async back(_signal?: AbortSignal): Promise<void> {
    throw new Error(`iOS back is not implemented for ${this.deviceId} (${this.options.udid})`);
  }

  async home(_signal?: AbortSignal): Promise<void> {
    throw new Error(`iOS home is not implemented for ${this.deviceId} (${this.options.udid})`);
  }

  async launchApp(appId: string, signal?: AbortSignal): Promise<void> { await this.command('/wda/apps/launch', 'POST', { bundleId: appId }, signal); }
  async restartApp(appId: string, signal?: AbortSignal): Promise<void> { await this.command('/wda/apps/terminate', 'POST', { bundleId: appId }, signal); await this.launchApp(appId, signal); }
  async stopApp(appId: string, signal?: AbortSignal): Promise<void> { await this.command('/wda/apps/terminate', 'POST', { bundleId: appId }, signal); }
  async performGoalStep(_goal?: string, signal?: AbortSignal): Promise<void> { await this.screenshot({ purpose: 'AI', width: 1440, height: 2560 }, signal); }

  async health(signal?: AbortSignal): Promise<DeviceHealth> {
    try {
      const response = await this.requestWda('/status', { signal }, 'health check');
      this.connected = response.ok;
    } catch { this.connected = false; }
    return { state: this.connected ? 'HEALTHY' : 'OFFLINE', lastCheckAt: Date.now(), adbConnected: false, screenResponsive: this.connected, appAlive: this.connected, agentAlive: this.connected };
  }

  private async applyPreviewSettings(signal?: AbortSignal): Promise<void> {
    if (!this.sessionId) return;
    const maxSide = this.streamProfile
      ? Math.max(this.streamProfile.width, this.streamProfile.height)
      : 720;
    const scalingFactor = Math.max(10, Math.min(100, Math.round((maxSide / 1280) * 100)));
    const framerate = Math.max(5, Math.min(30, this.streamProfile?.fps ?? 15));
    try {
      await this.requestWda(`/session/${encodeURIComponent(this.sessionId)}/appium/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          settings: {
            // Prefer smaller/faster captures for the monitor wall; AI screenshots stay on /screenshot.
            screenshotQuality: 2,
            mjpegServerFramerate: framerate,
            mjpegScalingFactor: scalingFactor,
            mjpegServerScreenshotQuality: 35,
          },
        }),
        signal,
      }, 'preview settings');
    } catch {
      // Older WDA builds may reject settings; preview still works via /screenshot.
    }
  }

  private async readViewport(signal?: AbortSignal): Promise<{ width: number; height: number }> {
    if (!this.connected) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) is not connected`);
    const [sizeResponse, orientationResponse] = await Promise.all([
      this.requestWda('/window/size', { signal }, 'viewport size'),
      this.requestWda('/orientation', { signal }, 'orientation'),
    ]);
    if (!sizeResponse.ok) throw new Error(`Unable to read viewport size for ${this.deviceId} (${this.options.udid}): HTTP ${sizeResponse.status}`);
    if (!orientationResponse.ok) throw new Error(`Unable to read orientation for ${this.deviceId} (${this.options.udid}): HTTP ${orientationResponse.status}`);
    const sizePayload = await sizeResponse.json() as { value?: { width?: number; height?: number } };
    const orientationPayload = await orientationResponse.json() as { value?: string };
    const width = Number(sizePayload.value?.width ?? 0);
    const height = Number(sizePayload.value?.height ?? 0);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`Viewport size is unavailable for ${this.deviceId} (${this.options.udid})`);
    }
    const orientation = orientationPayload.value ?? 'PORTRAIT';
    if (orientation.startsWith('LANDSCAPE') && width < height) return { width: height, height: width };
    if (orientation.startsWith('PORTRAIT') && width > height) return { width: height, height: width };
    return { width, height };
  }

  private async command(path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<void> {
    if (!this.connected) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) is not connected`);
    if (!this.sessionId) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) has no active XCUITest session`);
    const response = await this.requestWda(`/session/${encodeURIComponent(this.sessionId)}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    }, `command ${path}`);
    if (!response.ok) throw new Error(`XCUITest command failed for ${this.deviceId} (${this.options.udid}): ${path} HTTP ${response.status}`);
  }

  private async requestWda(path: string, init: RequestInit | undefined, operation: string): Promise<Response> {
    const url = `${this.wdaUrl}${path}`;
    try {
      return await this.request(url, init);
    } catch (error) {
      throw new WdaConnectionError({ deviceId: this.deviceId, udid: this.options.udid, url, operation, cause: error });
    }
  }
}

function normalizeWdaUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function makeWdaConnectionMessage(details: { deviceId: string; udid: string; url: string; operation: string; cause: unknown }): string {
  const hint = `WebDriverAgent is unreachable for ${details.deviceId} (${details.udid}) at ${details.url} during ${details.operation}. Start WebDriverAgent for this UDID and its device-specific port tunnel, then retry.`;
  const diagnostic = describeCause(details.cause);
  return diagnostic ? `${hint} Original error: ${diagnostic}.` : hint;
}

function describeCause(cause: unknown): string | null {
  const root = cause instanceof Error ? (cause as Error & { cause?: unknown }).cause : undefined;
  const target = objectCause(root) ?? objectCause(cause);
  const code = target ? stringValue(target.code) : null;
  const address = target ? stringValue(target.address) : null;
  const port = target && (typeof target.port === 'string' || typeof target.port === 'number') ? String(target.port) : null;
  const detail = [code, address && port ? `${address}:${port}` : address ?? port].filter(Boolean).join(' ');
  if (detail) return detail;
  if (cause instanceof Error && cause.message) return cause.message;
  return null;
}

function objectCause(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
