import { ArrowLeft, Bot, Hand } from 'lucide-react';
import type { DeviceSummaryDTO } from '../server/protocol';
import { DeviceScreen } from './DeviceScreen';
import type { DevicePressKey, ScreenTapPoint } from '../app/controlCenterClient';

export function FullscreenDevice({
  device,
  onClose,
  onTakeControl,
  onReleaseControl,
  onTap,
  onSwipe,
  onLongPress,
  onScroll,
  onInputText,
  onPressKey,
}: {
  device: DeviceSummaryDTO;
  onClose: () => void;
  onTakeControl: (id: string) => void;
  onReleaseControl: (id: string) => void;
  onTap: (id: string, point: ScreenTapPoint) => void;
  onSwipe: (id: string, from: ScreenTapPoint, to: ScreenTapPoint) => void;
  onLongPress: (id: string, point: ScreenTapPoint) => void;
  onScroll: (id: string, point: ScreenTapPoint, deltaX: number, deltaY: number) => void;
  onInputText: (id: string, text: string) => void;
  onPressKey: (id: string, key: DevicePressKey) => void;
}) {
  const humanControl = device.agentStatus === 'HUMAN_CONTROL';
  const statusMessage = device.agentStatus === 'HUMAN_CONTROL'
    ? 'Manual control is active. Tap, swipe, scroll, and keyboard input on the preview are sent only to this device.'
    : 'Agent continues running independently while views change.';
  return <div className="fullscreen-device"><header><button onClick={onClose}><ArrowLeft size={18}/> Back to monitor wall</button><div><strong>{device.name}</strong><span>{device.id} · session rev {device.sessionRevision}</span></div><span className="live-indicator"><i/> {device.livePreview ? (device.previewVideoUrl ? `LIVE · H.264 · ${Math.min(Math.max(device.stream.fps, 15), 30)} FPS` : `LIVE · MJPEG · ${Math.min(Math.max(device.stream.fps, 8), 15)} FPS`) : `LIVE · ${device.stream.fps} FPS`}</span><button className="takeover-button" onClick={() => (humanControl ? onReleaseControl(device.id) : onTakeControl(device.id))}><Hand size={16}/> {humanControl ? 'Release control' : 'Take control'}</button></header><main><DeviceScreen device={device} fallback="fullscreen" canControl={humanControl} onTap={point => onTap(device.id, point)} onSwipe={(from, to) => onSwipe(device.id, from, to)} onLongPress={point => onLongPress(device.id, point)} onScroll={(point, deltaX, deltaY) => onScroll(device.id, point, deltaX, deltaY)} onInputText={text => onInputText(device.id, text)} onPressKey={key => onPressKey(device.id, key)}/><aside><span><Bot size={16}/> AGENT SESSION</span><strong>{device.agentStatus}</strong><p>{device.currentTask?.goal ?? 'Waiting for task'}</p><small>{statusMessage}</small></aside></main></div>;
}
