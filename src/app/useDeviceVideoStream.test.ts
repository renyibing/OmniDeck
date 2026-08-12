import { describe, expect, it } from 'vitest';
import { annexBToAvcC, annexBToLengthPrefixed, codecStringFromAnnexB, splitAnnexBNalus } from '../app/useDeviceVideoStream';

describe('webcodecs annex-b helpers', () => {
  it('extracts SPS/PPS and builds avcC + codec string', () => {
    const sps = Uint8Array.from([0x67, 0x42, 0xE0, 0x1E, 0x01]);
    const pps = Uint8Array.from([0x68, 0xCE, 0x06, 0xE2]);
    const annexB = Uint8Array.from([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps]);
    expect(splitAnnexBNalus(annexB)).toHaveLength(2);
    expect(codecStringFromAnnexB(annexB)).toBe('avc1.42E01E');
    const avcC = annexBToAvcC(annexB);
    expect(avcC[0]).toBe(1);
    expect(avcC[1]).toBe(0x42);
    expect(avcC[2]).toBe(0xE0);
    expect(avcC[3]).toBe(0x1E);
    const framed = annexBToLengthPrefixed(annexB);
    expect(framed[0]).toBe(0);
    expect(framed[3]).toBe(sps.length);
  });
});
