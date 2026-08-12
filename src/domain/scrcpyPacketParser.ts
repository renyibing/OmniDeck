export const SC_PACKET_FLAG_CONFIG = 1n << 63n;
export const SC_PACKET_FLAG_KEY_FRAME = 1n << 62n;

export interface ScrcpyVideoPacket {
  config: boolean;
  keyframe: boolean;
  pts: bigint;
  data: Buffer;
}

export interface ScrcpyCodecMeta {
  codecId: number;
  width: number;
  height: number;
}

/** Parses scrcpy 2.x codec metadata (codec + width + height). Returns leftover bytes. */
export function drainScrcpyCodecMeta(buffer: Buffer): { meta: ScrcpyCodecMeta | null; rest: Buffer } {
  if (buffer.length < 12) return { meta: null, rest: buffer };
  return {
    meta: {
      codecId: buffer.readUInt32BE(0),
      width: buffer.readUInt32BE(4),
      height: buffer.readUInt32BE(8),
    },
    rest: Buffer.from(buffer.subarray(12)),
  };
}

/** Parses scrcpy video socket bytes (12-byte meta header + payload). Returns leftover bytes. */
export function drainScrcpyVideoPackets(buffer: Buffer, onPacket: (packet: ScrcpyVideoPacket) => void): Buffer {
  let offset = 0;
  while (offset + 12 <= buffer.length) {
    const ptsFlags = buffer.readBigUInt64BE(offset);
    const length = buffer.readUInt32BE(offset + 8);
    if (length < 0 || offset + 12 + length > buffer.length) break;
    const data = Buffer.from(buffer.subarray(offset + 12, offset + 12 + length));
    onPacket({
      config: (ptsFlags & SC_PACKET_FLAG_CONFIG) !== 0n,
      keyframe: (ptsFlags & SC_PACKET_FLAG_KEY_FRAME) !== 0n,
      pts: ptsFlags & ((1n << 62n) - 1n),
      data,
    });
    offset += 12 + length;
  }
  return Buffer.from(buffer.subarray(offset));
}

export function profileSignature(profile: { width: number; height: number; fps: number; bitrateKbps: number }): string {
  const maxSize = Math.max(320, Math.min(1920, Math.max(profile.width, profile.height)));
  const maxFps = Math.max(5, Math.min(60, profile.fps));
  const bitRate = Math.max(500_000, profile.bitrateKbps * 1000);
  // Bucket bitrate so tiny stream-policy jitter does not restart the encoder.
  const bitrateBucket = Math.round(bitRate / 250_000) * 250_000;
  return `${maxSize}:${maxFps}:${bitrateBucket}`;
}
