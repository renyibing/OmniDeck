import type { StreamProfile } from './types';
import { profileSignature } from './scrcpyPacketParser';
import { ScrcpyVideoSession, type ScrcpyWirePacket } from './scrcpyVideoSession';

export interface VideoStreamClient {
  readonly OPEN: number;
  readyState: number;
  bufferedAmount: number;
  send(data: Buffer): void;
  close(code: number, reason: string): void;
  on(event: 'close' | 'error', listener: () => void): void;
}

export interface ScrcpyVideoRegistryOptions {
  adbPath?: string;
  scrcpyPath?: string;
}

const MAX_BUFFERED_BYTES = 512 * 1024;

/** One scrcpy-server session per Android device; fans H.264 packets to WebSocket viewers. */
export class ScrcpyVideoRegistry {
  private readonly sessions = new Map<string, ScrcpyVideoSession>();
  private readonly options: ScrcpyVideoRegistryOptions;

  constructor(options: ScrcpyVideoRegistryOptions = {}) {
    this.options = options;
  }

  async ensure(deviceId: string, serial: string, profile: StreamProfile): Promise<void> {
    const session = this.sessions.get(deviceId) ?? new ScrcpyVideoSession({
      deviceId,
      serial,
      adbPath: this.options.adbPath,
      scrcpyPath: this.options.scrcpyPath,
    });
    this.sessions.set(deviceId, session);
    await session.ensure(profile);
  }

  async applyProfile(deviceId: string, serial: string, profile: StreamProfile): Promise<void> {
    const current = this.sessions.get(deviceId);
    if (!current || !current.isStarted()) {
      await this.ensure(deviceId, serial, profile);
      return;
    }
    if (current.signature() === profileSignature(profile)) return;
    await current.ensure(profile);
  }

  async stop(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (!session) return;
    await session.stop();
    this.sessions.delete(deviceId);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.sessions.keys()).map(deviceId => this.stop(deviceId)));
  }

  attachClient(deviceId: string, socket: VideoStreamClient): () => void {
    const session = this.sessions.get(deviceId);
    if (!session) {
      socket.close(1011, 'Scrcpy video session is not running');
      return () => undefined;
    }

    const send = (packet: ScrcpyWirePacket) => {
      if (socket.readyState !== socket.OPEN) return;
      // Prefer freshness over completeness when a slow client falls behind.
      if (packet.kind === 'delta' && socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
      const header = Buffer.alloc(2);
      header[0] = packet.kind === 'config' ? 0 : packet.kind === 'key' ? 1 : 2;
      header[1] = 0;
      socket.send(Buffer.concat([header, packet.data]));
    };

    const unsubscribe = session.subscribe(send);
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
    return unsubscribe;
  }
}
