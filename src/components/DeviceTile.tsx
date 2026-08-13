import { BatteryMedium, Bot, Check, Cpu, GripVertical, Radio, Thermometer, Wifi, WifiOff } from 'lucide-react';
import type { DeviceSummaryDTO } from '../server/protocol';
import { DeviceScreen } from './DeviceScreen';
import type { DevicePressKey, ScreenTapPoint } from '../app/controlCenterClient';

interface Props {
  device: DeviceSummaryDTO;
  selected: boolean;
  focused: boolean;
  dense: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onSelect: (event: React.MouseEvent) => void;
  onToggle: () => void;
  onOpen: () => void;
  onTap: (point: ScreenTapPoint) => void;
  onSwipe: (from: ScreenTapPoint, to: ScreenTapPoint) => void;
  onLongPress: (point: ScreenTapPoint) => void;
  onScroll: (point: ScreenTapPoint, deltaX: number, deltaY: number) => void;
  onInputText: (text: string) => void;
  onPressKey: (key: DevicePressKey) => void;
  onFocusDevice: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}

const agentLabel: Record<DeviceSummaryDTO['agentStatus'], string> = { IDLE: 'IDLE', WAITING: 'WAITING', RUNNING: 'AI RUNNING', PAUSED: 'PAUSED', HUMAN_CONTROL: 'HUMAN', ERROR: 'ERROR' };

export function DeviceTile({ device, selected, focused, dense, dragging, dropTarget, onSelect, onToggle, onOpen, onTap, onSwipe, onLongPress, onScroll, onInputText, onPressKey, onFocusDevice, onDragStart, onDragOver, onDrop, onDragEnd }: Props) {
  const stateClass = device.status === 'OFFLINE' ? 'offline' : device.agentStatus === 'RUNNING' ? 'running' : device.agentStatus === 'HUMAN_CONTROL' ? 'human' : device.status === 'ERROR' || device.health === 'DEGRADED' ? 'error' : 'idle';
  return <article className={`device-tile ${stateClass} ${selected ? 'selected' : ''} ${focused ? 'focused' : ''} ${dense ? 'dense' : ''} ${dragging ? 'dragging' : ''} ${dropTarget ? 'drop-target' : ''}`} onClick={onSelect} onDoubleClick={onOpen} onDragOver={onDragOver} onDrop={onDrop}>
    <div className="tile-topline">
      <button className="drag-handle" aria-label={`Reorder ${device.name}`} title="Drag to reorder" draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={event => event.stopPropagation()}><GripVertical size={12}/></button>
      <button className={`tile-check ${selected ? 'checked' : ''}`} aria-label={`Select ${device.name}`} onClick={event => { event.stopPropagation(); onToggle(); }}>{selected && <Check size={12}/>}</button>
      <div className="device-title"><strong>{device.name}</strong><span>{device.id.toUpperCase()}</span></div>
      <span className={`platform ${device.platform.toLowerCase()}`}>{device.platform}</span>
      <span className={`online-state ${device.status.toLowerCase()}`}><i/>{device.status}</span>
    </div>
    <div className="screen-frame">
      <DeviceScreen device={device} fallback="tile" canControl={device.agentStatus === 'HUMAN_CONTROL'} keyboardEnabled={false} onControlActivate={onFocusDevice} onTap={onTap} onSwipe={onSwipe} onLongPress={onLongPress} onScroll={onScroll} onInputText={onInputText} onPressKey={onPressKey}/>
      <div className="stream-badge">{device.stream.width}p · {device.stream.fps} FPS</div>
      <div className={`agent-badge ${device.agentStatus.toLowerCase()}`}><Bot size={12}/>{agentLabel[device.agentStatus]}</div>
    </div>
    <div className="tile-bottom">
      <div className="task-line"><span className={`task-dot ${device.currentTask?.status.toLowerCase() ?? 'idle'}`}/><strong>{device.currentTask?.goal ?? 'No active task'}</strong><span>{device.currentTask?.status ?? 'IDLE'}</span></div>
      <div className="telemetry">
        <span title="Latency"><Radio size={12}/>{device.metrics.latency || '--'}ms</span>
        <span title="CPU and memory"><Cpu size={12}/>{device.metrics.cpu}% / {device.metrics.memory}%</span>
        <span title="Battery"><BatteryMedium size={12}/>{device.metrics.battery}%</span>
        <span title="Temperature"><Thermometer size={12}/>{device.metrics.temperature || '--'}°</span>
        <span title="Network">{device.metrics.network === 'OFFLINE' ? <WifiOff size={12}/> : <Wifi size={12}/>} {device.metrics.network}</span>
      </div>
    </div>
  </article>;
}
