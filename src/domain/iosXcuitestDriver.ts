import type { DeviceHealth, StreamProfile } from './types';
import type { DeviceDriverAdapter, LongPressRequest, MonitorFrame, NormalizedPoint, ScreenshotRequest, ScreenshotResult, ScrollWheelRequest, SwipeRequest, DevicePressKey } from './deviceDriver';
import type { UiHierarchy } from './androidUiHierarchy';
import { parseWdaSourceXml } from './iosUiHierarchy';

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

class RecoverableWdaSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoverableWdaSessionError';
  }
}

/** WDA typing speed in characters per minute. Default 60 is ~1 char/sec and feels laggy. */
const WDA_TYPING_FREQUENCY = 4800;
const VIEWPORT_CACHE_MS = 2500;
const WDA_STATUS_TIMEOUT_MS = 8_000;
const WDA_ACTION_TIMEOUT_MS = 12_000;
const WDA_READ_TIMEOUT_MS = 8_000;

/** WDA HTTP boundary. WDA installation/signing and MJPEG transport stay outside the domain. */
export class IOSXCUITestDriver implements DeviceDriverAdapter {
  readonly platform = 'IOS' as const;
  private readonly request: typeof fetch;
  private readonly wdaUrl: string;
  private connected = false;
  private sessionId: string | null = null;
  private streamProfile: StreamProfile | null = null;
  private viewportCache: { width: number; height: number; expiresAt: number } | null = null;
  private sessionChain: Promise<void> = Promise.resolve();

