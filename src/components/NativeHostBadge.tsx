import { RefreshCw, Square, Terminal, Zap } from 'lucide-react';
import type { NativeHostController } from '../app/useNativeHost';

interface Props { host: NativeHostController }

export function NativeHostBadge({ host }: Props) {
  if (!host.available) return null;
  const running = host.status?.running === true;
  return <div className={`native-host-badge ${running ? 'running' : 'stopped'}`} title={host.error ?? host.status?.command ?? 'OmniDeck native host'}>
    <Terminal size={14}/>
    <span><b>Desktop</b><small>{running ? `daemon ${host.status?.pid ?? ''}` : 'daemon stopped'}</small></span>
    {running
      ? <button onClick={host.stopDaemon} disabled={host.loading} title="Stop ControlDaemon"><Square size={12}/></button>
      : <button onClick={host.startDaemon} disabled={host.loading} title="Start ControlDaemon"><Zap size={12}/></button>}
    <button onClick={host.refresh} disabled={host.loading} title="Refresh native host"><RefreshCw size={12}/></button>
    {host.error && <i>!</i>}
  </div>;
}
