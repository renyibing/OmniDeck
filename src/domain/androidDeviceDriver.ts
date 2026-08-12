import type { DeviceHealth, StreamProfile } from './types';
import type { DeviceDriverAdapter, ScreenshotRequest, ScreenshotResult } from './deviceDriver';
import { NativeToolError, ProcessRunner } from './nativeProcess';

export interface AndroidDriverOptions {
  serial: string;
  adbPath?: string;
  scrcpyPath?: string;
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

  constructor(readonly deviceId: string, private readonly options: AndroidDriverOptions) {
    this.runner = options.runner ?? new ProcessRunner();
    this.adbPath = options.adbPath ?? 'adb';
    this.scrcpyPath = options.scrcpyPath ?? 'scrcpy';
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const result = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, 'get-state'], signal });
    if (result.code !== 0 || result.stdout.trim() !== 'device') throw new NativeToolError(`Android device ${this.options.serial} is not authorized`, `${this.adbPath} -s ${this.options.serial} get-state`, result.stderr);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.scrcpyProcess?.kill('SIGTERM');
    this.scrcpyProcess = null;
    this.streamSignature = '';
    this.connected = false;
  }

  async screenshot(request: ScreenshotRequest, signal?: AbortSignal): Promise<ScreenshotResult> {
    this.requireConnected();
    const result = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, 'exec-out', 'screencap', '-p'], signal });
    if (result.code !== 0) throw new NativeToolError(`Screenshot failed for ${this.deviceId}`, `${this.adbPath} -s ${this.options.serial} exec-out screencap -p`, result.stderr);
    return { ...request, deviceId: this.deviceId, capturedAt: Date.now() };
  }

  async launchApp(appId: string, signal?: AbortSignal): Promise<void> { await this.shell(['monkey', '-p', appId, '1'], signal); }
  async restartApp(appId: string, signal?: AbortSignal): Promise<void> { await this.shell(['am', 'force-stop', appId], signal); await this.launchApp(appId, signal); }
  async performGoalStep(_goal: string, signal?: AbortSignal): Promise<void> { this.requireConnected(); await this.screenshot({ purpose: 'AI', width: 1440, height: 2560 }, signal); }

  async health(signal?: AbortSignal): Promise<DeviceHealth> {
    const result = await this.runner.run({ command: this.adbPath, args: ['-s', this.options.serial, 'get-state'], signal });
    const healthy = result.code === 0 && result.stdout.trim() === 'device';
    this.connected = healthy;
    return { state: healthy ? 'HEALTHY' : 'OFFLINE', lastCheckAt: Date.now(), adbConnected: healthy, screenResponsive: healthy, appAlive: healthy, agentAlive: healthy };
  }

  applyStreamProfile(profile: StreamProfile): void {
    this.requireConnected();
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
    if (result.code !== 0) throw new NativeToolError(`ADB command failed for ${this.deviceId}`, `${this.adbPath} -s ${this.options.serial} shell ${args.join(' ')}`, result.stderr);
  }

  private requireConnected(): void { if (!this.connected) throw new NativeToolError(`Android device ${this.options.serial} is not connected`, 'adb'); }
}
