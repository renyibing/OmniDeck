import type { DeviceHealth, StreamProfile } from './types';
import type { DeviceDriverAdapter, LongPressRequest, MonitorFrame, NormalizedPoint, ScreenshotRequest, ScreenshotResult, SwipeRequest, DevicePressKey } from './deviceDriver';
import { parseUiAutomatorXml, type UiHierarchy } from './androidUiHierarchy';
import { NativeToolError, ProcessRunner } from './nativeProcess';
import { encodeRgbaPng } from './pngEncoder';

export interface AndroidDriverOptions {
  serial: string;
  adbPath?: string;
  scrcpyPath?: string;
  streamProcessEnabled?: boolean;
  runner?: ProcessRunner;
}

/** Real Android adapter. Every command carries the configured serial. */
export class AndroidAdbScrcpyDriver implements DeviceDriverAdapter {
  readonly platform = 'ANDROID' as const;
  private readonly runner: ProcessRunner;
  private readonly adbPath: string;
  private readonly scrcpyPath: string;
  private connected = false;
  private scrcpyProcess: ReturnType<ProcessRunner['spawn']> | null = null;
  private streamSignature = '';
  private streamProfile: StreamProfile | null = null;
  private displaySize: { width: number; height: number } | null = null;
  private uiDumpUnavailable = false;

