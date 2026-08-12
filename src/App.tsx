import { BatchActionBar } from './components/BatchActionBar';
import { DeviceGrid } from './components/DeviceGrid';
import { DeviceInspector } from './components/DeviceInspector';
import { FullscreenDevice } from './components/FullscreenDevice';
import { MonitorToolbar } from './components/MonitorToolbar';
import { StatusBar } from './components/StatusBar';
import { DeviceSetupPanel } from './components/DeviceSetupPanel';
import { useControlCenter } from './app/useControlCenter';

export default function App() {
  const center = useControlCenter();
  const fullscreenDevice = center.devices.find(device => device.id === center.fullscreenId);

  if (fullscreenDevice) return <FullscreenDevice device={fullscreenDevice} onClose={() => center.setFullscreenId(null)} onTakeControl={center.takeHumanControl} onReleaseControl={center.releaseHumanControl} onTap={(id, point) => center.tapDevice(id, point, 'FULLSCREEN_PREVIEW')}/>;

  return <div className={`app-shell ${center.wallOnly ? 'wall-only' : ''}`}>
    {!center.wallOnly && <StatusBar stats={center.stats} workers={center.workerSnapshot} connection={center.connection}/>}
    {!center.wallOnly && <MonitorToolbar groups={center.groups} workspaces={center.workspaces} activeWorkspaceId={center.activeWorkspaceId} groupId={center.groupId} layout={center.layout} selectedCount={center.selectedIds.size} workspaceName={center.workspaceName} onGroup={center.setGroupId} onWorkspace={center.setWorkspace} onLayout={center.setLayout} onSelectAll={center.selectAll} onWallOnly={() => center.setWallOnly(true)} onName={center.setWorkspaceName} onSave={center.saveWorkspace} onCreateGroup={center.createCustomGroup} onDeviceSetup={() => center.setConnectionPanelOpen(true)}/>}
    <main className="control-surface">
      <section className="wall-section">
        {center.wallOnly && <div className="wall-overlay"><strong>OmniDeck Monitor</strong><span>{center.visibleDevices.length} channels · Press ESC to exit</span></div>}
        <DeviceGrid devices={center.visibleDevices} layout={center.layout} selectedIds={center.selectedIds} focusedId={center.focusedId} onSelect={(id, event) => center.selectDevice(id, event)} onToggle={center.toggleCheckbox} onOpen={id => center.setFullscreenId(id)} onTap={(id, point) => center.tapDevice(id, point, 'LIVE_PREVIEW')} onReorder={center.reorderVisibleDevices}/>
      </section>
      {!center.wallOnly && <DeviceInspector device={center.selectedDevice} wdaStatus={center.selectedDevice ? center.wdaStatuses[center.selectedDevice.id] : undefined} uiTree={center.uiTree} uiTreeLoading={center.uiTreeLoading} onRefreshWda={center.refreshWdaStatus} onRefreshUiTree={center.refreshUiTree} onBack={center.manualBack} onHome={center.manualHome} onInputText={center.manualInputText} onLongPress={center.manualLongPress} onSwipe={center.manualSwipe} onStopApp={center.manualStopApp} onClose={center.closeInspector} onFullscreen={id => center.setFullscreenId(id)} onOffline={center.toggleOffline} onTakeControl={center.takeHumanControl} onReleaseControl={center.releaseHumanControl} onPause={center.pauseDevice} onResume={center.resumeDevice} onRetry={center.retryDevice} onTap={(id, point) => center.tapDevice(id, point, 'LIVE_PREVIEW')}/>}
    </main>
    {!center.wallOnly && <BatchActionBar count={center.selectedIds.size} onClear={center.clearSelection} onRun={() => center.runBatch()} onAction={center.applyBatchAction}/>}
    <DeviceSetupPanel open={center.connectionPanelOpen} candidates={center.discoveredDevices} discoveryState={center.discoveryState} devices={center.devices} wdaStatuses={center.wdaStatuses} onClose={() => center.setConnectionPanelOpen(false)} onDiscover={center.discoverDevices} onConfigure={center.configureDevice} onConnect={center.connectDevice} onRefreshWda={center.refreshWdaStatus}/>
    {center.toast && <div className="toast" role="status">{center.toast}</div>}
  </div>;
}
