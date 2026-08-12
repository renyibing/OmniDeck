import { describe, expect, it } from 'vitest';
import { drainScrcpyCodecMeta, drainScrcpyVideoPackets, profileSignature, SC_PACKET_FLAG_CONFIG, SC_PACKET_FLAG_KEY_FRAME } from './scrcpyPacketParser';
import { deriveWdaMjpegUrl } from './wdaMjpegUrl';

describe('scrcpy packet parser', () => {
  it('parses framed H264 packets from the scrcpy video socket', () => {
    const payload = Buffer.from([0, 0, 0, 1, 0x67, 0x42]);
    const header = Buffer.alloc(12);
    header.writeBigUInt64BE(SC_PACKET_FLAG_CONFIG, 0);
    header.writeUInt32BE(payload.length, 8);
    const packets: string[] = [];
    const leftover = drainScrcpyVideoPackets(Buffer.concat([header, payload]), packet => {
      packets.push(`${packet.config ? 'config' : packet.keyframe ? 'key' : 'delta'}:${packet.data.length}`);
    });
    expect(packets).toEqual(['config:6']);
    expect(leftover.length).toBe(0);
  });

  it('keeps partial frames in the leftover buffer', () => {
    const payload = Buffer.from([0, 0, 0, 1, 0x65]);
    const header = Buffer.alloc(12);
    header.writeBigUInt64BE(SC_PACKET_FLAG_KEY_FRAME, 0);
    header.writeUInt32BE(payload.length, 8);
    const partial = Buffer.concat([header, payload.subarray(0, 2)]);
    const leftover = drainScrcpyVideoPackets(partial, () => undefined);
    expect(leftover.length).toBe(partial.length);
  });

  it('parses codec metadata and buckets profile signatures', () => {
    const meta = Buffer.alloc(12);
    meta.writeUInt32BE(0x68323634, 0);
    meta.writeUInt32BE(720, 4);
    meta.writeUInt32BE(1280, 8);
    expect(drainScrcpyCodecMeta(meta).meta).toEqual({ codecId: 0x68323634, width: 720, height: 1280 });
    expect(profileSignature({ width: 720, height: 1280, fps: 30, bitrateKbps: 3500 }))
      .toBe(profileSignature({ width: 720, height: 1280, fps: 30, bitrateKbps: 3600 }));
  });
});

describe('wda mjpeg url', () => {
  it('maps WDA control ports to the conventional MJPEG port offset', () => {
    expect(deriveWdaMjpegUrl('http://127.0.0.1:8100')).toBe('http://127.0.0.1:9100');
    expect(deriveWdaMjpegUrl('http://127.0.0.1:8101/')).toBe('http://127.0.0.1:9101');
  });
});
