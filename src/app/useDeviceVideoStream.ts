import { useEffect, useRef, useState } from 'react';

type StreamStatus = 'idle' | 'connecting' | 'live' | 'failed';

function buildVideoUrl(path: string, sessionRevision: number): string {
  if (path.startsWith('ws://') || path.startsWith('wss://')) return `${path}?rev=${sessionRevision}`;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}?rev=${sessionRevision}`;
}

function isWebCodecsSupported(): boolean {
  return typeof window !== 'undefined' && 'VideoDecoder' in window;
}

export function splitAnnexBNalus(data: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 < data.length; i += 1) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    if (data[i + 2] === 1) {
      starts.push(i);
      i += 2;
      continue;
    }
    if (data[i + 2] === 0 && data[i + 3] === 1) {
      starts.push(i);
      i += 3;
    }
  }
  const units: Uint8Array[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const marker = starts[i]!;
    const headerSize = data[marker + 2] === 1 ? 3 : 4;
    const payloadStart = marker + headerSize;
    const payloadEnd = i + 1 < starts.length ? starts[i + 1]! : data.length;
    if (payloadEnd > payloadStart) units.push(data.subarray(payloadStart, payloadEnd));
  }
  return units;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

/** Derive WebCodecs codec string from H.264 SPS (Annex-B config packet). */
export function codecStringFromAnnexB(config: Uint8Array): string {
  const sps = splitAnnexBNalus(config).find(unit => ((unit[0] ?? 0) & 0x1f) === 7);
  if (!sps || sps.length < 4) return 'avc1.42E01E';
  return `avc1.${toHex(sps[1]!)}${toHex(sps[2]!)}${toHex(sps[3]!)}`;
}

/** Convert Annex-B payload to 4-byte length-prefixed NALs (AVCC access unit). */
export function annexBToLengthPrefixed(data: Uint8Array): Uint8Array {
  const units = splitAnnexBNalus(data);
  if (!units.length) return data;
  const total = units.reduce((sum, unit) => sum + 4 + unit.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const unit of units) {
    out[offset++] = (unit.length >>> 24) & 0xff;
    out[offset++] = (unit.length >>> 16) & 0xff;
    out[offset++] = (unit.length >>> 8) & 0xff;
    out[offset++] = unit.length & 0xff;
    out.set(unit, offset);
    offset += unit.length;
  }
  return out;
}

/** Convert Annex-B SPS/PPS config into AVCDecoderConfigurationRecord for WebCodecs. */
export function annexBToAvcC(config: Uint8Array): Uint8Array {
  const units = splitAnnexBNalus(config);
  const spsList = units.filter(unit => ((unit[0] ?? 0) & 0x1f) === 7);
  const ppsList = units.filter(unit => ((unit[0] ?? 0) & 0x1f) === 8);
  if (!spsList.length || !ppsList.length) return config;
  const sps = spsList[0]!;
  const length = 7 + spsList.reduce((sum, unit) => sum + 2 + unit.length, 0) + 1 + ppsList.reduce((sum, unit) => sum + 2 + unit.length, 0);
  const avcC = new Uint8Array(length);
  let offset = 0;
  avcC[offset++] = 1;
  avcC[offset++] = sps[1] ?? 0;
  avcC[offset++] = sps[2] ?? 0;
  avcC[offset++] = sps[3] ?? 0;
  avcC[offset++] = 0xff;
  avcC[offset++] = 0xe0 | (spsList.length & 0x1f);
  for (const unit of spsList) {
    avcC[offset++] = (unit.length >> 8) & 0xff;
    avcC[offset++] = unit.length & 0xff;
    avcC.set(unit, offset);
    offset += unit.length;
  }
  avcC[offset++] = ppsList.length & 0xff;
  for (const unit of ppsList) {
    avcC[offset++] = (unit.length >> 8) & 0xff;
    avcC[offset++] = unit.length & 0xff;
    avcC.set(unit, offset);
    offset += unit.length;
  }
  return avcC.subarray(0, offset);
}

export function useDeviceVideoStream(deviceId: string, videoPath: string | null, sessionRevision: number, enabled: boolean): {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  status: StreamStatus;
} {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<StreamStatus>('idle');

  useEffect(() => {
    if (!enabled || !videoPath || !isWebCodecsSupported()) {
      setStatus('idle');
      return;
    }

    let closed = false;
    let socket: WebSocket | null = null;
    let decoder: VideoDecoder | null = null;
    let waitingForKeyframe = true;
    let pendingFrame: VideoFrame | null = null;
    let raf = 0;
    let firstLive = false;
    let frameTimestampUs = 0;

    const paint = () => {
      raf = 0;
      if (!pendingFrame) return;
      const frame = pendingFrame;
      pendingFrame = null;
      const canvas = canvasRef.current;
      if (!canvas) {
        frame.close();
        return;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        frame.close();
        return;
      }
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      if (!closed && !firstLive) {
        firstLive = true;
        setStatus('live');
      }
    };

    const queueFrame = (frame: VideoFrame) => {
      if (pendingFrame) pendingFrame.close();
      pendingFrame = frame;
      if (!raf) raf = requestAnimationFrame(paint);
    };

    const ensureDecoder = async (descriptionAnnexB: Uint8Array) => {
      const codec = codecStringFromAnnexB(descriptionAnnexB);
      const description = annexBToAvcC(descriptionAnnexB);
      decoder?.close();
      const support = await VideoDecoder.isConfigSupported({
        codec,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
        description,
      });
      if (!support.supported) throw new Error('WebCodecs H.264 is unavailable in this browser');
      decoder = new VideoDecoder({
        output: queueFrame,
        error: () => {
          if (!closed) setStatus('failed');
        },
      });
      decoder.configure({
        codec,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
        description,
      });
      waitingForKeyframe = true;
    };

    const decodePacket = async (kind: number, payload: Uint8Array) => {
      if (kind === 0) {
        await ensureDecoder(payload);
        return;
      }
      if (!decoder || decoder.state !== 'configured') return;
      if (waitingForKeyframe && kind !== 1) return;
      if (kind === 2 && decoder.decodeQueueSize > 3) return;
      if (kind === 1) waitingForKeyframe = false;
      frameTimestampUs += 33_333;
      // avcC description requires length-prefixed NALs, not Annex-B start codes.
      decoder.decode(new EncodedVideoChunk({
        type: kind === 1 ? 'key' : 'delta',
        timestamp: frameTimestampUs,
        data: annexBToLengthPrefixed(payload),
      }));
    };

    setStatus('connecting');
    socket = new WebSocket(buildVideoUrl(videoPath, sessionRevision));
    socket.binaryType = 'arraybuffer';
    socket.onmessage = event => {
      if (closed) return;
      const buffer = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : null;
      if (!buffer || buffer.length < 3) return;
      const kind = buffer[0] ?? 0;
      const payload = buffer.subarray(2);
      void decodePacket(kind, payload).catch(() => {
        if (!closed) setStatus('failed');
      });
    };
    socket.onerror = () => {
      if (!closed) setStatus('failed');
    };
    socket.onclose = () => {
      if (!closed && !firstLive) setStatus('failed');
    };

    return () => {
      closed = true;
      if (raf) cancelAnimationFrame(raf);
      if (pendingFrame) pendingFrame.close();
      socket?.close();
      decoder?.close();
      setStatus('idle');
    };
  }, [deviceId, enabled, sessionRevision, videoPath]);

  return { canvasRef, status };
}

export function projectCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !canvas.width || !canvas.height) return null;
  const boxAspect = rect.width / rect.height;
  const canvasAspect = canvas.width / canvas.height;
  const renderedWidth = canvasAspect > boxAspect ? rect.width : rect.height * canvasAspect;
  const renderedHeight = canvasAspect > boxAspect ? rect.width / canvasAspect : rect.height;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;
  const localX = clientX - rect.left - offsetX;
  const localY = clientY - rect.top - offsetY;
  if (localX < 0 || localY < 0 || localX > renderedWidth || localY > renderedHeight) return null;
  return {
    x: Math.min(1, Math.max(0, localX / renderedWidth)),
    y: Math.min(1, Math.max(0, localY / renderedHeight)),
  };
}
