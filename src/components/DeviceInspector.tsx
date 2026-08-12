import { Activity, BatteryMedium, Bot, CirclePause, CirclePlay, Cpu, ExternalLink, Hand, ListTree, Radio, RotateCcw, ScrollText, Smartphone, Thermometer, Wifi, X } from 'lucide-react';
import type { DeviceSession } from '../domain';

interface Props { device: DeviceSession | null; onClose: () => void; onFullscreen: (id: string) => void; onOffline: (id: string) => void }

export function DeviceInspector({ device, onClose, onFullscreen, onOffline }: Props) {
  if (!device) return <aside className="inspector empty-inspector"><Smartphone size={28}/><strong>No device selected</strong></aside>;
  return <aside className="inspector">
    <div className="inspector-head"><div><span>DEVICE INSPECTOR</span><strong>{device.name}</strong><small>{device.model} · {device.id}</small></div><button onClick={onClose} title="Close inspector"><X size={17}/></button></div>
    <div className="inspector-live">
      <div className={`mini-live screen-${device.screenshotSeed}`}><div className="live-app"><span>{device.currentApp}</span><strong>{device.status === 'OFFLINE' ? 'Connection unavailable' : 'Live session'}</strong></div></div>
      <button className="takeover-button"><Hand size={15}/> Take control</button>
      <button className="open-live" onClick={() => onFullscreen(device.id)} title="Open large view"><ExternalLink size={16}/></button>
    </div>
    <div className="quick-stats">
      <span><Radio/> <strong>{device.metrics.latency || '--'} ms</strong><small>LATENCY</small></span>
      <span><Cpu/> <strong>{device.metrics.cpu}%</strong><small>CPU</small></span>
      <span><BatteryMedium/> <strong>{device.metrics.battery}%</strong><small>BATTERY</small></span>
      <span><Thermometer/> <strong>{device.metrics.temperature || '--'}°C</strong><small>TEMP</small></span>
    </div>
    <section className="inspector-section task-panel">
      <div className="section-title"><span><Bot size={14}/> ACTIVE TASK</span><b className={device.currentTask?.status.toLowerCase()}>{device.currentTask?.status ?? 'IDLE'}</b></div>
      <strong>{device.currentTask?.goal ?? 'Agent is ready for a new goal'}</strong>
      {device.currentTask && <div className="progress"><i style={{ width: device.currentTask.status === 'WAITING' ? '8%' : '62%' }}/></div>}
      <div className="task-actions"><button title="Pause"><CirclePause size={15}/></button><button title="Resume"><CirclePlay size={15}/></button><button title="Retry"><RotateCcw size={15}/></button></div>
    </section>
    <section className="inspector-section timeline">
      <div className="section-title"><span><ListTree size={14}/> AGENT TIMELINE</span><small>LIVE</small></div>
      <div className="timeline-list">{device.actionHistory.map(event => <div className={`timeline-event ${event.kind.toLowerCase()}`} key={event.id}><i/><time>{event.time}</time><div><b>{event.kind}</b><p>{event.message}</p></div></div>)}</div>
    </section>
    <section className="inspector-section info-grid">
      <div className="section-title"><span><Activity size={14}/> DEVICE HEALTH</span><b className={device.health.toLowerCase()}>{device.health}</b></div>
      <dl><div><dt>Platform</dt><dd>{device.platform}</dd></div><div><dt>Network</dt><dd><Wifi size={12}/>{device.metrics.network}</dd></div><div><dt>Stream</dt><dd>{device.stream.width}×{device.stream.height}</dd></div><div><dt>Agent session</dt><dd>rev {device.sessionRevision}</dd></div></dl>
    </section>
    <section className="inspector-section logs"><div className="section-title"><span><ScrollText size={14}/> SESSION LOG</span></div><code>09:42:14 action.tap completed (84ms)</code><code>09:42:15 ui.change detected</code><code>09:42:17 screenshot queued</code></section>
    <button className="disconnect-test" onClick={() => onOffline(device.id)}>{device.status === 'OFFLINE' ? 'Simulate recovery' : 'Simulate disconnect'}</button>
  </aside>;
}
