import type { DevicePressKey, ScreenTapPoint } from '../app/controlCenterClient';
import { useState } from 'react';
import { Activity, ArrowDown, ArrowUp, BatteryMedium, Bot, Cable, CirclePause, CirclePlay, Cpu, ExternalLink, Hand, Keyboard, ListChecks, ListTree, MousePointerClick, Radio, RefreshCw, RotateCcw, ScrollText, ShieldCheck, ShieldX, Smartphone, Terminal, Thermometer, Wifi, X } from 'lucide-react';
import type { NativeSelectedDeviceProcess } from '../app/useNativeHost';
import type { AgentArtifactDTO, AgentArtifactSummaryDTO, AgentStateDTO, AgentTaskTraceDTO, DeviceDetailDTO, DeviceSummaryDTO, IOSWdaStatusDTO, UiHierarchyDTO } from '../server/protocol';
import { DeviceScreen } from './DeviceScreen';

interface Props {
  device: (DeviceSummaryDTO | DeviceDetailDTO) | null;
  onClose: () => void;
  onFullscreen: (id: string) => void;
  onOffline: (id: string) => void;
  onTakeControl: (id: string) => void;
  onReleaseControl: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
  onTap: (id: string, point: ScreenTapPoint) => void;
  onPreviewSwipe: (id: string, from: ScreenTapPoint, to: ScreenTapPoint) => void;
  onPreviewLongPress: (id: string, point: ScreenTapPoint) => void;
  onPreviewScroll: (id: string, point: ScreenTapPoint, deltaX: number, deltaY: number) => void;
  onPreviewInputText: (id: string, text: string) => void;
  onPreviewPressKey: (id: string, key: DevicePressKey) => void;
  onBack: (id: string) => void;
  onHome: (id: string) => void;
  onInputText: (id: string, text: string) => void;
  onLongPress: (id: string) => void;
  onSwipe: (id: string, direction: 'UP' | 'DOWN') => void;
  onStopApp: (id: string) => void;
  onRefreshUiTree: (id: string) => void;
  uiTree: UiHierarchyDTO | null;
  uiTreeLoading: boolean;
  agentState: AgentStateDTO | null;
  taskAudit: { deviceId: string; taskId: string; trace: AgentTaskTraceDTO[]; artifacts: AgentArtifactDTO[]; summary: AgentArtifactSummaryDTO } | null;
  taskAuditLoading: boolean;
  onApproveTask: (id: string, taskId: string) => void;
  onRejectTask: (id: string, taskId: string) => void;
  wdaStatus?: IOSWdaStatusDTO;
  nativeProcess?: NativeSelectedDeviceProcess;
  onRefreshWda: (id: string) => void;
}

