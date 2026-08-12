import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Nearest-neighbor downscale for monitor previews before PNG encode. */
export function scaleRgbaToMaxDimension(width: number, height: number, rgba: Buffer, maxDimension: number): { width: number; height: number; rgba: Buffer } {
  const rowSize = width * 4;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba.length < rowSize * height) {
    throw new Error(`Invalid RGBA frame dimensions: ${width}x${height}`);
  }
  const longest = Math.max(width, height);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0 || longest <= maxDimension) {
    return { width, height, rgba: rgba.subarray(0, rowSize * height) };
  }
  const scale = maxDimension / longest;
  const nextWidth = Math.max(1, Math.round(width * scale));
  const nextHeight = Math.max(1, Math.round(height * scale));
  const next = Buffer.alloc(nextWidth * nextHeight * 4);
  for (let y = 0; y < nextHeight; y += 1) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < nextWidth; x += 1) {
      const srcX = Math.min(width - 1, Math.floor(x / scale));
      const src = (srcY * width + srcX) * 4;
      const dst = (y * nextWidth + x) * 4;
      next[dst] = rgba[src]!;
      next[dst + 1] = rgba[src + 1]!;
      next[dst + 2] = rgba[src + 2]!;
      next[dst + 3] = rgba[src + 3]!;
    }
  }
  return { width: nextWidth, height: nextHeight, rgba: next };
}

/** Encodes Android's RGBA8888 screencap output without spawning a second process. */
export function encodeRgbaPng(width: number, height: number, rgba: Buffer, maxDimension?: number): Buffer {
  const scaled = maxDimension == null
    ? { width, height, rgba }
    : scaleRgbaToMaxDimension(width, height, rgba, maxDimension);
  const rowSize = scaled.width * 4;
  if (!Number.isInteger(scaled.width) || !Number.isInteger(scaled.height) || scaled.width <= 0 || scaled.height <= 0 || scaled.rgba.length < rowSize * scaled.height) {
    throw new Error(`Invalid RGBA frame dimensions: ${scaled.width}x${scaled.height}`);
  }
  const scanlines = Buffer.alloc((rowSize + 1) * scaled.height);
  for (let row = 0; row < scaled.height; row += 1) {
    const destination = row * (rowSize + 1);
    scanlines[destination] = 0;
    scaled.rgba.copy(scanlines, destination + 1, row * rowSize, (row + 1) * rowSize);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(scaled.width, 0);
  header.writeUInt32BE(scaled.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(scanlines, { level: 1 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), data.length + 8);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
