import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BatteryMedium, Radio, Wifi, WifiOff } from 'lucide-react';
import type { DeviceSummaryDTO } from '../server/protocol';
import type { DevicePressKey, ScreenTapPoint } from '../app/controlCenterClient';
import { subscribeDeviceFrame } from '../app/deviceFrameStore';
import { projectCanvasPoint, useDeviceVideoStream } from '../app/useDeviceVideoStream';
import { useDeviceScreenGestures } from '../app/useDeviceScreenGestures';

interface Props {
  device: DeviceSummaryDTO;
  fallback: 'tile' | 'inspector' | 'fullscreen';
  canControl?: boolean;
  keyboardEnabled?: boolean;
  keyboardSurface?: 'local';
  onControlActivate?: () => void;
  onTap?: (point: ScreenTapPoint) => void;
  onSwipe?: (from: ScreenTapPoint, to: ScreenTapPoint) => void;
  onLongPress?: (point: ScreenTapPoint) => void;
  onScroll?: (point: ScreenTapPoint, deltaX: number, deltaY: number) => void;
  onInputText?: (text: string) => void;
  onPressKey?: (key: DevicePressKey) => void;
}

export function DeviceScreen({
  device,
  fallback,
  canControl = false,
  keyboardEnabled,
  keyboardSurface,
  onControlActivate,
  onTap,
  onSwipe,
  onLongPress,
  onScroll,
  onInputText,
  onPressKey,
}: Props) {
  const [mjpegFailed, setMjpegFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const preferVideo = Boolean(device.livePreview && device.previewVideoUrl && !videoFailed);
  const { canvasRef, status: videoStatus } = useDeviceVideoStream(
    device.id,
    device.previewVideoUrl,
    device.sessionRevision,
    preferVideo,
  );
  const useVideo = preferVideo && videoStatus === 'live';
  const showVideoSurface = preferVideo && videoStatus !== 'failed';
  const mjpegUrl = device.previewStreamUrl ? `${device.previewStreamUrl}?rev=${device.sessionRevision}` : null;
  const useMjpeg = Boolean(device.livePreview && mjpegUrl && !showVideoSurface && !mjpegFailed);
  const usePolling = Boolean(device.livePreview && !showVideoSurface && !useMjpeg);

  useEffect(() => {
    setMjpegFailed(false);
    setVideoFailed(false);
  }, [device.id, device.sessionRevision, device.livePreview, device.previewStreamUrl, device.previewVideoUrl]);

  useEffect(() => {
    if (videoStatus === 'failed') setVideoFailed(true);
  }, [videoStatus]);

  useEffect(() => {
    if (!usePolling) return;
    const interval = Math.max(120, Math.round(1000 / resolvePreviewFps(device.stream.fps, fallback)));
    return subscribeDeviceFrame(device.id, interval, url => {
      const img = imageRef.current;
      if (!img || !url || img.src === url) return;
      img.src = url;
    });
  }, [device.id, device.stream.fps, fallback, usePolling]);

  const interactive = Boolean(canControl && (onTap || onSwipe || onLongPress || onScroll || onInputText || onPressKey));
  const showHint = Boolean((onTap || onSwipe || onLongPress || onScroll || onInputText || onPressKey) && !canControl && fallback !== 'tile');

  const projectScreenPoint = useCallback((clientX: number, clientY: number): ScreenTapPoint | null => {
    if (showVideoSurface && canvasRef.current) {
      const point = projectCanvasPoint(canvasRef.current, clientX, clientY);
      if (point) return point;
    }
    if (imageRef.current) {
      const point = projectPoint(imageRef.current, clientX, clientY);
      if (point) return point;
    }
    return null;
  }, [showVideoSurface]);

  const gestureHandlers = useMemo(() => ({
    onTap, onSwipe, onLongPress, onScroll, onInputText, onPressKey,
  }), [onInputText, onLongPress, onPressKey, onScroll, onSwipe, onTap]);
  const controlSurface = useDeviceScreenGestures(interactive, projectScreenPoint, gestureHandlers, {
    keyboardEnabled: keyboardEnabled ?? interactive,
    onActivate: onControlActivate,
  });
  const { viewportRef, ...controlProps } = controlSurface;
  const keyboardSurfaceProps = keyboardSurface === 'local' ? { 'data-keyboard-surface': 'local' as const } : {};
  const controlHint = 'Tap · swipe · scroll · type';

  if (device.livePreview && showVideoSurface) {
    return <div className={`device-screen real-screen ${interactive ? 'interactive control-ready' : ''} ${showHint ? 'control-locked' : ''}`}>
      <div ref={viewportRef} className={`screen-fit-viewport ${fallback}`} {...controlProps} {...keyboardSurfaceProps}>
        <canvas ref={canvasRef} className="device-video-canvas" aria-label={`${device.name} live screen`}/>
      </div>
      {interactive && <div className="screen-control-layer"><span>{controlHint} · H.264 stream</span></div>}
      {showHint && <div className="screen-control-hint"><span>Take control to interact</span></div>}
      <span className="real-live-badge"><i/>{useVideo ? 'LIVE H.264' : 'CONNECTING'}</span>
    </div>;
  }

  if (device.livePreview && (useMjpeg || usePolling)) {
    return <div className={`device-screen real-screen ${interactive ? 'interactive control-ready' : ''} ${showHint ? 'control-locked' : ''}`}>
      <div ref={viewportRef} className={`screen-fit-viewport ${fallback}`} {...controlProps} {...keyboardSurfaceProps}>
        <img
          ref={imageRef}
          src={useMjpeg ? mjpegUrl! : undefined}
          alt={`${device.name} live screen`}
          decoding="async"
          draggable={false}
          onError={() => {
            if (useMjpeg) setMjpegFailed(true);
          }}
        />
      </div>
      {interactive && <div className="screen-control-layer"><span>{controlHint} · Full screen fitted</span></div>}
      {showHint && <div className="screen-control-hint"><span>Take control to interact</span></div>}
      <span className="real-live-badge"><i/>LIVE</span>
    </div>;
  }

  if (fallback === 'inspector') return <div className={`mini-live screen-${device.screenshotSeed}`}><div className="live-app"><span>{device.currentApp}</span><strong>{device.status === 'OFFLINE' ? 'Connection unavailable' : 'Connecting live preview'}</strong></div></div>;
  if (fallback === 'fullscreen') return <div className={`large-phone screen-${device.screenshotSeed}`}><div className="phone-status"><span>9:41</span><span><Radio size={12}/></span></div><div className="large-app"><span>{device.currentApp}</span><strong>Account overview</strong><div className="large-chart"><i/><i/><i/><i/><i/><i/></div><div className="large-rows"><span/><span/><span/></div></div></div>;
  return <div className={`sim-screen screen-${device.screenshotSeed}`}>
    <div className="phone-status"><span>9:41</span><span><Radio size={9}/><Wifi size={9}/><BatteryMedium size={10}/></span></div>
    <div className="screen-content"><span className="app-eyebrow">{device.currentApp}</span><strong>{device.screenshotSeed % 3 === 0 ? 'Overview' : device.screenshotSeed % 3 === 1 ? 'Activity' : 'Workspace'}</strong><div className="screen-visual"><i/><i/><i/></div><div className="screen-lines"><i/><i/><i/></div></div>
    {device.status === 'OFFLINE' && <div className="screen-offline"><WifiOff size={24}/><strong>Signal lost</strong><span>Reconnecting session</span></div>}
  </div>;
}

function resolvePreviewFps(streamFps: number, fallback: Props['fallback']): number {
  if (fallback === 'fullscreen') return Math.max(8, Math.min(streamFps || 15, 15));
  if (fallback === 'inspector') return Math.max(5, Math.min(streamFps || 10, 10));
  return Math.max(3, Math.min(streamFps || 6, 6));
}

function projectPoint(image: HTMLImageElement, clientX: number, clientY: number): ScreenTapPoint | null {
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const naturalWidth = image.naturalWidth || rect.width;
  const naturalHeight = image.naturalHeight || rect.height;
  const imageAspect = naturalWidth / naturalHeight;
  const boxAspect = rect.width / rect.height;
  const renderedWidth = imageAspect > boxAspect ? rect.width : rect.height * imageAspect;
  const renderedHeight = imageAspect > boxAspect ? rect.width / imageAspect : rect.height;
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
