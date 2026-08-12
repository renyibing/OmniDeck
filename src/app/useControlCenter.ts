import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LAYOUTS, type DeviceGroup, type LayoutSize, type WorkspacePreset } from '../domain';
import type { DeviceConfigurationDTO, DeviceDetailDTO, DeviceSummaryDTO, DiscoveredDeviceDTO, EventEnvelope, IOSWdaStatusDTO, RuntimeSnapshot, UiHierarchyDTO } from '../server/protocol';
import { ControlCenterClient, type ConnectionState, type DeviceAction, type ScreenTapPoint } from './controlCenterClient';
import { reorderDeviceIds, sortDevicesForWall } from './deviceOrdering';

function readJSON<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; }
}

const layoutForCount = (count: number): LayoutSize => LAYOUTS.find(size => size >= count) ?? 32;

export function useControlCenter() {
  const client = useRef(new ControlCenterClient()).current;
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [devices, setDevices] = useState<DeviceSummaryDTO[]>([]);
  const [detail, setDetail] = useState<DeviceDetailDTO | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [detailVersion, setDetailVersion] = useState(0);
  const [customGroups, setCustomGroups] = useState<DeviceGroup[]>(() => readJSON('omnideck.custom-groups', []));
  const legacyWorkspace = useRef(readJSON<WorkspacePreset | null>('omnideck.workspace', null)).current;
  const [workspaces, setWorkspaces] = useState<WorkspacePreset[]>(() => {
    const saved = readJSON<WorkspacePreset[]>('omnideck.workspaces', []);
    return saved.length ? saved : legacyWorkspace ? [legacyWorkspace] : [];
  });
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(() => localStorage.getItem('omnideck.active-workspace') ?? legacyWorkspace?.id ?? null);
  const initialWorkspace = useRef(workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? null).current;
  const [groupId, setGroupIdState] = useState(() => initialWorkspace?.groupId ?? localStorage.getItem('omnideck.group') ?? 'all');
  const [layout, setLayoutState] = useState<LayoutSize>(() => {
    if (initialWorkspace && LAYOUTS.includes(initialWorkspace.layout)) return initialWorkspace.layout;
    const stored = Number(localStorage.getItem('omnideck.layout'));
    return LAYOUTS.includes(stored as LayoutSize) ? stored as LayoutSize : 16;
  });
  const [manualDeviceOrder, setManualDeviceOrder] = useState<string[]>(() => readJSON('omnideck.device-order', []));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(['device-01']));
  const [focusedId, setFocusedId] = useState<string | null>('device-01');
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [wallOnly, setWallOnly] = useState(false);
  const [lastAnchor, setLastAnchor] = useState<string | null>('device-01');
  const [toast, setToast] = useState<string | null>(null);
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDeviceDTO[]>([]);
  const [wdaStatuses, setWdaStatuses] = useState<Record<string, IOSWdaStatusDTO>>({});
  const [uiTree, setUiTree] = useState<{ deviceId: string; tree: UiHierarchyDTO } | null>(null);
  const [uiTreeLoading, setUiTreeLoading] = useState(false);
  const [connectionPanelOpen, setConnectionPanelOpen] = useState(false);
  const [discoveryState, setDiscoveryState] = useState<'idle' | 'detecting' | 'ready' | 'failed'>('idle');
  const [workspaceName, setWorkspaceName] = useState('');
  const selectedId = fullscreenId ?? focusedId;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const groups = useMemo(() => [...(runtime?.groups ?? []), ...customGroups], [runtime?.groups, customGroups]);
  const activeGroup = groups.find(group => group.id === groupId) ?? groups[0];
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? null;
  const activeDeviceIds = activeWorkspace?.deviceIds ?? activeGroup?.deviceIds ?? [];
  const orderedGroupDevices = useMemo(
    () => sortDevicesForWall(devices, activeDeviceIds, manualDeviceOrder),
    [devices, activeDeviceIds, manualDeviceOrder],
  );
  const visibleDevices = orderedGroupDevices.slice(0, layout);
  const visibleDeviceKey = visibleDevices.map(device => device.id).join(',');
  const selectedSummary = devices.find(device => device.id === selectedId) ?? null;
  const selectedDevice = selectedSummary && detail?.id === selectedSummary.id ? { ...selectedSummary, ...detail } : selectedSummary;

  const refreshWdaStatus = useCallback((deviceId: string) => {
    void client.getWdaStatus(deviceId).then(status => {
      setWdaStatuses(current => ({ ...current, [deviceId]: status }));
    }).catch(error => setToast(error instanceof Error ? error.message : 'WDA status unavailable'));
  }, [client]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void client.getRuntime(controller.signal).then(next => {
      if (cancelled) return;
      setRuntime(next);
      setDevices(next.devices);
      setConnection('connecting');
      const stop = client.subscribe(next.server.latestSequence, applyEvent, setConnection, resync => {
        setRuntime(resync);
        setDevices(resync.devices);
        setDetailVersion(version => version + 1);
      });
      cleanup.current = stop;
    }).catch(() => { if (!cancelled) setConnection('disconnected'); });
    const cleanup = { current: (() => undefined) as () => void };
    return () => { cancelled = true; controller.abort(); cleanup.current(); };

    function applyEvent(event: EventEnvelope) {
      if (event.type === 'DEVICE_UPDATED' && event.payload.snapshot) {
        const snapshot = event.payload.snapshot as DeviceSummaryDTO;
        setDevices(current => current.map(device => device.id === snapshot.id ? snapshot : device));
      }
      if (event.type === 'DEVICE_CONFIGURED' && event.payload.snapshot) {
        const snapshot = event.payload.snapshot as DeviceSummaryDTO;
        setDevices(current => current.map(device => device.id === snapshot.id ? snapshot : device));
      }
      if (event.type === 'WORKER_POOL_UPDATED' && event.payload.workers) {
        setRuntime(current => current ? { ...current, workers: event.payload.workers as RuntimeSnapshot['workers'], resources: (event.payload.resources ?? current.resources) as RuntimeSnapshot['resources'], server: { ...current.server, latestSequence: event.sequence } } : current);
      } else {
        setRuntime(current => current ? { ...current, server: { ...current.server, latestSequence: event.sequence } } : current);
      }
      if (event.deviceId === selectedIdRef.current) setDetailVersion(version => version + 1);
    }
  }, [client]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    void client.getDeviceDetail(selectedId, controller.signal).then(setDetail).catch(() => undefined);
    return () => controller.abort();
  }, [client, selectedId, detailVersion]);

  useEffect(() => { setUiTree(null); }, [selectedId]);

  useEffect(() => {
    if (!selectedSummary || selectedSummary.platform !== 'IOS') return;
    const controller = new AbortController();
    void client.getWdaStatus(selectedSummary.id, controller.signal).then(status => {
      setWdaStatuses(current => ({ ...current, [selectedSummary.id]: status }));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [client, selectedSummary?.id, selectedSummary?.connection.state, selectedSummary?.configuration?.wdaUrl]);

  useEffect(() => {
    if (!runtime || !activeGroup) return;
    const command = { commandId: crypto.randomUUID(), timestamp: Date.now(), layout, focusedId, fullscreenId, visibleDeviceIds: visibleDevices.map(device => device.id), targetDeviceIds: devices.map(device => device.id) } as const;
    void client.applyStreamPolicy(command).catch(error => setToast(error instanceof Error ? error.message : 'Stream policy unavailable'));
    localStorage.setItem('omnideck.layout', String(layout));
  }, [client, runtime?.server.sessionEpoch, layout, focusedId, fullscreenId, visibleDeviceKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (fullscreenId) setFullscreenId(null);
        else if (wallOnly) setWallOnly(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreenId, wallOnly]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    localStorage.setItem('omnideck.device-order', JSON.stringify(manualDeviceOrder));
  }, [manualDeviceOrder]);

  const sendAction = useCallback((id: string, action: DeviceAction, appId?: string) => {
    void client.deviceAction(id, action, crypto.randomUUID(), appId).catch(error => setToast(error instanceof Error ? error.message : `${action} failed`));
  }, [client]);

  const tapDevice = useCallback((id: string, point: ScreenTapPoint, source: 'LIVE_PREVIEW' | 'FULLSCREEN_PREVIEW' = 'LIVE_PREVIEW') => {
    void client.tapDevice(id, point, source).catch(error => setToast(error instanceof Error ? error.message : 'Screen input failed'));
  }, [client]);

  const runManualCommand = useCallback((id: string, command: () => Promise<void>, fallback: string) => {
    void command().then(() => setDetailVersion(version => version + 1)).catch(error => setToast(error instanceof Error ? error.message : fallback));
  }, []);

  const manualBack = useCallback((id: string) => runManualCommand(id, () => client.backDevice(id), 'Back failed'), [client, runManualCommand]);
  const manualHome = useCallback((id: string) => runManualCommand(id, () => client.homeDevice(id), 'Home failed'), [client, runManualCommand]);
  const manualInputText = useCallback((id: string, text: string) => runManualCommand(id, () => client.inputTextDevice(id, text), 'Text input failed'), [client, runManualCommand]);
  const manualLongPress = useCallback((id: string, point: ScreenTapPoint = { x: 0.5, y: 0.5 }) => runManualCommand(id, () => client.longPressDevice(id, point), 'Long press failed'), [client, runManualCommand]);
  const manualStopApp = useCallback((id: string) => {
    const appId = devices.find(device => device.id === id)?.currentApp ?? 'Omni Market';
    runManualCommand(id, () => client.stopAppDevice(id, appId), 'Stop app failed');
  }, [client, devices, runManualCommand]);
  const manualSwipe = useCallback((id: string, direction: 'UP' | 'DOWN') => {
    const input = direction === 'UP'
      ? { from: { x: 0.5, y: 0.78 }, to: { x: 0.5, y: 0.28 }, durationMs: 360 }
      : { from: { x: 0.5, y: 0.28 }, to: { x: 0.5, y: 0.78 }, durationMs: 360 };
    runManualCommand(id, () => client.swipeDevice(id, input), `Swipe ${direction.toLowerCase()} failed`);
  }, [client, runManualCommand]);

  const refreshUiTree = useCallback((id: string) => {
    setUiTreeLoading(true);
    void client.getUiTree(id).then(tree => {
      setUiTree({ deviceId: id, tree });
      setDetailVersion(version => version + 1);
    }).catch(error => setToast(error instanceof Error ? error.message : 'UI tree unavailable'))
      .finally(() => setUiTreeLoading(false));
  }, [client]);

  const discoverDevices = useCallback(() => {
    setDiscoveryState('detecting');
    void client.discoverDevices().then(found => {
      setDiscoveredDevices(found);
      setDiscoveryState('ready');
      found.filter(device => device.platform === 'IOS').forEach(device => refreshWdaStatus(device.deviceId));
    }).catch(error => {
      setDiscoveryState('failed');
      setToast(error instanceof Error ? error.message : 'Device discovery failed');
    });
  }, [client, refreshWdaStatus]);

  const configureDevice = useCallback((configuration: DeviceConfigurationDTO) => {
    void client.configureDevice(configuration).then(snapshot => {
      setDevices(current => current.map(device => device.id === snapshot.id ? snapshot : device));
      setFocusedId(snapshot.id);
      setSelectedIds(new Set([snapshot.id]));
      if (snapshot.platform === 'IOS') refreshWdaStatus(snapshot.id);
      setToast(`${snapshot.name} configuration saved`);
    }).catch(error => setToast(error instanceof Error ? error.message : 'Device configuration failed'));
  }, [client, refreshWdaStatus]);

  const connectDevice = useCallback((id: string) => {
    const summary = devices.find(device => device.id === id);
    void (async () => {
      if (summary?.platform === 'IOS') {
        const readiness = await client.getWdaStatus(id);
        setWdaStatuses(current => ({ ...current, [id]: readiness }));
        if (!isWdaConnectable(readiness)) {
          setToast(`${readiness.state}: ${readiness.lastError ?? readiness.nextAction}`);
          return;
        }
      }
      return client.connectDevice(id);
    })().then(snapshot => {
      if (!snapshot) return;
      setDevices(current => current.map(device => device.id === snapshot.id ? snapshot : device));
      setFocusedId(snapshot.id);
      setSelectedIds(new Set([snapshot.id]));
      if (snapshot.platform === 'IOS') refreshWdaStatus(snapshot.id);
      setToast(`${snapshot.name} connected`);
    }).catch(error => setToast(error instanceof Error ? error.message : 'Device connection failed'));
  }, [client, devices, refreshWdaStatus]);

  const reorderVisibleDevices = useCallback((sourceId: string, targetId: string) => {
    setManualDeviceOrder(current => reorderDeviceIds(current, sourceId, targetId, visibleDevices.map(device => device.id)));
  }, [visibleDeviceKey]);

  const setGroupId = (nextId: string) => {
    const next = groups.find(group => group.id === nextId) ?? groups[0];
    if (!next) return;
    setGroupIdState(next.id);
    setLayoutState(next.preferredLayout);
    setSelectedIds(new Set());
    setFocusedId(next.deviceIds[0] ?? null);
    setActiveWorkspaceId(null);
    localStorage.setItem('omnideck.group', next.id);
    localStorage.removeItem('omnideck.active-workspace');
  };

  const setWorkspace = (workspaceId: string) => {
    const workspace = workspaces.find(item => item.id === workspaceId);
    if (!workspace) { setActiveWorkspaceId(null); localStorage.removeItem('omnideck.active-workspace'); return; }
    setActiveWorkspaceId(workspace.id);
    setGroupIdState(workspace.groupId);
    setLayoutState(workspace.layout);
    setSelectedIds(new Set());
    setFocusedId(workspace.deviceIds[0] ?? null);
    localStorage.setItem('omnideck.active-workspace', workspace.id);
  };

  const selectDevice = (id: string, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    setFocusedId(id);
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (event.shiftKey && lastAnchor) {
        const ids = visibleDevices.map(device => device.id);
        const start = ids.indexOf(lastAnchor);
        const end = ids.indexOf(id);
        if (start >= 0 && end >= 0) ids.slice(Math.min(start, end), Math.max(start, end) + 1).forEach(item => next.add(item));
      } else if (event.metaKey || event.ctrlKey) {
        if (next.has(id)) next.delete(id); else next.add(id);
      } else { next.clear(); next.add(id); }
      return next;
    });
    setLastAnchor(id);
  };

  const toggleCheckbox = (id: string) => setSelectedIds(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setSelectedIds(new Set(visibleDevices.map(device => device.id)));
  const clearSelection = () => setSelectedIds(new Set());
  const closeInspector = () => { setSelectedIds(new Set()); setFocusedId(null); };

  const runBatch = (goal = 'Open target app and verify the home screen') => {
    const targetIds = [...selectedIds].filter(id => devices.find(device => device.id === id)?.status === 'ONLINE');
    if (!targetIds.length) return setToast('Select at least one online device');
    void client.submitBatch({ commandId: crypto.randomUUID(), timestamp: Date.now(), targetDeviceIds: targetIds, goal, priority: 1 })
      .then(() => setToast(`${targetIds.length} independent task instances queued`))
      .catch(error => setToast(error instanceof Error ? error.message : 'Batch task failed'));
  };

  const applyBatchAction = (action: 'PAUSED' | 'RUNNING' | 'STOPPED' | 'RESTART_APP' | 'LAUNCH_APP') => {
    const mapped: Record<typeof action, DeviceAction> = { PAUSED: 'pause', RUNNING: 'resume', STOPPED: 'stop', RESTART_APP: 'restart-app', LAUNCH_APP: 'launch-app' };
    selectedIds.forEach(id => sendAction(id, mapped[action]));
    setToast(`${action.replace('_', ' ')} sent to ${selectedIds.size} sessions`);
  };

  const toggleOffline = (id: string) => sendAction(id, devices.find(device => device.id === id)?.status === 'OFFLINE' ? 'recover' : 'disconnect');
  const saveWorkspace = () => {
    const name = workspaceName.trim() || `${activeGroup?.name ?? 'Device'} workspace`;
    const workspace: WorkspacePreset = { id: `workspace-${Date.now()}`, name, layout, deviceIds: visibleDevices.map(device => device.id), groupId };
    const next = [...workspaces, workspace];
    setWorkspaces(next); setActiveWorkspaceId(workspace.id);
    localStorage.setItem('omnideck.workspaces', JSON.stringify(next));
    localStorage.setItem('omnideck.active-workspace', workspace.id);
    localStorage.removeItem('omnideck.workspace'); setWorkspaceName(''); setToast(`Workspace "${name}" saved`);
  };
  const createCustomGroup = () => {
    if (!selectedIds.size) return setToast('Select devices before creating a group');
    const name = workspaceName.trim() || `Custom Group ${customGroups.length + 1}`;
    const group: DeviceGroup = { id: `custom-${Date.now()}`, name, deviceIds: [...selectedIds], preferredLayout: layoutForCount(selectedIds.size) };
    const next = [...customGroups, group]; setCustomGroups(next); localStorage.setItem('omnideck.custom-groups', JSON.stringify(next));
    setWorkspaceName(''); setGroupIdState(group.id); setLayoutState(group.preferredLayout); setToast(`Group "${name}" created with ${selectedIds.size} devices`);
  };

  const stats = useMemo(() => ({
    total: devices.length,
    online: devices.filter(device => device.status === 'ONLINE').length,
    running: devices.filter(device => device.agentStatus === 'RUNNING').length,
    idle: devices.filter(device => device.agentStatus === 'IDLE').length,
    errors: devices.filter(device => device.status === 'ERROR' || device.status === 'OFFLINE').length,
    human: devices.filter(device => device.agentStatus === 'HUMAN_CONTROL').length,
  }), [devices]);

  return {
    devices, groups, workspaces, activeWorkspaceId, groupId, layout, visibleDevices, selectedIds, focusedId, fullscreenId, wallOnly,
    selectedDevice, stats, workerSnapshot: runtime?.workers ?? { active: 0, queued: 0, completed: 0 }, connection, workspaceName, toast,
    setLayout: setLayoutState, setGroupId, setWorkspace, selectDevice, toggleCheckbox, selectAll, clearSelection, closeInspector,
    setFullscreenId, setWallOnly, runBatch, applyBatchAction, toggleOffline, takeHumanControl: (id: string) => sendAction(id, 'take-control'),
    releaseHumanControl: (id: string) => sendAction(id, 'release-control'),
    pauseDevice: (id: string) => sendAction(id, 'pause'), resumeDevice: (id: string) => sendAction(id, 'resume'), retryDevice: (id: string) => sendAction(id, 'retry'),
    setWorkspaceName, saveWorkspace, createCustomGroup, discoveredDevices, connectionPanelOpen, setConnectionPanelOpen,
    discoveryState, discoverDevices, configureDevice, connectDevice, tapDevice, reorderVisibleDevices, wdaStatuses, refreshWdaStatus,
    manualBack, manualHome, manualInputText, manualLongPress, manualSwipe, manualStopApp, refreshUiTree, uiTree: uiTree?.deviceId === selectedId ? uiTree.tree : null, uiTreeLoading,
  };
}

function isWdaConnectable(status: IOSWdaStatusDTO): boolean {
  return status.state === 'WDA_READY' || status.state === 'SESSION_CONNECTED';
}
