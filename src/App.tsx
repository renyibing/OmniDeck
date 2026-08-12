import { BatchActionBar } from './components/BatchActionBar';
import { DeviceGrid } from './components/DeviceGrid';
import { DeviceInspector } from './components/DeviceInspector';
import { FullscreenDevice } from './components/FullscreenDevice';
import { MonitorToolbar } from './components/MonitorToolbar';
import { StatusBar } from './components/StatusBar';
import { useControlCenter } from './app/useControlCenter';

export default function App() {
  const center = useControlCenter();
  const fullscreenDevice = center.devices.find(device => device.id === center.fullscreenId);

  if (fullscreenDevice) return <FullscreenDevice device={fullscreenDevice} onClose={() => center.setFullscreenId(null)}/>;

  return <div className={`app-shell ${center.wallOnly ? 'wall-only' : ''}`}>
    {!center.wallOnly && <StatusBar stats={center.stats} workers={center.workerSnapshot}/>}
    {!center.wallOnly && <MonitorToolbar groups={center.groups} groupId={center.groupId} layout={center.layout} selectedCount={center.selectedIds.size} workspaceName={center.workspaceName} onGroup={center.setGroupId} onLayout={center.setLayout} onSelectAll={center.selectAll} onWallOnly={() => center.setWallOnly(true)} onName={center.setWorkspaceName} onSave={center.saveWorkspace} onCreateGroup={center.createCustomGroup}/>}
    <main className="control-surface">
      <section className="wall-section">
        {center.wallOnly && <div className="wall-overlay"><strong>OmniDeck Monitor</strong><span>{center.visibleDevices.length} channels · Press ESC to exit</span></div>}
        <DeviceGrid devices={center.visibleDevices} layout={center.layout} selectedIds={center.selectedIds} focusedId={center.focusedId} onSelect={(id, event) => center.selectDevice(id, event)} onToggle={center.toggleCheckbox} onOpen={id => center.setFullscreenId(id)}/>
      </section>
      {!center.wallOnly && <DeviceInspector device={center.selectedDevice} onClose={center.closeInspector} onFullscreen={id => center.setFullscreenId(id)} onOffline={center.toggleOffline}/>}
    </main>
    {!center.wallOnly && <BatchActionBar count={center.selectedIds.size} onClear={center.clearSelection} onRun={() => center.runBatch()} onAction={center.applyBatchAction}/>}
    {center.toast && <div className="toast" role="status">{center.toast}</div>}
  </div>;
}
