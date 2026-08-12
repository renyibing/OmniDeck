import { BatteryMedium, Bot, Check, Cpu, Radio, Thermometer, Wifi, WifiOff } from 'lucide-react';
import type { DeviceSummaryDTO } from '../server/protocol';

interface Props { device: DeviceSummaryDTO; selected: boolean; focused: boolean; dense: boolean; onSelect: (event: React.MouseEvent) => void; onToggle: () => void; onOpen: () => void }

const agentLabel: Record<DeviceSummaryDTO['agentStatus'], string> = { IDLE: 'IDLE', WAITING: 'WAITING', RUNNING: 'AI RUNNING', PAUSED: 'PAUSED', HUMAN_CONTROL: 'HUMAN', ERROR: 'ERROR' };

export function DeviceTile({ device, selected, focused, dense, onSelect, onToggle, onOpen }: Props) {
  const stateClass = device.status === 'OFFLINE' ? 'offline' : device.agentStatus === 'RUNNING' ? 'running' : device.agentStatus === 'HUMAN_CONTROL' ? 'human' : device.status === 'ERROR' || device.health === 'DEGRADED' ? 'error' : 'idle';
  return <article className={`device-tile ${stateClass} ${selected ? 'selected' : ''} ${focused ? 'focused' : ''} ${dense ? 'dense' : ''}`} onClick={onSelect} onDoubleClick={onOpen}>
    <div className="tile-topline">
      <button className={`tile-check ${selected ? 'checked' : ''}`} aria-label={`Select ${device.name}`} onClick={event => { event.stopPropagation(); onToggle(); }}>{selected && <Check size={12}/>}</button>
      <div className="device-title"><strong>{device.name}</strong><span>{device.id.toUpperCase()}</span></div>
      <span className={`platform ${device.platform.toLowerCase()}`}>{device.platform}</span>
      <span className={`online-state ${device.status.toLowerCase()}`}><i/>{device.status}</span>
    </div>
    <div className="screen-frame">
      <div className={`sim-screen screen-${device.screenshotSeed}`}>
        <div className="phone-status"><span>9:41</span><span><Radio size={9}/><Wifi size={9}/><BatteryMedium size={10}/></span></div>
        <div className="screen-content">
          <span className="app-eyebrow">{device.currentApp}</span>
          <strong>{device.screenshotSeed % 3 === 0 ? 'Overview' : device.screenshotSeed % 3 === 1 ? 'Activity' : 'Workspace'}</strong>
          <div className="screen-visual"><i/><i/><i/></div>
          <div className="screen-lines"><i/><i/><i/></div>
        </div>
        {device.status === 'OFFLINE' && <div className="screen-offline"><WifiOff size={24}/><strong>Signal lost</strong><span>Reconnecting session</span></div>}
      </div>
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
