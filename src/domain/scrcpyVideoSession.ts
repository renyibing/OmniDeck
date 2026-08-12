import { connect as connectTcp, type Socket } from 'node:net';
import type { StreamProfile } from './types';
import { ProcessRunner } from './nativeProcess';
import { drainScrcpyCodecMeta, drainScrcpyVideoPackets, profileSignature } from './scrcpyPacketParser';
import { resolveScrcpyServer } from './scrcpyServerPath';

export type ScrcpyWirePacket = {
  kind: 'config' | 'key' | 'delta';
  data: Buffer;
};

type Subscriber = (packet: ScrcpyWirePacket) => void;

export interface ScrcpyVideoSessionOptions {
  deviceId: string;
  serial: string;
  adbPath?: string;
  scrcpyPath?: string;
  runner?: ProcessRunner;
}

/** Device-scoped scrcpy-server H.264 source (forward tunnel + meta-framed packets). */
export class ScrcpyVideoSession {
  private readonly runner: ProcessRunner;
  private readonly adbPath: string;
  private readonly scrcpyPath: string;
  private readonly subscribers = new Set<Subscriber>();
  private socket: Socket | null = null;
  private serverProcess: ReturnType<ProcessRunner['spawn']> | null = null;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private localPort = 0;
  private scid = '';
  private starting: Promise<void> | null = null;
  private started = false;
  private awaitingDummy = true;
  private awaitingCodecMeta = true;
  private currentSignature = '';
  private latestConfig: ScrcpyWirePacket | null = null;
  private latestKeyframe: ScrcpyWirePacket | null = null;
  private serverStderr = '';

  constructor(private readonly options: ScrcpyVideoSessionOptions) {
    this.runner = options.runner ?? new ProcessRunner();
    this.adbPath = options.adbPath ?? 'adb';
    this.scrcpyPath = options.scrcpyPath ?? 'scrcpy';
  }

  subscribe(listener: Subscriber): () => void {
    this.subscribers.add(listener);
    if (this.latestConfig) listener(this.latestConfig);
    if (this.latestKeyframe) listener(this.latestKeyframe);
    return () => this.subscribers.delete(listener);
  }

  isStarted(): boolean {
    return this.started;
  }

  signature(): string {
    return this.currentSignature;
  }

  async ensure(profile: StreamProfile): Promise<void> {
    const nextSignature = profileSignature(profile);
    if (this.started && this.currentSignature === nextSignature) return;
    if (this.started) {
      await this.restart(profile);
      return;
    }
    if (this.starting) return this.starting;
    this.starting = this.start(profile).finally(() => { this.starting = null; });
    return this.starting;
  }

  async restart(profile: StreamProfile): Promise<void> {
    await this.stop();
    return this.ensure(profile);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.awaitingDummy = true;
    this.awaitingCodecMeta = true;
    this.latestConfig = null;
    this.latestKeyframe = null;
    this.currentSignature = '';
    this.serverStderr = '';
    this.socket?.destroy();
    this.socket = null;
    this.serverProcess?.kill('SIGTERM');
    this.serverProcess = null;
    this.pending = Buffer.alloc(0);
    if (this.localPort) {
      await this.runner.run({
        command: this.adbPath,
        args: ['-s', this.options.serial, 'forward', '--remove', `tcp:${this.localPort}`],
        timeoutMs: 3_000,
      }).catch(() => undefined);
      this.localPort = 0;
    }
  }

