import { AlertTriangle, CheckCircle2, CirclePause, Clock3, FileSearch, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import type { DeviceSummaryDTO, TaskAuditDTO, TaskSummaryDTO } from '../server/protocol';
import type { TaskStatus } from '../domain/types';

const STATUS_FILTERS: Array<TaskStatus | 'ALL'> = ['ALL', 'RUNNING', 'WAITING', 'WAITING_APPROVAL', 'FAILED', 'SUCCESS', 'PAUSED', 'DEVICE_OFFLINE'];

interface Props {
  tasks: TaskSummaryDTO[];
  total: number;
  loading: boolean;
  devices: DeviceSummaryDTO[];
  statusFilter: TaskStatus | 'ALL';
  deviceFilter: string;
  selectedTaskId: string | null;
  audit: TaskAuditDTO | null;
  auditLoading: boolean;
  onStatusFilter: (status: TaskStatus | 'ALL') => void;
  onDeviceFilter: (deviceId: string) => void;
  onSelectTask: (taskId: string) => void;
  onApproveTask: (deviceId: string, taskId: string) => void;
  onRejectTask: (deviceId: string, taskId: string) => void;
  onBackToWall: () => void;
}

export function TaskCenter(props: Props) {
  const selectedTask = props.tasks.find(task => task.taskId === props.selectedTaskId) ?? props.audit?.task ?? null;
  const artifacts = props.audit?.artifacts.slice(-8).reverse() ?? [];
  const trace = props.audit?.trace.slice(-8).reverse() ?? [];
  const approvalPending = props.audit?.task.status === 'WAITING_APPROVAL' || selectedTask?.status === 'WAITING_APPROVAL';

  return <section className="task-center">
    <header className="task-center-head">
      <div><span>GLOBAL TASK CENTER</span><strong>Task audit and approval queue</strong><small>{props.total} indexed tasks · summaries only</small></div>
      <button type="button" onClick={props.onBackToWall}><RefreshCw size={15}/> Monitor Wall</button>
    </header>
    <div className="task-center-toolbar">
      <label>Status<select value={props.statusFilter} onChange={event => props.onStatusFilter(event.target.value as TaskStatus | 'ALL')}>
        {STATUS_FILTERS.map(status => <option key={status} value={status}>{status}</option>)}
      </select></label>
      <label>Device<select value={props.deviceFilter} onChange={event => props.onDeviceFilter(event.target.value)}>
        <option value="ALL">ALL DEVICES</option>
        {props.devices.map(device => <option key={device.id} value={device.id}>{device.name} · {device.id}</option>)}
      </select></label>
      <span>{props.loading ? 'Loading task index...' : `${props.tasks.length} shown`}</span>
    </div>
    <div className="task-center-body">
      <div className="task-table-wrap">
        <table className="task-table">
          <thead><tr><th>Task</th><th>Device</th><th>Status</th><th>Steps</th><th>AI</th><th>Artifacts</th><th>Approval</th><th>Updated</th></tr></thead>
          <tbody>
            {props.tasks.map(task => <tr key={task.taskId} className={task.taskId === props.selectedTaskId ? 'selected' : ''} onClick={() => props.onSelectTask(task.taskId)}>
              <td><strong>{task.goal}</strong><small>{task.taskId}</small></td>
              <td><span>{task.deviceName}</span><small>{task.platform} · {task.deviceId}</small></td>
              <td><TaskStatusBadge task={task}/></td>
              <td>{formatSteps(task)}</td>
              <td>{formatAiCost(task)}</td>
              <td>{task.artifactCount}</td>
              <td><ApprovalLabel task={task}/></td>
              <td>{formatTime(task.updatedAt)}</td>
            </tr>)}
            {!props.tasks.length && <tr><td colSpan={8} className="task-empty">No tasks match this filter.</td></tr>}
          </tbody>
        </table>
      </div>
      <aside className="task-audit-drawer">
        <div className="section-title"><span><FileSearch size={14}/> TASK AUDIT DETAIL</span><b className={props.auditLoading ? 'degraded' : 'healthy'}>{props.auditLoading ? 'LOADING' : props.audit ? 'READY' : 'SELECT TASK'}</b></div>
        {selectedTask ? <>
          <div className="task-audit-summary">
            <strong>{selectedTask.goal}</strong>
            <small>{selectedTask.taskId}</small>
            <dl>
              <div><dt>Device</dt><dd>{selectedTask.deviceName}</dd></div>
              <div><dt>Status</dt><dd>{selectedTask.status}</dd></div>
              <div><dt>Duration</dt><dd>{formatDuration(selectedTask)}</dd></div>
              <div><dt>Steps</dt><dd>{formatSteps(selectedTask)}</dd></div>
              <div><dt>AI Cost</dt><dd>{formatAiCost(selectedTask)}</dd></div>
              <div><dt>Latency</dt><dd>{formatLatency(selectedTask)}</dd></div>
              <div><dt>Error</dt><dd>{selectedTask.error ?? '--'}</dd></div>
            </dl>
          </div>
          {approvalPending && <div className="approval-card task-center-approval">
            <strong>Human approval required</strong>
            <p>{selectedTask.deviceName} · {selectedTask.taskId}</p>
            <div className="task-actions"><button onClick={() => props.onApproveTask(selectedTask.deviceId, selectedTask.taskId)}><ShieldCheck size={14}/> Approve</button><button onClick={() => props.onRejectTask(selectedTask.deviceId, selectedTask.taskId)}><ShieldX size={14}/> Reject</button></div>
          </div>}
          <code>Artifact types: {formatArtifactTypes(props.audit)}</code>
          <div className="task-audit-columns">
            <section><h3>Step Trace</h3>{trace.length ? trace.map(record => <div className="task-audit-row" key={record.stepId}><b>#{record.stepIndex} {record.status}</b><small>{formatTrace(record)}</small></div>) : <p>No step trace for this task.</p>}</section>
            <section><h3>Artifacts</h3>{artifacts.length ? artifacts.map(artifact => <div className="task-audit-row" key={artifact.artifactId}><b>{artifact.type}</b><small>{artifact.retention} · {artifact.redactionStatus} · {artifact.hasBinary ? 'binary' : 'metadata only'}</small>{artifact.redactedPayload && <details><summary>redacted payload</summary><code>{truncate(JSON.stringify(artifact.redactedPayload))}</code></details>}</div>) : <p>No artifacts for this task.</p>}</section>
          </div>
        </> : <p className="task-empty">Select a task to inspect trace and artifact metadata.</p>}
      </aside>
    </div>
  </section>;
}

function TaskStatusBadge({ task }: { task: TaskSummaryDTO }) {
  const Icon = task.status === 'SUCCESS' ? CheckCircle2 : task.status === 'FAILED' || task.status === 'DEVICE_OFFLINE' ? AlertTriangle : task.status === 'PAUSED' ? CirclePause : Clock3;
  return <span className={`task-status-badge ${task.status.toLowerCase()}`}><Icon size={13}/>{task.status}</span>;
}

function ApprovalLabel({ task }: { task: TaskSummaryDTO }) {
  if (!task.requiresApproval) return <span className="approval-label muted">--</span>;
  return <span className={`approval-label ${(task.approvalStatus ?? 'PENDING').toLowerCase()}`}>{task.approvalStatus ?? 'PENDING'}</span>;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour12: false });
}

function formatDuration(task: TaskSummaryDTO): string {
  const end = task.finishedAt ?? Date.now();
  return `${Math.max(0, Math.round((end - task.createdAt) / 1000))}s`;
}

function formatSteps(task: TaskSummaryDTO): string {
  const max = task.maxSteps ?? '--';
  return `${task.completedSteps}/${max}`;
}

function formatAiCost(task: TaskSummaryDTO): string {
  const tokens = task.totalTokens ?? 0;
  const cost = task.estimatedCostUsd;
  if (!tokens && cost === null) return '--';
  return cost === null ? `${tokens} tok` : `${tokens} tok · $${cost.toFixed(4)}`;
}

function formatLatency(task: TaskSummaryDTO): string {
  const total = task.totalStepLatencyMs ?? task.totalRunLatencyMs;
  return total === null ? '--' : `${Math.round(total)}ms`;
}

function formatArtifactTypes(audit: TaskAuditDTO | null): string {
  if (!audit?.artifactSummary.total) return 'none';
  return Object.entries(audit.artifactSummary.byType).map(([type, count]) => `${type}=${count}`).join(' · ');
}

function formatTrace(record: TaskAuditDTO['trace'][number]): string {
  const action = typeof record.plannedAction?.type === 'string' ? record.plannedAction.type : 'observation';
  const verification = record.verification?.result ? `verify=${record.verification.result}` : 'verify=--';
  const approval = record.approval?.decision ? `approval=${record.approval.decision}` : record.approval?.required ? 'approval=PENDING' : 'approval=--';
  return `${action} · ${verification} · ${approval}`;
}

function truncate(value: string): string {
  return value.length > 420 ? `${value.slice(0, 420)}...` : value;
}