export function DeviceInspector({ device, onClose, onFullscreen, onOffline, onTakeControl, onReleaseControl, onPause, onResume, onRetry, onTap, onPreviewSwipe, onPreviewLongPress, onPreviewScroll, onPreviewInputText, onPreviewPressKey, onBack, onHome, onInputText, onLongPress, onSwipe, onStopApp, onRefreshUiTree, uiTree, uiTreeLoading, agentState, taskAudit, taskAuditLoading, onApproveTask, onRejectTask, wdaStatus, nativeProcess, onRefreshWda }: Props) {
  const [text, setText] = useState('');
  if (!device) return <aside className="inspector empty-inspector"><Smartphone size={28}/><strong>No device selected</strong></aside>;
  const canControl = device.agentStatus === 'HUMAN_CONTROL';
  const uiNodes = uiTree?.nodes.filter(node => node.text || node.resourceId || node.contentDesc || node.clickable).slice(0, 8) ?? [];
  const stepRecords = agentState?.recentStepRecords.slice(-8).reverse() ?? [];
  const auditArtifacts = taskAudit?.artifacts.slice(-6).reverse() ?? [];
  const taskTokenUsage = device.currentTask && 'tokenUsage' in device.currentTask ? device.currentTask.tokenUsage : null;
  const taskLatency = device.currentTask && 'latencyMs' in device.currentTask ? device.currentTask.latencyMs : null;
  return <aside className="inspector">
    <div className="inspector-head"><div><span>DEVICE INSPECTOR</span><strong>{device.name}</strong><small>{device.model} · {device.id}</small></div><button onClick={onClose} title="Close inspector"><X size={17}/></button></div>
    <div className="inspector-live">
      <DeviceScreen device={device} fallback="inspector" canControl={canControl} keyboardSurface="local" onTap={point => onTap(device.id, point)} onSwipe={(from, to) => onPreviewSwipe(device.id, from, to)} onLongPress={point => onPreviewLongPress(device.id, point)} onScroll={(point, deltaX, deltaY) => onPreviewScroll(device.id, point, deltaX, deltaY)} onInputText={text => onPreviewInputText(device.id, text)} onPressKey={key => onPreviewPressKey(device.id, key)}/>
      <button className="takeover-button" onClick={() => (device.agentStatus === 'HUMAN_CONTROL' ? onReleaseControl(device.id) : onTakeControl(device.id))}><Hand size={15}/> {device.agentStatus === 'HUMAN_CONTROL' ? 'Release control' : 'Take control'}</button>
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
      <div className="task-actions"><button title="Pause" onClick={() => onPause(device.id)}><CirclePause size={15}/></button><button title="Resume" onClick={() => onResume(device.id)}><CirclePlay size={15}/></button><button title="Retry" onClick={() => onRetry(device.id)}><RotateCcw size={15}/></button></div>
    </section>
    <section className="inspector-section agent-step-panel">
      <div className="section-title"><span><ListChecks size={14}/> AGENT STEP ENGINE</span><b className={agentState?.status === 'WAITING_APPROVAL' ? 'offline' : 'healthy'}>{agentState?.status ?? 'IDLE'}</b></div>
      {agentState?.pendingApproval && agentState.taskInstanceId && <div className="approval-card">
        <strong>Human approval required</strong>
        <p>{formatAction(agentState.pendingApproval)}</p>
        <div className="task-actions"><button onClick={() => onApproveTask(device.id, agentState.taskInstanceId!)}><ShieldCheck size={14}/> Approve</button><button onClick={() => onRejectTask(device.id, agentState.taskInstanceId!)}><ShieldX size={14}/> Reject</button></div>
      </div>}
      <dl>
        <div><dt>Step</dt><dd>{agentState?.currentStep ?? 0}</dd></div>
        <div><dt>Max</dt><dd>{device.currentTask?.maxSteps ?? '--'}</dd></div>
        <div><dt>AI Tokens</dt><dd>{taskTokenUsage?.known ? taskTokenUsage.totalTokens : '--'}</dd></div>
        <div><dt>Latency</dt><dd>{taskLatency ? `${Math.round(taskLatency.totalStepMs)} ms` : '--'}</dd></div>
        <div><dt>UI nodes</dt><dd>{agentState?.lastObservation?.uiHierarchy.nodeCount ?? '--'}</dd></div>
        <div><dt>Screenshot</dt><dd>{agentState?.lastObservation ? `${agentState.lastObservation.screenshot.width}×${agentState.lastObservation.screenshot.height}` : '--'}</dd></div>
      </dl>
      <code>Last planned: {agentState?.lastPlannedAction ? formatAction(agentState.lastPlannedAction) : 'No planned action yet'}</code>
      <code>Last result: {agentState?.lastObservation?.lastActionResult ?? 'No action result yet'}</code>
      <div className="step-trace-list">
        {stepRecords.length ? stepRecords.map(record => <div className="step-trace-item" key={record.stepId}>
          <span><b>#{record.stepIndex}</b><i className={record.status.toLowerCase()}>{record.status}</i></span>
          <strong>{formatStepAction(record.plannedAction)}</strong>
          <small>{formatStepMeta(record)}</small>
        </div>) : <p>No step trace yet</p>}
      </div>
    </section>
    <section className="inspector-section task-audit-panel">
      <div className="section-title"><span><ListChecks size={14}/> TASK AUDIT</span><b className={taskAuditLoading ? 'degraded' : 'healthy'}>{taskAuditLoading ? 'LOADING' : `${taskAudit?.summary.total ?? 0} ARTIFACTS`}</b></div>
      <dl>
        <div><dt>Task</dt><dd>{taskAudit?.taskId ?? device.currentTask?.id ?? '--'}</dd></div>
        <div><dt>Trace</dt><dd>{taskAudit?.trace.length ?? 0} steps</dd></div>
        <div><dt>Approval</dt><dd>{formatAuditApproval(taskAudit?.trace)}</dd></div>
      </dl>
      <code>By type: {formatArtifactTypes(taskAudit?.summary)}</code>
      <div className="artifact-list">
        {auditArtifacts.length ? auditArtifacts.map(artifact => <div className="artifact-item" key={artifact.artifactId}>
          <span><b>{artifact.type}</b><i>{artifact.retention}</i></span>
          <small>{artifact.hasBinary ? 'binary available' : 'metadata only'} · {artifact.redactionStatus} · step {artifact.stepId.split(':step-')[1]?.split(':')[0] ?? '--'}</small>
        </div>) : <p>{taskAuditLoading ? 'Loading selected task audit...' : 'No selected-task artifacts yet'}</p>}
      </div>
    </section>
    <section className="inspector-section manual-panel">
      <div className="section-title"><span><MousePointerClick size={14}/> DEVICE CONTROL</span><b className={canControl ? 'healthy' : 'degraded'}>{canControl ? 'HUMAN_CONTROL' : 'TAKE OVER REQUIRED'}</b></div>
      <div className="manual-actions">
        <button disabled={!canControl} onClick={() => onBack(device.id)}>Back</button>
        <button disabled={!canControl} onClick={() => onHome(device.id)}>Home</button>
        <button disabled={!canControl} onClick={() => onSwipe(device.id, 'UP')}><ArrowUp size={13}/> Swipe</button>
        <button disabled={!canControl} onClick={() => onSwipe(device.id, 'DOWN')}><ArrowDown size={13}/> Swipe</button>
        <button disabled={!canControl} onClick={() => onLongPress(device.id)}>Long press</button>
        <button disabled={!canControl} onClick={() => onStopApp(device.id)}>Stop app</button>
      </div>
      <div className="manual-text-row">
        <Keyboard size={14}/>
        <input value={text} onChange={event => setText(event.target.value)} placeholder="Input text" disabled={!canControl}/>
        <button disabled={!canControl || !text} onClick={() => { onInputText(device.id, text); setText(''); }}>Send</button>
      </div>
      {!canControl && <p>Take control before sending manual device actions.</p>}
      <div className="ui-tree-preview">
        <button type="button" onClick={() => onRefreshUiTree(device.id)} disabled={uiTreeLoading}><ListTree size={13}/> {uiTreeLoading ? 'Loading UI tree' : 'Load UI tree'}</button>
        {uiTree && <small>{uiTree.nodes.length} nodes · selected-device detail only</small>}
        {uiNodes.map(node => <code key={node.id}>{node.text || node.contentDesc || node.resourceId || node.className} [{Math.round(node.bounds.centerX)},{Math.round(node.bounds.centerY)}]</code>)}
      </div>
    </section>
    {device.platform === 'IOS' && <section className="inspector-section wda-panel">
      <div className="section-title"><span><Cable size={14}/> WDA READINESS</span><b className={wdaTone(wdaStatus)}>{wdaStatus?.state ?? 'UNKNOWN'}</b></div>
      <dl>
        <div><dt>URL</dt><dd>{wdaStatus?.wdaUrl ?? device.configuration?.wdaUrl ?? 'Not assigned'}</dd></div>
        <div><dt>Local port</dt><dd>{wdaStatus?.localPort ?? '--'}</dd></div>
        <div><dt>iproxy</dt><dd>{wdaStatus?.iproxyDetected ? 'Detected' : 'Missing'}</dd></div>
        <div><dt>/status</dt><dd>{wdaStatus?.statusReady ? 'Ready' : 'Not ready'}</dd></div>
        <div><dt>Session</dt><dd>{wdaStatus?.sessionReady ? 'Connected' : device.connection.state}</dd></div>
      </dl>
      <p>{wdaStatus?.lastError ?? wdaStatus?.nextAction ?? 'Check WDA status before connecting this iOS device.'}</p>
      {wdaStatus?.commands.iproxy && <code>{wdaStatus.commands.iproxy}</code>}
      {wdaStatus?.commands.xcodebuild && <code>{wdaStatus.commands.xcodebuild}</code>}
      <button type="button" onClick={() => onRefreshWda(device.id)}><RefreshCw size={13}/> Check WDA</button>
    </section>}
    {nativeProcess && <section className="inspector-section native-process-panel">
      <div className="section-title"><span><Terminal size={14}/> NATIVE PROCESS</span><b className={processTone(nativeProcess)}>{nativeProcess.loading ? 'LOADING' : processHeadline(device.platform, nativeProcess)}</b></div>
      <dl>
        <div><dt>Kind</dt><dd>{nativeProcess.processes[0]?.key.processKind ?? (device.platform === 'ANDROID' ? 'SCRCPY' : 'IPROXY')}</dd></div>
        <div><dt>Status</dt><dd>{nativeProcess.processes[0]?.status ?? 'STOPPED'}</dd></div>
        <div><dt>PID</dt><dd>{nativeProcess.processes[0]?.pid ?? '--'}</dd></div>
        <div><dt>Identifier</dt><dd>{device.configuration?.identifier ?? '--'}</dd></div>
        {device.platform === 'IOS' && <div><dt>WDA port</dt><dd>{nativeProcess.allocatedWdaPort?.localPort ?? nativeProcess.processes[0]?.command.match(/^.*?\s(\d{4,5})\s8100/u)?.[1] ?? '--'}</dd></div>}
      </dl>
      <code>{nativeProcess.processes[0]?.command ?? 'No native process started for selected device'}</code>
      {nativeProcess.processes[0]?.lastError && <p>{nativeProcess.processes[0].lastError}</p>}
      <div className="native-process-actions">
        <button onClick={nativeProcess.refresh} disabled={nativeProcess.loading}><RefreshCw size={13}/> Refresh</button>
        {device.platform === 'ANDROID' && <button onClick={nativeProcess.startScrcpy} disabled={nativeProcess.loading || !device.configuration?.identifier}>Start scrcpy</button>}
        {device.platform === 'ANDROID' && <button onClick={nativeProcess.stopScrcpy} disabled={nativeProcess.loading}>Stop scrcpy</button>}
        {device.platform === 'IOS' && <button onClick={nativeProcess.allocateWdaPort} disabled={nativeProcess.loading || !device.configuration?.identifier}>Allocate WDA port</button>}
        {device.platform === 'IOS' && <button onClick={nativeProcess.startIproxy} disabled={nativeProcess.loading || !device.configuration?.identifier}>Start iproxy</button>}
        {device.platform === 'IOS' && <button onClick={nativeProcess.stopIproxy} disabled={nativeProcess.loading}>Stop iproxy</button>}
      </div>
      <div className="native-log-tail">
        {nativeProcess.logs.slice(-5).map((line, index) => <code key={`${index}-${line}`}>{line}</code>)}
        {!nativeProcess.logs.length && <small>Selected-device native logs only. MonitorWall remains lightweight.</small>}
      </div>
    </section>}
    <section className="inspector-section timeline">
      <div className="section-title"><span><ListTree size={14}/> AGENT TIMELINE</span><small>LIVE</small></div>
      <div className="timeline-list">{'actionHistory' in device ? device.actionHistory.map(event => <div className={`timeline-event ${event.kind.toLowerCase()}`} key={event.id}><i/><time>{event.time}</time><div><b>{event.kind}</b><p>{event.message}</p></div></div>) : <p className="detail-loading">Loading selected-device timeline...</p>}</div>
    </section>
    <section className="inspector-section info-grid">
      <div className="section-title"><span><Activity size={14}/> DEVICE HEALTH</span><b className={device.health.toLowerCase()}>{device.health}</b></div>
      <dl><div><dt>Platform</dt><dd>{device.platform}</dd></div><div><dt>Network</dt><dd><Wifi size={12}/>{device.metrics.network}</dd></div><div><dt>Stream</dt><dd>{device.stream.width}×{device.stream.height}</dd></div><div><dt>Agent session</dt><dd>rev {device.sessionRevision}</dd></div></dl>
    </section>
    <section className="inspector-section logs"><div className="section-title"><span><ScrollText size={14}/> SESSION LOG</span></div>{'logs' in device ? device.logs.slice(-8).map(entry => <code key={entry.id}>{entry.time} {entry.kind.toLowerCase()} {entry.message}</code>) : <code>Loading selected-device logs...</code>}</section>
    <button className="disconnect-test" onClick={() => onOffline(device.id)}>{device.status === 'OFFLINE' ? 'Simulate recovery' : 'Simulate disconnect'}</button>
  </aside>;
}

