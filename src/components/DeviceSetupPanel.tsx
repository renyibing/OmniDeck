import { CheckCircle2, CircleAlert, PlugZap, Radar, RefreshCw, Smartphone, Unplug, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DeviceConfigurationDTO, DiscoveredDeviceDTO, IOSWdaStatusDTO } from '../server/protocol';

interface Props {
  open: boolean;
  candidates: DiscoveredDeviceDTO[];
  discoveryState: 'idle' | 'detecting' | 'ready' | 'failed';
  devices: Array<{ id: string; configuration: DeviceConfigurationDTO | null; connection: { state: string; error: string | null } }>;
  wdaStatuses: Record<string, IOSWdaStatusDTO>;
  onClose: () => void;
  onDiscover: () => void;
  onConfigure: (configuration: DeviceConfigurationDTO) => void;
  onConnect: (deviceId: string) => void;
  onDisconnect: (deviceId: string) => void;
  onRefreshWda: (deviceId: string) => void;
}

type FormState = Record<string, string>;

const initialForm = (candidate: DiscoveredDeviceDTO, configured?: DeviceConfigurationDTO | null): FormState => ({
  name: configured?.name ?? candidate.name,
  identifier: configured?.identifier ?? candidate.identifier,
  appId: configured?.appId ?? (candidate.platform === 'ANDROID' ? 'com.omnideck.market' : 'com.omnideck.market.ios'),
  wdaBundleId: configured?.wdaBundleId ?? 'com.omnideck.WebDriverAgentRunner',
  wdaUrl: configured?.wdaUrl ?? candidate.suggestedWdaUrl ?? '',
});

export function DeviceSetupPanel(props: Props) {
  if (!props.open) return null;
  return <div className="setup-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose(); }}>
    <aside className="device-setup-panel" aria-label="Device setup">
      <header className="setup-head">
        <div><span className="eyebrow">DEVICE ONBOARDING</span><h2>Detect & connect</h2><p>Scan host-connected Android and iPhone devices, then bind each session explicitly.</p></div>
        <button className="icon-button" onClick={props.onClose} title="Close device setup"><X size={17}/></button>
      </header>
      <div className="setup-toolbar">
        <button className="setup-detect" onClick={props.onDiscover} disabled={props.discoveryState === 'detecting'}><Radar size={15}/>{props.discoveryState === 'detecting' ? 'Detecting...' : 'Detect devices'}</button>
        <span className={`setup-state ${props.discoveryState}`}><i/>{props.discoveryState === 'idle' ? 'Not scanned' : props.discoveryState === 'detecting' ? 'Scanning host' : props.discoveryState === 'ready' ? `${props.candidates.length} candidates` : 'Detection failed'}</span>
      </div>
      <div className="setup-note">{props.candidates.some(candidate => !candidate.simulated) ? 'Native mode · commands run only for the explicit serial or UDID' : 'Simulation mode · no ADB or XCUITest commands are executed'}</div>
      <div className="setup-list">
        {(['ANDROID', 'IOS'] as const).map(platform => <section className="candidate-section" key={platform}>
          <div className="candidate-heading"><Smartphone size={14}/><strong>{platform === 'ANDROID' ? 'Android' : 'iOS'}</strong><span>{props.candidates.filter(item => item.platform === platform).length}</span></div>
          {props.candidates.filter(item => item.platform === platform).map(candidate => <CandidateCard key={candidate.candidateId} candidate={candidate} device={props.devices.find(item => item.id === candidate.deviceId)} wdaStatus={props.wdaStatuses[candidate.deviceId]} onConfigure={props.onConfigure} onConnect={props.onConnect} onDisconnect={props.onDisconnect} onRefreshWda={props.onRefreshWda}/>) }
          {props.discoveryState === 'ready' && !props.candidates.some(item => item.platform === platform) && <div className="candidate-empty">No connected {platform === 'ANDROID' ? 'USB / ADB' : 'trusted XCUITest'} devices found.</div>}
          {props.discoveryState !== 'ready' && !props.candidates.some(item => item.platform === platform) && <div className="candidate-empty">Run detection to find a {platform === 'ANDROID' ? 'USB / ADB' : 'trusted XCUITest'} device.</div>}
        </section>)}
      </div>
    </aside>
  </div>;
}

