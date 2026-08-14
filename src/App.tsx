import { BatchActionBar } from './components/BatchActionBar';
import { DeviceGrid } from './components/DeviceGrid';
import { DeviceInspector } from './components/DeviceInspector';
import { FullscreenDevice } from './components/FullscreenDevice';
import { MonitorToolbar } from './components/MonitorToolbar';
import { NativeHostBadge } from './components/NativeHostBadge';
import { StatusBar } from './components/StatusBar';
import { TaskCenter } from './components/TaskCenter';
import { DeviceSetupPanel } from './components/DeviceSetupPanel';
import { useControlCenter } from './app/useControlCenter';
import { useNativeHost } from './app/useNativeHost';

export default function App() {
  const center = useControlCenter();
  const nativeHost = useNativeHost(center.selectedDevice);
  const fullscreenDevice = center.devices.find(device => device.id === center.fullscreenId);

  if (fullscreenDevice) {
    return <FullscreenDevice
      device={fullscreenDevice}
      onClose={() => center.setFullscreenId(null)}
      onTakeControl={center.takeHumanControl}
      onReleaseControl={center.releaseHumanControl}
      onTap={(id, point) => center.tapDevice(id, point, 'FULLSCREEN_PREVIEW')}
      onSwipe={(id, from, to) => center.swipeDevice(id, from, to, 'FULLSCREEN_PREVIEW')}
      onLongPress={(id, point) => center.longPressDevice(id, point, 'FULLSCREEN_PREVIEW')}
      onScroll={(id, point, deltaX, deltaY) => center.scrollDevice(id, point, deltaX, deltaY, 'FULLSCREEN_PREVIEW')}
      onInputText={(id, text) => center.previewInputText(id, text, 'FULLSCREEN_PREVIEW')}
      onPressKey={(id, key) => center.previewPressKey(id, key, 'FULLSCREEN_PREVIEW')}
    />;
  }

  return <div className={`app-shell ${center.wallOnly ? 'wall-only' : ''}`}>
    {!center.wallOnly && <StatusBar stats={center.stats} workers={center.workerSnapshot} connection={center.connection}/>}
    {!center.wallOnly && <MonitorToolbar groups={center.groups} workspaces={center.workspaces} activeWorkspaceId={center.activeWorkspaceId} groupId={center.groupId} layout={center.layout} selectedCount={center.selectedIds.size} workspaceName={center.workspaceName} activeView={center.activeView} nativeHost={<NativeHostBadge host={nativeHost}/>} onGroup={center.setGroupId} onWorkspace={center.setWorkspace} onLayout={center.setLayout} onSelectAll={center.selectAll} onWallOnly={() => center.setWallOnly(true)} onName={center.setWorkspaceName} onSave={center.saveWorkspace} onCreateGroup={center.createCustomGroup} onDeviceSetup={() => center.setConnectionPanelOpen(true)} onTaskCenter={() => center.setActiveView(center.activeView === 'TASK_CENTER' ? 'MONITOR' : 'TASK_CENTER')}/>}
    <main className={`control-surface ${center.activeView === 'TASK_CENTER' ? 'task-center-surface' : ''}`}>
      {center.activeView === 'TASK_CENTER' && !center.wallOnly ? <TaskCenter tasks={center.taskList} total={center.taskListTotal} loading={center.taskListLoading} devices={center.devices} statusFilter={center.taskFilterStatus} deviceFilter={center.taskFilterDeviceId} selectedTaskId={center.taskCenterSelectedTaskId} audit={center.taskCenterAudit} auditLoading={center.taskCenterAuditLoading} onStatusFilter={center.setTaskFilterStatus} onDeviceFilter={center.setTaskFilterDeviceId} onSelectTask={center.setTaskCenterSelectedTaskId} onApproveTask={center.approveTask} onRejectTask={center.rejectTask} onBackToWall={() => center.setActiveView('MONITOR')}/> : <>
      <section className="wall-section">
        {center.wallOnly && <div className="wall-overlay"><strong>OmniDeck Monitor</strong><span>{center.visibleDevices.length} channels · Press ESC to exit</span></div>}
        <DeviceGrid
          devices={center.visibleDevices}
          layout={center.layout}
          selectedIds={center.selectedIds}
          focusedId={center.focusedId}
          onSelect={(id, event) => center.selectDevice(id, event)}
          onToggle={center.toggleCheckbox}
          onOpen={id => center.setFullscreenId(id)}
          onTap={(id, point) => center.tapDevice(id, point, 'LIVE_PREVIEW')}
          onSwipe={(id, from, to) => center.swipeDevice(id, from, to, 'LIVE_PREVIEW')}
          onLongPress={(id, point) => center.longPressDevice(id, point, 'LIVE_PREVIEW')}
          onScroll={(id, point, deltaX, deltaY) => center.scrollDevice(id, point, deltaX, deltaY, 'LIVE_PREVIEW')}
          onInputText={(id, text) => center.previewInputText(id, text, 'LIVE_PREVIEW')}
          onPressKey={(id, key) => center.previewPressKey(id, key, 'LIVE_PREVIEW')}
          onFocusDevice={center.focusDeviceForControl}
          onReorder={center.reorderVisibleDevices}
        />
      </section>
      {!center.wallOnly && <DeviceInspector device={center.selectedDevice} nativeProcess={nativeHost.available ? nativeHost.selectedDeviceProcess : undefined} wdaStatus={center.selectedDevice ? center.wdaStatuses[center.selectedDevice.id] : undefined} uiTree={center.uiTree} uiTreeLoading={center.uiTreeLoading} agentState={center.agentState} taskAudit={center.taskAudit} taskAuditLoading={center.taskAuditLoading} onApproveTask={center.approveTask} onRejectTask={center.rejectTask} onRefreshWda={center.refreshWdaStatus} onRefreshUiTree={center.refreshUiTree} onBack={center.manualBack} onHome={center.manualHome} onInputText={center.manualInputText} onLongPress={center.manualLongPress} onSwipe={center.manualSwipe} onStopApp={center.manualStopApp} onClose={center.closeInspector} onFullscreen={id => center.setFullscreenId(id)} onOffline={center.toggleOffline} onTakeControl={center.takeHumanControl} onReleaseControl={center.releaseHumanControl} onPause={center.pauseDevice} onResume={center.resumeDevice} onRetry={center.retryDevice} onTap={(id, point) => center.tapDevice(id, point, 'LIVE_PREVIEW')} onPreviewSwipe={(id, from, to) => center.swipeDevice(id, from, to, 'LIVE_PREVIEW')} onPreviewLongPress={(id, point) => center.longPressDevice(id, point, 'LIVE_PREVIEW')} onPreviewScroll={(id, point, deltaX, deltaY) => center.scrollDevice(id, point, deltaX, deltaY, 'LIVE_PREVIEW')} onPreviewInputText={(id, text) => center.previewInputText(id, text, 'LIVE_PREVIEW')} onPreviewPressKey={(id, key) => center.previewPressKey(id, key, 'LIVE_PREVIEW')}/>}
      </>}
    </main>
    {!center.wallOnly && center.activeView === 'MONITOR' && <BatchActionBar count={center.selectedIds.size} onClear={center.clearSelection} onRun={() => center.runBatch()} onAction={center.applyBatchAction}/>}
    <DeviceSetupPanel open={center.connectionPanelOpen} candidates={center.discoveredDevices} discoveryState={center.discoveryState} devices={center.devices} wdaStatuses={center.wdaStatuses} onClose={() => center.setConnectionPanelOpen(false)} onDiscover={center.discoverDevices} onConfigure={center.configureDevice} onConnect={center.connectDevice} onDisconnect={center.disconnectConfiguredDevice} onRefreshWda={center.refreshWdaStatus}/>
    {(center.toast || nativeHost.error) && <div className="toast" role="status">{center.toast ?? nativeHost.error}</div>}
  </div>;
}