function processHeadline(platform: DeviceSummaryDTO['platform'], nativeProcess: NativeSelectedDeviceProcess): string {
  const status = nativeProcess.processes[0]?.status;
  if (status) return status;
  return platform === 'ANDROID' ? 'SCRCPY STOPPED' : 'IPROXY STOPPED';
}

function processTone(nativeProcess: NativeSelectedDeviceProcess): string {
  const status = nativeProcess.processes[0]?.status;
  if (status === 'RUNNING') return 'healthy';
  if (status === 'FAILED') return 'offline';
  return 'degraded';
}

function wdaTone(status?: IOSWdaStatusDTO): string {
  if (!status) return 'degraded';
  if (status.state === 'WDA_READY' || status.state === 'SESSION_CONNECTED') return 'healthy';
  if (status.state === 'PORT_TUNNEL_MISSING' || status.state === 'WDA_NOT_RUNNING' || status.state === 'SIGNING_REQUIRED') return 'offline';
  return 'degraded';
}

function formatAction(action: Record<string, unknown>): string {
  return Object.entries(action)
    .filter(([key]) => !['deviceId', 'taskInstanceId'].includes(key))
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

function formatStepAction(action: Record<string, unknown> | undefined): string {
  if (!action) return 'Observation pending';
  const type = typeof action.type === 'string' ? action.type : 'action';
  const reason = typeof action.reason === 'string' ? action.reason : '';
  return reason ? `${type}: ${reason}` : type;
}

function formatStepMeta(record: NonNullable<AgentStateDTO['recentStepRecords']>[number]): string {
  const nodes = record.observation.uiHierarchySummary?.nodeCount ?? '--';
  const screenshot = record.observation.screenshot ? `${record.observation.screenshot.width}×${record.observation.screenshot.height}` : '--';
  const execution = record.execution?.result ? `exec=${record.execution.result}` : 'exec=--';
  const verification = record.verification?.result ? `verify=${record.verification.result}` : 'verify=--';
  const approval = record.approval?.decision ? `approval=${record.approval.decision}` : record.approval?.required ? 'approval=required' : 'approval=--';
  return `ui=${nodes} screenshot=${screenshot} ${execution} ${verification} ${approval}`;
}

function formatArtifactTypes(summary: AgentArtifactSummaryDTO | undefined): string {
  if (!summary || !Object.keys(summary.byType).length) return '--';
  return Object.entries(summary.byType).map(([type, count]) => `${type}=${count}`).join(' ');
}

function formatAuditApproval(trace: AgentTaskTraceDTO[] | undefined): string {
  const approval = [...(trace ?? [])].reverse().find(record => record.approval)?.approval;
  if (!approval) return '--';
  return approval.decision ?? (approval.required ? 'REQUIRED' : '--');
}
