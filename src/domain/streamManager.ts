import type { LayoutSize, StreamMode, StreamProfile } from './types';

const PROFILES: Record<StreamMode, StreamProfile> = {
  FULLSCREEN: { mode: 'FULLSCREEN', width: 1080, height: 1920, fps: 60, bitrateKbps: 8000 },
  FOCUSED: { mode: 'FOCUSED', width: 720, height: 1280, fps: 30, bitrateKbps: 3500 },
  PREVIEW: { mode: 'PREVIEW', width: 480, height: 854, fps: 10, bitrateKbps: 900 },
  BACKGROUND: { mode: 'BACKGROUND', width: 360, height: 640, fps: 1, bitrateKbps: 180 },
};

const LAYOUT_LIMITS: Record<LayoutSize, Partial<StreamProfile>> = {
  1: { width: 1080, height: 1920, fps: 60, bitrateKbps: 8000 },
  4: { width: 720, height: 1280, fps: 30, bitrateKbps: 3500 },
  8: { width: 640, height: 1138, fps: 15, bitrateKbps: 1800 },
  9: { width: 640, height: 1138, fps: 15, bitrateKbps: 1800 },
  16: { width: 480, height: 854, fps: 10, bitrateKbps: 900 },
  25: { width: 360, height: 640, fps: 6, bitrateKbps: 500 },
  32: { width: 360, height: 640, fps: 5, bitrateKbps: 420 },
};

export class StreamManager {
  getProfile(mode: StreamMode, layout: LayoutSize, resourcePressure = 0): StreamProfile {
    if (mode === 'FULLSCREEN' || mode === 'BACKGROUND' || mode === 'FOCUSED') return { ...PROFILES[mode] };
    const limit = LAYOUT_LIMITS[layout];
    const pressureFactor = resourcePressure > 0.8 ? 0.6 : resourcePressure > 0.6 ? 0.8 : 1;
    return {
      mode,
      width: limit.width ?? PROFILES.PREVIEW.width,
      height: limit.height ?? PROFILES.PREVIEW.height,
      fps: Math.max(3, Math.floor((limit.fps ?? PROFILES.PREVIEW.fps) * pressureFactor)),
      bitrateKbps: Math.floor((limit.bitrateKbps ?? PROFILES.PREVIEW.bitrateKbps) * pressureFactor),
    };
  }

  requestAIScreenshot() {
    return { width: 1440, height: 2560, source: 'ON_DEMAND_SCREENSHOT' as const };
  }
}
