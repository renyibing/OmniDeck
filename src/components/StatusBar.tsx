import { Bot, CircleAlert, Cpu, Hand, Radio, Smartphone } from 'lucide-react';

interface Props { stats: { total: number; online: number; running: number; idle: number; errors: number; human: number }; workers: { active: number; queued: number } }

export function StatusBar({ stats, workers }: Props) {
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
    <div className="pool-status"><span className="pulse-dot"/><span>{workers.active}/8 workers</span>{workers.queued > 0 && <b>{workers.queued} queued</b>}</div>
  </div>;
}
