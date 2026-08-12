import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { PreviewBroadcast } from './previewBroadcast';

describe('preview broadcast', () => {
  it('captures once and fans out the latest frame to waiters', async () => {
    const broadcast = new PreviewBroadcast();
    let captures = 0;
    broadcast.ensure('device-01', 20, async () => {
      captures += 1;
      return { deviceId: 'device-01', capturedAt: Date.now(), contentType: 'image/png', data: Buffer.from(`png-${captures}`) };
    });

    const frame = await broadcast.waitForFrame('device-01');
    expect(frame.data.toString()).toBe('png-1');
    expect(broadcast.getLatest('device-01')?.data.toString()).toBe('png-1');
    broadcast.stop('device-01');
  });

  it('writes multipart MJPEG frames to an HTTP response', async () => {
    const broadcast = new PreviewBroadcast();
    let tick = 0;
    broadcast.ensure('device-01', 30, async () => {
      tick += 1;
      return { deviceId: 'device-01', capturedAt: Date.now(), contentType: 'image/jpeg', data: Buffer.from(`jpeg-${tick}`) };
    });
    await broadcast.waitForFrame('device-01');

    const chunks: Buffer[] = [];
    const response = new PassThrough() as unknown as ServerResponse & PassThrough;
    const writeHead = vi.fn();
    response.writeHead = writeHead;
    const originalWrite = response.write.bind(response);
    response.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return originalWrite(chunk as never, encoding as never, callback as never);
    }) as typeof response.write;

    const attach = broadcast.attachMjpeg('device-01', response);
    await vi.waitFor(() => {
      const body = Buffer.concat(chunks).toString('latin1');
      expect(body).toContain('--OmniDeckFrame');
      expect(body).toContain('Content-Type: image/jpeg');
      expect(body).toContain('jpeg-');
    }, { timeout: 1_000 });

    expect(writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'multipart/x-mixed-replace; boundary=OmniDeckFrame',
    }));

    response.destroy();
    await attach;
    broadcast.stopAll();
  });
});
