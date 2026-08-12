import type { ServerResponse } from 'node:http';
import type { MonitorFrame } from './deviceDriver';

const BOUNDARY = 'OmniDeckFrame';
const CRLF = '\r\n';

interface PreviewLoop {
  deviceId: string;
  fps: number;
  capture: () => Promise<MonitorFrame>;
  latest: MonitorFrame | null;
  running: boolean;
  timer: NodeJS.Timeout | null;
  pending: Promise<void> | null;
  waiters: Set<(frame: MonitorFrame) => void>;
}

/** One capture loop per device; fans out latest frames to MJPEG clients without per-request WDA/ADB round-trips. */
export class PreviewBroadcast {
  private readonly loops = new Map<string, PreviewLoop>();

  ensure(deviceId: string, fps: number, capture: () => Promise<MonitorFrame>): void {
    const existing = this.loops.get(deviceId);
    if (existing) {
      existing.fps = clampFps(fps);
      existing.capture = capture;
      if (!existing.running) void this.tick(existing);
      return;
    }
    const loop: PreviewLoop = {
      deviceId,
      fps: clampFps(fps),
      capture,
      latest: null,
      running: false,
      timer: null,
      pending: null,
      waiters: new Set(),
    };
    this.loops.set(deviceId, loop);
    void this.tick(loop);
  }

  setFps(deviceId: string, fps: number): void {
    const loop = this.loops.get(deviceId);
    if (loop) loop.fps = clampFps(fps);
  }

  stop(deviceId: string): void {
    const loop = this.loops.get(deviceId);
    if (!loop) return;
    if (loop.timer) clearTimeout(loop.timer);
    loop.timer = null;
    loop.running = false;
    this.loops.delete(deviceId);
  }

  stopAll(): void {
    for (const deviceId of Array.from(this.loops.keys())) this.stop(deviceId);
  }

  getLatest(deviceId: string): MonitorFrame | null {
    return this.loops.get(deviceId)?.latest ?? null;
  }

  async waitForFrame(deviceId: string, timeoutMs = 2_000): Promise<MonitorFrame> {
    const loop = this.loops.get(deviceId);
    if (!loop) throw new Error(`Preview broadcast is not running for ${deviceId}`);
    if (loop.latest && Date.now() - loop.latest.capturedAt < Math.max(120, 1_000 / loop.fps)) {
      return loop.latest;
    }
    return new Promise<MonitorFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        loop.waiters.delete(onFrame);
        if (loop.latest) resolve(loop.latest);
        else reject(new Error(`Timed out waiting for preview frame from ${deviceId}`));
      }, timeoutMs);
      const onFrame = (frame: MonitorFrame) => {
        clearTimeout(timer);
        loop.waiters.delete(onFrame);
        resolve(frame);
      };
      loop.waiters.add(onFrame);
      if (!loop.running) void this.tick(loop);
    });
  }

  async attachMjpeg(deviceId: string, response: ServerResponse, signal?: AbortSignal): Promise<void> {
    const loop = this.loops.get(deviceId);
    if (!loop) throw new Error(`Preview broadcast is not running for ${deviceId}`);

    response.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Connection: 'close',
      'Access-Control-Allow-Origin': '*',
    });

    let closed = false;
    const close = () => { closed = true; };
    signal?.addEventListener('abort', close, { once: true });
    response.on('close', close);
    response.on('error', close);

    const writeFrame = async (frame: MonitorFrame): Promise<boolean> => {
      if (closed || response.writableEnded) return false;
      const header = Buffer.from(
        `--${BOUNDARY}${CRLF}Content-Type: ${frame.contentType}${CRLF}Content-Length: ${frame.data.length}${CRLF}${CRLF}`,
        'utf8',
      );
      const okHeader = response.write(header);
      const okBody = response.write(frame.data);
      const okTail = response.write(Buffer.from(CRLF, 'utf8'));
      if (!(okHeader && okBody && okTail)) {
        await new Promise<void>(resolve => response.once('drain', resolve));
      }
      return !closed;
    };

    if (loop.latest) await writeFrame(loop.latest);

    await new Promise<void>(resolve => {
      const onFrame = (frame: MonitorFrame) => {
        void writeFrame(frame).then(ok => {
          if (!ok) {
            loop.waiters.delete(onFrame);
            resolve();
          }
        });
      };
      loop.waiters.add(onFrame);
      const watch = setInterval(() => {
        if (closed || response.writableEnded) {
          clearInterval(watch);
          loop.waiters.delete(onFrame);
          resolve();
        }
      }, 250);
    });
  }

  private async tick(loop: PreviewLoop): Promise<void> {
    if (loop.pending || !this.loops.has(loop.deviceId)) return;
    loop.running = true;
    loop.pending = (async () => {
      const startedAt = Date.now();
      try {
        const frame = await loop.capture();
        if (!this.loops.has(loop.deviceId)) return;
        loop.latest = frame;
        for (const waiter of Array.from(loop.waiters)) waiter(frame);
      } catch {
        // Keep the previous frame on transient capture failures.
      } finally {
        loop.pending = null;
        if (!this.loops.has(loop.deviceId)) {
          loop.running = false;
          return;
        }
        const delay = Math.max(0, Math.round(1_000 / loop.fps) - (Date.now() - startedAt));
        loop.timer = setTimeout(() => {
          loop.timer = null;
          void this.tick(loop);
        }, delay);
      }
    })();
    await loop.pending;
  }
}

function clampFps(fps: number): number {
  return Math.max(1, Math.min(30, Math.round(fps || 10)));
}

export function createPreviewBroadcast(): PreviewBroadcast {
  return new PreviewBroadcast();
}
