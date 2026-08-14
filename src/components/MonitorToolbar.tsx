import { CheckCheck, Expand, FolderPlus, Grid3X3, ListChecks, MonitorUp, Save, SlidersHorizontal, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { LAYOUTS, type DeviceGroup, type LayoutSize, type WorkspacePreset } from '../domain';

interface Props {
  groups: DeviceGroup[]; workspaces: WorkspacePreset[]; activeWorkspaceId: string | null; groupId: string; layout: LayoutSize; selectedCount: number; workspaceName: string; activeView: 'MONITOR' | 'TASK_CENTER';
  nativeHost?: ReactNode;
  onGroup: (id: string) => void; onWorkspace: (id: string) => void; onLayout: (layout: LayoutSize) => void; onSelectAll: () => void; onWallOnly: () => void; onName: (value: string) => void; onSave: () => void; onCreateGroup: () => void; onDeviceSetup: () => void; onTaskCenter: () => void;
}

export function MonitorToolbar(props: Props) {
  return <div className="monitor-toolbar">
    <div className="toolbar-section group-control"><Grid3X3 size={16}/><select aria-label="Device group" value={props.groupId} onChange={event => props.onGroup(event.target.value)}>{props.groups.map(group => <option value={group.id} key={group.id}>{group.name} · {group.deviceIds.length}</option>)}</select></div>
    <div className="toolbar-section group-control"><Save size={15}/><select aria-label="Saved workspace" value={props.activeWorkspaceId ?? ''} onChange={event => props.onWorkspace(event.target.value)}><option value="">No workspace</option>{props.workspaces.map(workspace => <option value={workspace.id} key={workspace.id}>{workspace.name} · {workspace.deviceIds.length}</option>)}</select></div>
    <div className="layout-control" aria-label="Monitor layout">{LAYOUTS.map(size => <button className={props.layout === size ? 'active' : ''} key={size} onClick={() => props.onLayout(size)} title={`${size} camera layout`}>{size}</button>)}</div>
    {props.nativeHost}
    <div className="toolbar-spacer"/>
    <button className={`tool-button ${props.activeView === 'TASK_CENTER' ? 'active' : ''}`} onClick={props.onTaskCenter} title="Open global task center"><ListChecks size={16}/><span>{props.activeView === 'TASK_CENTER' ? 'Monitor' : 'Task center'}</span></button>
    <button className="tool-button" onClick={props.onSelectAll} title="Select all visible devices"><CheckCheck size={16}/><span>Select all</span>{props.selectedCount > 0 && <b>{props.selectedCount}</b>}</button>
    <button className="tool-button setup-entry" onClick={props.onDeviceSetup} title="Detect and configure mobile devices"><Smartphone size={16}/><span>Device setup</span></button>
    <div className="workspace-save"><input aria-label="Workspace name" placeholder="Workspace name" value={props.workspaceName} onChange={event => props.onName(event.target.value)}/><button onClick={props.onSave} title="Save workspace"><Save size={16}/></button></div>
    <button className="icon-button" onClick={props.onCreateGroup} title="Create group from selection"><FolderPlus size={17}/></button>
    <button className="icon-button" title="Stream policy"><SlidersHorizontal size={17}/></button>
    <button className="icon-button" onClick={props.onWallOnly} title="Full screen monitor"><MonitorUp size={17}/></button>
    <button className="icon-button compact-hide" onClick={props.onWallOnly} title="Expand"><Expand size={17}/></button>
  </div>;
}
