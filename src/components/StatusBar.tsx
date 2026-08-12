import { Bot, CircleAlert, Cpu, Hand, Radio, Smartphone, WifiOff } from 'lucide-react';
import type { ConnectionState } from '../app/controlCenterClient';

interface Props { stats: { total: number; online: number; running: number; idle: number; errors: number; human: number }; workers: { active: number; queued: number }; connection: ConnectionState }

export function StatusBar(props: Props) {
  const { stats, workers } = props;
  const items = [
    { label: 'Devices', value: stats.total, icon: Smartphone, tone: 'neutral' },
    { label: 'Online', value: stats.online, icon: Radio, tone: 'good' },
    { label: 'AI running', value: stats.running, icon: Bot, tone: 'active' },
    { label: 'Idle', value: stats.idle, icon: Cpu, tone: 'neutral' },
    { label: 'Errors', value: stats.errors, icon: CircleAlert, tone: 'danger' },
    { label: 'Human', value: stats.human, icon: Hand, tone: 'warn' },
  ];
  return <div className="status-bar">
    <div className="brand"><span className="brand-mark">O</span><div><strong>OmniDeck</strong><small>CONTROL CENTER</small></div></div>
    <div className="status-metrics">{items.map(({ label, value, icon: Icon, tone }) => <div className={`status-metric ${tone}`} key={label}><Icon size={14}/><strong>{value}</strong><span>{label}</span></div>)}</div>
    <div className={`pool-status connection-${props.connection}`}><span className="pulse-dot"/>{props.connection === 'disconnected' && <WifiOff size={13}/>}<span>{props.connection === 'connected' ? `${workers.active}/8 workers` : props.connection}</span>{workers.queued > 0 && <b>{workers.queued} queued</b>}</div>
  </div>;
}