  constructor(readonly deviceId: string, private readonly options: IOSXCUITestDriverOptions) {
    this.request = options.request ?? fetch;
    this.wdaUrl = normalizeWdaUrl(options.wdaUrl);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const response = await this.requestWda('/status', { signal }, 'status check', WDA_STATUS_TIMEOUT_MS);
    if (!response.ok) throw new Error(`WebDriverAgent status check failed for ${this.deviceId} (${this.options.udid}) at ${this.wdaUrl}/status: HTTP ${response.status}`);
    const sessionResponse = await this.requestWda('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: { firstMatch: [{}], alwaysMatch: {} } }),
      signal,
    }, 'session creation', WDA_STATUS_TIMEOUT_MS);
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
    const devicePoint = toDevicePoint(point, width, height);
    await this.performTap(devicePoint, signal);
  }

  private async performTap(point: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
    try {
      // dragfromtoforduration(duration=0) avoids /wda/tap hanging on busy apps (XCTest idle wait).
      await this.dragFromTo(point, point, 0, signal, WDA_ACTION_TIMEOUT_MS);
    } catch (error) {
      if (!isRecoverableSessionError(error)) throw error;
      await this.recoverSession(signal);
      await this.dragFromTo(point, point, 0, signal, WDA_ACTION_TIMEOUT_MS);
    }
  }

  async getUiHierarchy(signal?: AbortSignal): Promise<UiHierarchy> {
    if (!this.connected) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) is not connected`);
    if (!this.sessionId) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) has no active XCUITest session`);
    const response = await this.requestWda(
      `/session/${encodeURIComponent(this.sessionId)}/source`,
      { signal },
      'ui source',
      WDA_READ_TIMEOUT_MS,
    );
    if (!response.ok) throw new Error(`Unable to read iOS UI source for ${this.deviceId} (${this.options.udid}): HTTP ${response.status}`);
    const payload = await response.json() as { value?: string };
    return parseWdaSourceXml(typeof payload.value === 'string' ? payload.value : '');
  }

  async getScreenSize(signal?: AbortSignal): Promise<{ width: number; height: number }> {
    return this.readViewport(signal);
  }

  async swipe(request: SwipeRequest, signal?: AbortSignal): Promise<void> {
    const { width, height } = await this.readViewport(signal);
    const from = toDevicePoint(request.from, width, height);
    const to = toDevicePoint(request.to, width, height);
    // WDA duration is a pre-drag hold delay, not swipe speed — keep it minimal for flings.
    const durationSec = wdaDragHoldSeconds(request.durationMs);
    await this.dragFromTo(from, to, durationSec, signal);
  }

  async scrollWheel(request: ScrollWheelRequest, signal?: AbortSignal): Promise<void> {
    const { width, height } = await this.readViewport(signal);
    const anchor = toDevicePoint(request.point, width, height);
    const horizontal = Math.abs(request.deltaX) > Math.abs(request.deltaY);
    const wheelUnits = Math.abs(horizontal ? request.deltaX : request.deltaY);
    const magnitude = Math.min(0.45, Math.max(0.12, (wheelUnits / 120) * 0.18));
    const spanX = horizontal ? Math.round(width * magnitude) : 0;
    const spanY = horizontal ? 0 : Math.round(height * magnitude);
    const signX = horizontal ? Math.sign(request.deltaX) : 0;
    const signY = horizontal ? 0 : Math.sign(-request.deltaY);
    await this.dragFromTo(
      anchor,
      {
        x: clampPixel(anchor.x + signX * spanX, width),
        y: clampPixel(anchor.y + signY * spanY, height),
      },
      0,
      signal,
    );
  }

  async longPress(request: LongPressRequest, signal?: AbortSignal): Promise<void> {
    const { width, height } = await this.readViewport(signal);
    const point = toDevicePoint(request.point, width, height);
    const durationSec = Math.max(0.35, Math.min(5, (request.durationMs ?? 650) / 1000));
    await this.command('/wda/touchAndHold', 'POST', {
      x: point.x,
      y: point.y,
      duration: durationSec,
    }, signal);
  }

  async inputText(text: string, signal?: AbortSignal): Promise<void> {
    if (!text) return;
    await this.sendKeys(splitWdaKeys(text), signal);
  }

  async pressKey(key: DevicePressKey, signal?: AbortSignal): Promise<void> {
    if (key === 'Enter') {
      await this.sendKeys(['\n'], signal);
      return;
    }
    if (key === 'Backspace') {
      await this.backspaceFocusedField(signal);
      return;
    }
    if (key === 'Delete') {
      await this.deleteFocusedField(signal);
      return;
    }
    const token = WDA_KEY_UNICODE[key];
    if (!token) throw new Error(`Unsupported key for iOS: ${key}`);
    await this.sendKeys([token], signal);
  }

  async back(signal?: AbortSignal): Promise<void> {
    // iOS has no hardware back key; use the standard left-edge back swipe.
    await this.swipe({ from: { x: 0.02, y: 0.5 }, to: { x: 0.42, y: 0.5 }, durationMs: 280 }, signal);
  }

  async home(signal?: AbortSignal): Promise<void> {
    await this.command('/wda/pressButton', 'POST', { name: 'home' }, signal);
  }

  async launchApp(appId: string, signal?: AbortSignal): Promise<void> {
    await this.command('/wda/apps/launch', 'POST', { bundleId: appId, shouldWaitForQuiescence: false }, signal);
  }
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
            // Disable XCTest idle waits that leave /wda/tap pending on busy apps (Appium waitForIdleTimeout=0).
            waitForIdleTimeout: 0,
            animationCoolOffTimeout: 0,
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
    const now = Date.now();
    if (this.viewportCache && this.viewportCache.expiresAt > now) {
      return { width: this.viewportCache.width, height: this.viewportCache.height };
    }
    if (!this.sessionId) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) has no active XCUITest session`);
    const sessionPrefix = `/session/${encodeURIComponent(this.sessionId)}`;
    const [sizeResponse, orientationResponse] = await Promise.all([
      this.requestWda(`${sessionPrefix}/window/size`, { signal }, 'viewport size'),
      this.requestWda(`${sessionPrefix}/orientation`, { signal }, 'orientation'),
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
    const resolved = orientation.startsWith('LANDSCAPE') && width < height
      ? { width: height, height: width }
      : orientation.startsWith('PORTRAIT') && width > height
        ? { width: height, height: width }
        : { width, height };
    this.viewportCache = { ...resolved, expiresAt: now + VIEWPORT_CACHE_MS };
    return resolved;
  }

  private async dragFromTo(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationSec: number,
    signal?: AbortSignal,
    timeoutMs = WDA_ACTION_TIMEOUT_MS,
  ): Promise<void> {
    await this.command('/wda/dragfromtoforduration', 'POST', {
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      duration: Math.round(durationSec * 1000) / 1000,
    }, signal, timeoutMs);
  }

  private async backspaceFocusedField(signal?: AbortSignal): Promise<void> {
    try {
      await this.sendKeys(['\uE003'], signal);
      return;
    } catch {
      // Fall back to rewriting the active field when WDA rejects the key token.
    }
    try {
      const elementId = await this.readActiveElementId(signal);
      const current = await this.readElementAttribute(elementId, 'value', signal);
      if (!current) {
        await this.sendKeys(['\b'], signal);
        return;
      }
      const next = Array.from(current).slice(0, -1).join('');
      await this.setElementValue(elementId, next, signal);
    } catch {
      await this.sendKeys(['\b'], signal);
    }
  }

  private async deleteFocusedField(signal?: AbortSignal): Promise<void> {
    try {
      const elementId = await this.readActiveElementId(signal);
      const current = await this.readElementAttribute(elementId, 'value', signal);
      if (!current) return;
      const chars = Array.from(current);
      const next = chars.length > 1 ? chars.slice(1).join('') : '';
      await this.setElementValue(elementId, next, signal);
    } catch {
      await this.sendKeys(['\uE017'], signal);
    }
  }

  private async setElementValue(elementId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.command(`/element/${encodeURIComponent(elementId)}/value`, 'POST', {
      value: splitWdaKeys(text),
      frequency: WDA_TYPING_FREQUENCY,
    }, signal);
  }

  private async readElementAttribute(elementId: string, name: string, signal?: AbortSignal): Promise<string> {
    if (!this.sessionId) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) has no active XCUITest session`);
    const response = await this.requestWda(
      `/session/${encodeURIComponent(this.sessionId)}/element/${encodeURIComponent(elementId)}/attribute/${encodeURIComponent(name)}`,
      { signal },
      `attribute ${name}`,
    );
    if (!response.ok) throw new Error(`Unable to read ${name} for ${this.deviceId} (${this.options.udid}): HTTP ${response.status}`);
    const payload = await response.json() as { value?: string | null };
    return typeof payload.value === 'string' ? payload.value : '';
  }

  private async sendKeys(value: string[], signal?: AbortSignal): Promise<void> {
    const body = { value, frequency: WDA_TYPING_FREQUENCY };
    const keyPaths = ['/wda/keys', '/keys'] as const;
    let lastError: unknown = null;
    for (const path of keyPaths) {
      try {
        await this.command(path, 'POST', body, signal);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    try {
      const elementId = await this.readActiveElementId(signal);
      await this.command(`/element/${encodeURIComponent(elementId)}/value`, 'POST', body, signal);
      return;
    } catch (error) {
      lastError = error;
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(`Unable to send keys to ${this.deviceId} (${this.options.udid})`);
  }

  private async readActiveElementId(signal?: AbortSignal): Promise<string> {
    if (!this.sessionId) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) has no active XCUITest session`);
    const response = await this.requestWda(`/session/${encodeURIComponent(this.sessionId)}/element/active`, { signal }, 'active element');
    if (!response.ok) throw new Error(`Unable to read active element for ${this.deviceId} (${this.options.udid}): HTTP ${response.status}`);
    const payload = await response.json() as {
      value?: string | { ELEMENT?: string; 'element-6066-11e4-a52e-4f735466cecf'?: string };
    };
    const value = payload.value;
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      const elementId = value.ELEMENT ?? value['element-6066-11e4-a52e-4f735466cecf'];
      if (elementId) return elementId;
    }
    throw new Error(`Active element id is unavailable for ${this.deviceId} (${this.options.udid})`);
  }

  private async command(path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal, timeoutMs = WDA_ACTION_TIMEOUT_MS): Promise<void> {
    if (!this.connected) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) is not connected`);
    if (!this.sessionId) throw new Error(`iOS device ${this.deviceId} (${this.options.udid}) has no active XCUITest session`);
    const response = await this.requestWda(`/session/${encodeURIComponent(this.sessionId)}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    }, `command ${path}`, timeoutMs);
    if (!response.ok) {
      const detail = await describeWdaErrorResponse(response);
      const message = detail
        ? `XCUITest command failed for ${this.deviceId} (${this.options.udid}): ${path} HTTP ${response.status}: ${detail}`
        : `XCUITest command failed for ${this.deviceId} (${this.options.udid}): ${path} HTTP ${response.status}`;
      if (isRecoverableSessionStatus(response.status)) throw new RecoverableWdaSessionError(message);
      throw new Error(message);
    }
  }

  private async recoverSession(signal?: AbortSignal): Promise<void> {
    this.resetSessionChain();
    const staleSession = this.sessionId;
    this.sessionId = null;
    this.connected = false;
    this.viewportCache = null;
    if (staleSession) {
      try {
        await this.requestWda(
          `/session/${encodeURIComponent(staleSession)}`,
          { method: 'DELETE', signal },
          'session recovery cleanup',
          WDA_STATUS_TIMEOUT_MS,
        );
      } catch {
        // Ignore cleanup failures; connect() creates a fresh session.
      }
    }
    await this.connect(signal);
  }

  private resetSessionChain(): void {
    this.sessionChain = Promise.resolve();
  }

  private async requestWda(path: string, init: RequestInit | undefined, operation: string, timeoutMs = WDA_READ_TIMEOUT_MS): Promise<Response> {
    const url = `${this.wdaUrl}${path}`;
    const execute = async () => {
      const { signal, dispose } = mergeAbortSignals(init?.signal ?? undefined, timeoutMs);
      try {
        return await this.request(url, { ...init, signal });
      } catch (error) {
        if (isTimeoutError(error)) this.resetSessionChain();
        throw new WdaConnectionError({ deviceId: this.deviceId, udid: this.options.udid, url, operation, cause: error });
      } finally {
        dispose();
      }
    };
    if (!path.includes('/session/')) return execute();
    return this.runSessionExclusive(execute);
  }

  /** WDA session endpoints are not safe to hit concurrently on one device. */
  private runSessionExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.sessionChain.then(task, task);
    this.sessionChain = run.then(() => undefined, () => undefined);
    return run;
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

function clampPixel(value: number, max: number): number {
  return Math.min(Math.max(0, max - 1), Math.max(0, value));
}

/** WDA treats duration as pre-drag hold time; keep it near zero for scroll/fling gestures. */
function wdaDragHoldSeconds(durationMs?: number): number {
  if (!durationMs || durationMs <= 200) return 0;
  return Math.min(0.15, durationMs / 1000 * 0.05);
}

function toDevicePoint(point: NormalizedPoint, width: number, height: number): { x: number; y: number } {
  const normalizedX = Math.min(1, Math.max(0, point.x));
  const normalizedY = Math.min(1, Math.max(0, point.y));
  return {
    x: Math.round(normalizedX * Math.max(1, width - 1)),
    y: Math.round(normalizedY * Math.max(1, height - 1)),
  };
}

/** WDA /wda/keys expects an array of single-character strings. */
function splitWdaKeys(text: string): string[] {
  return Array.from(text);
}

/** WebDriver Unicode private-use key codes understood by WDA /wda/keys. */
const WDA_KEY_UNICODE: Record<DevicePressKey, string> = {
  Enter: '\uE007',
  Backspace: '\uE003',
  Delete: '\uE017',
  Tab: '\uE004',
  ArrowUp: '\uE013',
  ArrowDown: '\uE015',
  ArrowLeft: '\uE012',
  ArrowRight: '\uE014',
};

function mergeAbortSignals(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`WDA request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('WDA request aborted'));
  if (signal?.aborted) {
    clearTimeout(timer);
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timed out|timeout|aborted without reason|canceled|cancelled/i.test(error.message);
}

export function describeWdaErrorValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 400);
  if (!value || typeof value !== 'object') return null;
  const record = value as { error?: unknown; message?: unknown };
  const error = typeof record.error === 'string' ? record.error : '';
  const message = typeof record.message === 'string' ? record.message : '';
  const bundle = /returned nil for "([^"]+)"/u.exec(message)?.[1];
  if (bundle || /FBSOpenApplicationErrorDomain Code=4|BSErrorCodeDescription=NotFound/u.test(message)) {
    return bundle ? `app not installed (${bundle})` : 'app not installed';
  }
  const combined = [error, message.replace(/\s+/g, ' ').trim()].filter(Boolean).join(': ');
  return combined ? combined.slice(0, 400) : null;
}

async function describeWdaErrorResponse(response: Response): Promise<string | null> {
  try {
    const payload = await response.json() as { value?: unknown };
    return describeWdaErrorValue(payload.value);
  } catch {
    return null;
  }
}

function isRecoverableSessionStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRecoverableSessionError(error: unknown): boolean {
  if (error instanceof RecoverableWdaSessionError) return true;
  if (!(error instanceof Error)) return false;
  return /invalid session|session does not exist|session expired|unknown command|unhandled endpoint|possibly crashed|bad gateway|timed out/i.test(error.message);
}
