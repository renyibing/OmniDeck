import { AppWindow, CirclePause, CirclePlay, Play, RotateCcw, Square, X } from 'lucide-react';

interface Props { count: number; onClear: () => void; onRun: () => void; onAction: (action: 'PAUSED' | 'RUNNING' | 'STOPPED' | 'RESTART_APP' | 'LAUNCH_APP') => void }

export function BatchActionBar({ count, onClear, onRun, onAction }: Props) {
  if (!count) return null;
  return <div className="batch-bar"><div className="selection-count"><strong>{count}</strong><span>selected</span></div><div className="batch-divider"/><button className="primary-action" onClick={onRun}><Play size={15}/> Run task</button><button onClick={() => onAction('PAUSED')}><CirclePause size={15}/> Pause</button><button onClick={() => onAction('RUNNING')}><CirclePlay size={15}/> Resume</button><button onClick={() => onAction('STOPPED')}><Square size={14}/> Stop</button><button onClick={() => onAction('RESTART_APP')}><RotateCcw size={15}/> Restart app</button><button onClick={() => onAction('LAUNCH_APP')}><AppWindow size={15}/> Launch app</button><button className="clear-batch" onClick={onClear} title="Clear selection"><X size={17}/></button></div>;
}