  constructor(readonly deviceId: string, private readonly options: AndroidDriverOptions) {
    this.runner = options.runner ?? new ProcessRunner();
    this.adbPath = options.adbPath ?? 'adb';
    this.scrcpyPath = options.scrcpyPath ?? 'scrcpy';
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const result = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, 'get-state'], signal });
    if (result.code !== 0 || result.stdout.trim() !== 'device') throw new NativeToolError(`Android device ${this.deviceId} (${this.options.serial}) is not authorized`, `${this.adbPath} -s ${this.options.serial} get-state`, result.stderr);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.scrcpyProcess?.kill('SIGTERM');
    this.scrcpyProcess = null;
    this.streamSignature = '';
    this.streamProfile = null;
    this.displaySize = null;
    this.connected = false;
  }

  async screenshot(request: ScreenshotRequest, signal?: AbortSignal): Promise<ScreenshotResult> {
    this.requireConnected();
    const result = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, 'exec-out', 'screencap', '-p'], signal });
    if (result.code !== 0) throw this.adbError('Screenshot failed', ['exec-out', 'screencap', '-p'], result.stderr);
    return { ...request, deviceId: this.deviceId, capturedAt: Date.now() };
  }

  async monitorFrame(signal?: AbortSignal): Promise<MonitorFrame> {
    this.requireConnected();
    const result = await this.runner.runBinary({ command: this.adbPath, args: ['-s', this.options.serial, 'exec-out', 'screencap'], signal, timeoutMs: 8_000 });
    if (result.code !== 0 || result.stdout.length < 16) throw this.adbError('Preview capture failed', ['exec-out', 'screencap'], result.stderr);
    const width = result.stdout.readUInt32LE(0);
    const height = result.stdout.readUInt32LE(4);
    const pixelFormat = result.stdout.readUInt32LE(8);
    const headerSize = 16;
    const expectedBytes = width * height * 4;
    if (pixelFormat !== 1 || result.stdout.length < headerSize + expectedBytes) throw this.adbError('Preview capture failed', ['exec-out', 'screencap'], result.stderr);
    const maxDimension = this.streamProfile
      ? Math.max(this.streamProfile.width, this.streamProfile.height)
      : 720;
    return {
      deviceId: this.deviceId,
      capturedAt: Date.now(),
      contentType: 'image/png',
      data: encodeRgbaPng(width, height, result.stdout.subarray(headerSize, headerSize + expectedBytes), maxDimension),
    };
  }

  async getUiHierarchy(signal?: AbortSignal): Promise<UiHierarchy> {
    this.requireConnected();
    if (this.uiDumpUnavailable) return emptyUiHierarchy();
    const dumpTimeoutMs = 2_500;
    const primaryArgs = ['exec-out', 'uiautomator', 'dump', '/dev/tty'];
    const primary = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, ...primaryArgs], signal, timeoutMs: dumpTimeoutMs });
    if (primary.code === 0) {
      const hierarchy = parseUiAutomatorXml(primary.stdout, Date.now());
      if (hierarchy.nodes.length) return hierarchy;
    }
    if (primary.code !== 0 || isMiuiThemeDumpFailure(primary.stderr, primary.stdout)) {
      this.uiDumpUnavailable = true;
      return emptyUiHierarchy();
    }

    const fallbackPath = `/sdcard/omnideck-ui-${Date.now()}.xml`;
    const dumpArgs = ['shell', 'uiautomator', 'dump', fallbackPath];
    const dump = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, ...dumpArgs], signal, timeoutMs: dumpTimeoutMs });
    if (dump.code !== 0) {
      this.uiDumpUnavailable = true;
      return emptyUiHierarchy();
    }
    const catArgs = ['exec-out', 'cat', fallbackPath];
    const cat = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, ...catArgs], signal, timeoutMs: dumpTimeoutMs });
    void this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, 'shell', 'rm', '-f', fallbackPath], signal, timeoutMs: 5_000 }).catch(() => undefined);
    if (cat.code !== 0) {
      this.uiDumpUnavailable = true;
      return emptyUiHierarchy();
    }
    const hierarchy = parseUiAutomatorXml(cat.stdout, Date.now());
    if (!hierarchy.nodes.length) {
      this.uiDumpUnavailable = true;
      return emptyUiHierarchy();
    }
    return hierarchy;
  }

  async getScreenSize(signal?: AbortSignal): Promise<{ width: number; height: number }> {
    const physicalSize = await this.getDisplaySize(signal);
    const orientation = await this.readOrientation(signal);
    return orientation % 2 === 0 ? physicalSize : { width: physicalSize.height, height: physicalSize.width };
  }

  async tap(point: NormalizedPoint, signal?: AbortSignal): Promise<void> {
    this.requireConnected();
    const { x, y } = await this.resolvePoint(point, signal);
    await this.shell(['input', 'tap', String(x), String(y)], signal);
  }

  async swipe(request: SwipeRequest, signal?: AbortSignal): Promise<void> {
    this.requireConnected();
    const from = await this.resolvePoint(request.from, signal);
    const to = await this.resolvePoint(request.to, signal);
    const duration = Math.min(5_000, Math.max(0, Math.round(request.durationMs ?? 350)));
    await this.shell(['input', 'swipe', String(from.x), String(from.y), String(to.x), String(to.y), String(duration)], signal);
  }

  async longPress(request: LongPressRequest, signal?: AbortSignal): Promise<void> {
    this.requireConnected();
    const point = await this.resolvePoint(request.point, signal);
    const duration = Math.min(5_000, Math.max(350, Math.round(request.durationMs ?? 650)));
    await this.shell(['input', 'swipe', String(point.x), String(point.y), String(point.x), String(point.y), String(duration)], signal);
  }

  async inputText(text: string, signal?: AbortSignal): Promise<void> {
    this.requireConnected();
    const encoded = encodeAdbInputText(asciiFallbackInput(text));
    if (!encoded) throw new Error(`ADB input text is empty after encoding for ${this.deviceId}`);
    // Android `input text` appends; clear the focused field first so search replaces prior queries.
    await this.shell(['input', 'keyevent', ...Array.from({ length: 24 }, () => 'KEYCODE_DEL')], signal);
    await this.shell(['input', 'text', encoded], signal);
  }

  async pressKey(key: DevicePressKey, signal?: AbortSignal): Promise<void> {
    this.requireConnected();
    const code = ANDROID_KEYCODES[key];
    if (!code) throw new Error(`Unsupported key for Android: ${key}`);
    await this.shell(['input', 'keyevent', code], signal);
  }

  async back(signal?: AbortSignal): Promise<void> { await this.shell(['input', 'keyevent', 'KEYCODE_BACK'], signal); }
  async home(signal?: AbortSignal): Promise<void> { await this.shell(['input', 'keyevent', 'KEYCODE_HOME'], signal); }

  async launchApp(appId: string, signal?: AbortSignal): Promise<void> { await this.shell(['monkey', '-p', appId, '1'], signal); }
  async restartApp(appId: string, signal?: AbortSignal): Promise<void> { await this.shell(['am', 'force-stop', appId], signal); await this.launchApp(appId, signal); }
  async stopApp(appId: string, signal?: AbortSignal): Promise<void> { await this.shell(['am', 'force-stop', appId], signal); }
  async performGoalStep(_goal: string, signal?: AbortSignal): Promise<void> { this.requireConnected(); await this.screenshot({ purpose: 'AI', width: 1440, height: 2560 }, signal); }

  async health(signal?: AbortSignal): Promise<DeviceHealth> {
    const result = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, 'get-state'], signal });
    const healthy = result.code === 0 && result.stdout.trim() === 'device';
    this.connected = healthy;
    return { state: healthy ? 'HEALTHY' : 'OFFLINE', lastCheckAt: Date.now(), adbConnected: healthy, screenResponsive: healthy, appAlive: healthy, agentAlive: healthy };
  }

  applyStreamProfile(profile: StreamProfile): void {
    this.requireConnected();
    this.streamProfile = profile;
    // Browser preview uses scrcpy-server H.264 via ScrcpyVideoRegistry; avoid spawning a desktop window.
    if (this.options.streamProcessEnabled !== true) return;
    const signature = JSON.stringify(profile);
    if (this.scrcpyProcess && this.streamSignature === signature) return;
    this.scrcpyProcess?.kill('SIGTERM');
    this.streamSignature = signature;
    this.scrcpyProcess = this.runner.spawn({
      command: this.scrcpyPath,
      args: ['-s', this.options.serial, '--no-audio', '--no-control', '--max-size', String(Math.max(profile.width, profile.height)), '--max-fps', String(profile.fps), '--video-bit-rate', `${profile.bitrateKbps}K`],
    });
    const process = this.scrcpyProcess;
    process.once('error', () => {
      if (this.scrcpyProcess === process) {
        this.scrcpyProcess = null;
        this.streamSignature = '';
      }
    });
    process.once('close', () => {
      if (this.scrcpyProcess === process) {
        this.scrcpyProcess = null;
        this.streamSignature = '';
      }
    });
  }

  private async shell(args: string[], signal?: AbortSignal): Promise<void> {
    this.requireConnected();
    const result = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, 'shell', ...args], signal });
    if (result.code !== 0) throw this.adbError('ADB shell command failed', ['shell', ...args], result.stderr);
  }

  private async resolvePoint(point: NormalizedPoint, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    const { width, height } = await this.getScreenSize(signal);
    const normalizedX = Math.min(1, Math.max(0, point.x));
    const normalizedY = Math.min(1, Math.max(0, point.y));
    return {
      x: Math.round(normalizedX * Math.max(1, width - 1)),
      y: Math.round(normalizedY * Math.max(1, height - 1)),
    };
  }

  private async readOrientation(signal?: AbortSignal): Promise<number> {
    const result = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, 'shell', 'dumpsys', 'input'], signal, timeoutMs: 5_000 });
    if (result.code !== 0) throw this.adbError('Unable to read display orientation', ['shell', 'dumpsys', 'input'], result.stderr);
    return Number(result.stdout.match(/SurfaceOrientation[:=]\s*(\d)/)?.[1] ?? 0);
  }

  private async getDisplaySize(signal?: AbortSignal): Promise<{ width: number; height: number }> {
    if (this.displaySize) return this.displaySize;
    const result = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, 'shell', 'wm', 'size'], signal, timeoutMs: 5_000 });
    if (result.code !== 0) throw this.adbError('Unable to read display size', ['shell', 'wm', 'size'], result.stderr);
    const match = result.stdout.match(/(\d+)\s*x\s*(\d+)/g)?.at(-1)?.match(/(\d+)\s*x\s*(\d+)/);
    if (!match) throw this.adbError('Unable to parse display size', ['shell', 'wm', 'size'], result.stdout);
    this.displaySize = { width: Number(match[1]), height: Number(match[2]) };
    return this.displaySize;
  }

  private adbError(message: string, args: string[], stderr: string): NativeToolError {
    return new NativeToolError(`${message} for ${this.deviceId} (${this.options.serial})`, `${this.adbPath} -s ${this.options.serial} ${args.join(' ')}`, stderr);
  }

  private requireConnected(): void { if (!this.connected) throw new NativeToolError(`Android device ${this.deviceId} (${this.options.serial}) is not connected`, `${this.adbPath} -s ${this.options.serial}`); }
}

function emptyUiHierarchy(): UiHierarchy {
  return { capturedAt: Date.now(), root: null, nodes: [] };
}

function isMiuiThemeDumpFailure(...parts: Array<string | undefined>): boolean {
  return parts.some(part => /theme_compatibility\.xml/i.test(part ?? ''));
}

export function asciiFallbackInput(text: string): string {
  if (/^[\x20-\x7e]+$/u.test(text)) return text;
  const ascii = text.replace(/[^\x20-\x7e]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return ascii || text;
}

export function encodeAdbInputText(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\s/g, '%s')
    .replace(/([&<>;|()*~"'`$])/g, '\\$1');
}

const ANDROID_KEYCODES: Record<DevicePressKey, string> = {
  Enter: 'KEYCODE_ENTER',
  Backspace: 'KEYCODE_DEL',
  Delete: 'KEYCODE_FORWARD_DEL',
  Tab: 'KEYCODE_TAB',
  ArrowUp: 'KEYCODE_DPAD_UP',
  ArrowDown: 'KEYCODE_DPAD_DOWN',
  ArrowLeft: 'KEYCODE_DPAD_LEFT',
  ArrowRight: 'KEYCODE_DPAD_RIGHT',
};