function CandidateCard({ candidate, device, wdaStatus, onConfigure, onConnect, onDisconnect, onRefreshWda }: { candidate: DiscoveredDeviceDTO; device?: Props['devices'][number]; wdaStatus?: IOSWdaStatusDTO; onConfigure: Props['onConfigure']; onConnect: Props['onConnect']; onDisconnect: Props['onDisconnect']; onRefreshWda: Props['onRefreshWda'] }) {
  const configured = device?.configuration;
  const [form, setForm] = useState<FormState>(() => initialForm(candidate, configured));
  const [dirty, setDirty] = useState(false);
  const identifierMismatch = Boolean(configured && configured.identifier !== candidate.identifier);
  useEffect(() => {
    if (!identifierMismatch) return;
    setForm(current => ({ ...current, identifier: candidate.identifier, name: candidate.name }));
    setDirty(true);
  }, [candidate.identifier, candidate.name, identifierMismatch]);
  const update = (key: string, value: string) => { setDirty(true); setForm(current => ({ ...current, [key]: value })); };
  const configuration: DeviceConfigurationDTO = {
    deviceId: candidate.deviceId, platform: candidate.platform, name: form.name, identifier: form.identifier,
    appId: form.appId, transport: candidate.transport, orientation: 'PORTRAIT',
    driverMode: candidate.driverMode,
    ...(candidate.platform === 'IOS' ? { wdaBundleId: form.wdaBundleId } : {}),
    ...(candidate.platform === 'IOS' && form.wdaUrl ? { wdaUrl: form.wdaUrl } : {}),
  };
  const connectionState = configured ? (device?.connection.state ?? 'DISCONNECTED') : 'DISCONNECTED';
  return <article className={`candidate-card ${candidate.platform.toLowerCase()}`}>
    <div className="candidate-meta"><div><strong>{candidate.name}</strong><span>{candidate.model} · {candidate.identifier}</span></div><span className={`auth-state ${candidate.authorization.toLowerCase()}`}><i/>{candidate.authorization.replace('_', ' ')}</span></div>
    <div className="candidate-chips"><span>{candidate.transport}</span><span>PORTRAIT</span><span>{candidate.simulated ? 'SIMULATED' : candidate.driverMode}</span></div>
    <div className="setup-form">
      <label>Device name<input value={form.name} onChange={event => update('name', event.target.value)}/></label>
      <label>{candidate.platform === 'ANDROID' ? 'Serial' : 'UDID'}<input value={form.identifier} onChange={event => update('identifier', event.target.value)}/></label>
      <label>{candidate.platform === 'ANDROID' ? 'App package' : 'Bundle ID'}<input value={form.appId} onChange={event => update('appId', event.target.value)}/></label>
      {candidate.platform === 'IOS' && <label>WDA runner bundle<input value={form.wdaBundleId} onChange={event => update('wdaBundleId', event.target.value)}/></label>}
      {candidate.platform === 'IOS' && <label>WDA URL<input value={form.wdaUrl} onChange={event => update('wdaUrl', event.target.value)} placeholder="http://127.0.0.1:8100" title="Automatically assigned local WDA endpoint; edit when using a custom tunnel"/></label>}
    </div>
    {candidate.platform === 'IOS' && <div className="wda-readiness">
      <div><span className={`wda-badge ${wdaTone(wdaStatus)}`}><i/>{wdaStatus?.state ?? (configured ? 'WDA CHECK PENDING' : 'WDA URL ASSIGNED')}</span><button type="button" onClick={() => onRefreshWda(candidate.deviceId)} title="Check WDA status"><RefreshCw size={12}/>Check</button></div>
      <p>{wdaStatus?.nextAction ?? (configured ? 'Check WDA before connecting.' : 'Save this iOS configuration before connecting.')}</p>
      {wdaStatus?.commands.iproxy && <code>{wdaStatus.commands.iproxy}</code>}
    </div>}
    {identifierMismatch && <div className="connection-error"><CircleAlert size={13}/>Detected {candidate.platform === 'ANDROID' ? 'serial' : 'UDID'} changed ({configured?.identifier} → {candidate.identifier}). Save config before connecting.</div>}
    <div className="candidate-actions">
      <span className={`connection-state ${connectionState.toLowerCase()}`}><i/>{connectionState}</span>
      <button onClick={() => onConfigure(configuration)} disabled={!form.name || !form.identifier || !form.appId || (candidate.platform === 'IOS' && !candidate.simulated && !form.wdaUrl) || (!dirty && Boolean(configured))}><CheckCircle2 size={14}/>{configured && !dirty ? 'Configured' : 'Save config'}</button>
      <button className="connect-action" onClick={() => onConnect(candidate.deviceId)} disabled={!configured || connectionState === 'CONNECTING'}><PlugZap size={14}/>{connectionState === 'CONNECTING' ? 'Connecting...' : 'Connect'}</button>
      {configured && <button onClick={() => onDisconnect(candidate.deviceId)} title="Disconnect and clear saved configuration"><Unplug size={14}/>Disconnect</button>}
    </div>
    {connectionState === 'FAILED' && device?.connection.error && <div className="connection-error"><CircleAlert size={13}/>{device.connection.error}</div>}
  </article>;
}

function wdaTone(status?: IOSWdaStatusDTO): string {
  if (!status) return 'pending';
  if (status.state === 'WDA_READY' || status.state === 'SESSION_CONNECTED') return 'ready';
  if (status.state === 'SIGNING_REQUIRED' || status.state === 'PORT_TUNNEL_MISSING' || status.state === 'WDA_NOT_RUNNING') return 'blocked';
  return 'pending';
}
