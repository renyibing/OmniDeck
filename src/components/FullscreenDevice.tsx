import { ArrowLeft, Bot, Hand, Radio } from 'lucide-react';
import type { DeviceSession } from '../domain';

export function FullscreenDevice({ device, onClose }: { device: DeviceSession; onClose: () => void }) {
  return <div className="fullscreen-device"><header><button onClick={onClose}><ArrowLeft size={18}/> Back to monitor wall</button><div><strong>{device.name}</strong><span>{device.id} · session rev {device.sessionRevision}</span></div><span className="live-indicator"><i/> LIVE · 60 FPS</span><button className="takeover-button"><Hand size={16}/> Take control</button></header><main><div className={`large-phone screen-${device.screenshotSeed}`}><div className="phone-status"><span>9:41</span><span><Radio size={12}/></span></div><div className="large-app"><span>{device.currentApp}</span><strong>Account overview</strong><div className="large-chart"><i/><i/><i/><i/><i/><i/></div><div className="large-rows"><span/><span/><span/></div></div></div><aside><span><Bot size={16}/> AGENT SESSION</span><strong>{device.agentStatus}</strong><p>{device.currentTask?.goal ?? 'Waiting for task'}</p><small>Agent continues running independently while views change.</small></aside></main></div>;
}