  private async start(profile: StreamProfile): Promise<void> {
    const server = await resolveScrcpyServer(this.scrcpyPath, this.runner);
    this.scid = randomScid();
    this.localPort = 27183 + Math.abs(hashString(this.options.deviceId)) % 4000;
    this.currentSignature = profileSignature(profile);
    const remoteJar = '/data/local/tmp/omnideck-scrcpy-server.jar';
    const socketName = `scrcpy_${this.scid}`;

    const push = await this.runner.run({
      command: this.adbPath,
      args: ['-s', this.options.serial, 'push', server.jarPath, remoteJar],
      timeoutMs: 20_000,
    });
    if (push.code !== 0) throw new Error(`Failed to push scrcpy-server for ${this.options.deviceId}: ${push.stderr}`);

    await this.runner.run({
      command: this.adbPath,
      args: ['-s', this.options.serial, 'forward', '--remove', `tcp:${this.localPort}`],
      timeoutMs: 3_000,
    }).catch(() => undefined);

    const forward = await this.runner.run({
      command: this.adbPath,
      args: ['-s', this.options.serial, 'forward', `tcp:${this.localPort}`, `localabstract:${socketName}`],
      timeoutMs: 5_000,
    });
    if (forward.code !== 0) throw new Error(`Failed to forward scrcpy socket for ${this.options.deviceId}: ${forward.stderr}`);

    const maxSize = Math.max(320, Math.min(1920, Math.max(profile.width, profile.height)));
    const maxFps = Math.max(5, Math.min(60, profile.fps));
    const bitRate = Math.max(500_000, profile.bitrateKbps * 1000);
    const serverArgs = [
      server.version,
      `scid=${this.scid}`,
      'log_level=error',
      'video=true',
      'audio=false',
      'control=false',
      'cleanup=false',
      'tunnel_forward=true',
      'send_frame_meta=true',
      'send_device_meta=false',
      'send_codec_meta=true',
      `max_size=${maxSize}`,
      `max_fps=${maxFps}`,
      `video_bit_rate=${bitRate}`,
    ];

    this.serverProcess = this.runner.spawn({
      command: this.adbPath,
      args: [
        '-s', this.options.serial, 'shell',
        `CLASSPATH=${remoteJar}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', ...serverArgs,
      ],
    });
    this.serverProcess.stderr.on('data', chunk => {
      this.serverStderr = `${this.serverStderr}${String(chunk)}`.slice(-4_000);
    });
    this.serverProcess.once('close', () => {
      this.serverProcess = null;
      this.started = false;
    });

    await this.connectWithRetry();
    this.started = true;
  }

  private attachSocket(socket: Socket, onReady: () => void, onFailure: (error: Error) => void): void {
    this.socket = socket;
    this.awaitingDummy = true;
    this.awaitingCodecMeta = true;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      onFailure(error);
    };
    const ready = () => {
      if (settled) return;
      settled = true;
      onReady();
    };

    socket.on('data', chunk => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.pending = Buffer.concat([this.pending, incoming]);
      if (this.awaitingDummy) {
        if (!this.pending.length) return;
        if (this.pending[0] !== 0x00) {
          fail(new Error('Scrcpy video socket missing forward-tunnel dummy byte'));
          return;
        }
        this.pending = copyBuffer(this.pending.subarray(1));
        this.awaitingDummy = false;
      }
      if (this.awaitingCodecMeta) {
        const parsed = drainScrcpyCodecMeta(this.pending);
        if (!parsed.meta) return;
        this.awaitingCodecMeta = false;
        this.pending = copyBuffer(parsed.rest);
        ready();
      }
      this.pending = copyBuffer(drainScrcpyVideoPackets(this.pending, packet => {
        const kind = packet.config ? 'config' : packet.keyframe ? 'key' : 'delta';
        const wire: ScrcpyWirePacket = { kind, data: packet.data };
        if (kind === 'config') {
          this.latestConfig = wire;
          this.latestKeyframe = null;
        } else if (kind === 'key') {
          this.latestKeyframe = wire;
        }
        this.subscribers.forEach(listener => listener(wire));
      }));
    });
    socket.on('close', () => {
      this.started = false;
      this.socket = null;
      fail(new Error(`Scrcpy video socket closed${this.serverStderr ? `: ${this.serverStderr.trim()}` : ''}`));
    });
    socket.on('error', error => {
      this.started = false;
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async connectWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await this.connectUntilReady();
        return;
      } catch (error) {
        lastError = error;
        this.socket?.destroy();
        this.socket = null;
        this.pending = Buffer.alloc(0);
        this.awaitingDummy = true;
        this.awaitingCodecMeta = true;
        await sleep(80 + attempt * 20);
      }
    }
    const detail = this.serverStderr.trim();
    const base = lastError instanceof Error ? lastError.message : 'Unable to connect to scrcpy video socket';
    throw new Error(detail ? `${base}. Server: ${detail}` : base);
  }

  private connectUntilReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connectTcp({ host: '127.0.0.1', port: this.localPort });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Timed out waiting for scrcpy dummy/codec metadata'));
      }, 1_500);
      socket.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once('connect', () => {
        this.attachSocket(socket, () => {
          clearTimeout(timer);
          resolve();
        }, error => {
          clearTimeout(timer);
          reject(error);
        });
      });
    });
  }
}

function randomScid(): string {
  // scrcpy 3.x parses scid with Integer.parseInt(value, 16). Keep it hex and within 31 bits.
  return Math.floor(Math.random() * 0x7fff_ffff).toString(16);
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return hash;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function copyBuffer(value: Buffer | Buffer<ArrayBufferLike>): Buffer {
  const next = Buffer.allocUnsafe(value.length);
  Buffer.from(value).copy(next);
  return next;
}
