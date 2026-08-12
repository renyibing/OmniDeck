import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeviceManager, LAYOUTS, SessionManager, TaskScheduler, type DeviceGroup, type DeviceSession, type LayoutSize, type WorkspacePreset } from '../domain';

const concurrency = { maxConcurrentAI: 8, maxConcurrentVLM: 4, maxConcurrentADB: 12, maxConcurrentIOS: 4, timeoutMs: 90_000, maxRetries: 2, rateLimitPerMinute: 60 };

function createRuntime() {
  const deviceManager = new DeviceManager(32);
  const sessionManager = new SessionManager(deviceManager);
  const scheduler = new TaskScheduler(concurrency);
  deviceManager.getAll().forEach(device => {
    if (device.currentTask?.status === 'RUNNING') scheduler.workers.enqueue(device.currentTask);
  });
  return { deviceManager, sessionManager, scheduler };
}

const createGroups = (devices: DeviceSession[]): DeviceGroup[] => [
  { id: 'all', name: 'All devices', deviceIds: devices.map(d => d.id), preferredLayout: 32 },
  { id: 'android', name: 'Android', deviceIds: devices.filter(d => d.platform === 'ANDROID').map(d => d.id), preferredLayout: 25 },
  { id: 'ios', name: 'iPhone', deviceIds: devices.filter(d => d.platform === 'IOS').map(d => d.id), preferredLayout: 8 },
  { id: 'group-a', name: 'Test Group A', deviceIds: devices.slice(0, 16).map(d => d.id), preferredLayout: 16 },
  { id: 'group-b', name: 'Account Group B', deviceIds: devices.slice(16, 32).map(d => d.id), preferredLayout: 16 },
];

function readJSON<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; }
}

const layoutForCount = (count: number): LayoutSize => LAYOUTS.find(size => size >= count) ?? 32;

export function useControlCenter() {
  const runtime = useRef<ReturnType<typeof createRuntime> | null>(null);
  if (!runtime.current) runtime.current = createRuntime();
  const { deviceManager, sessionManager, scheduler } = runtime.current;
  const [devices, setDevices] = useState(() => deviceManager.getAll());
  const [customGroups, setCustomGroups] = useState<DeviceGroup[]>(() => readJSON('omnideck.custom-groups', []));
  const groups = useMemo(() => [...createGroups(devices), ...customGroups], [customGroups]);
  const savedWorkspace = useRef(readJSON<WorkspacePreset | null>('omnideck.workspace', null)).current;
  const [groupId, setGroupIdState] = useState(() => savedWorkspace?.groupId ?? localStorage.getItem('omnideck.group') ?? 'all');
  const [layout, setLayoutState] = useState<LayoutSize>(() => {
    if (savedWorkspace && LAYOUTS.includes(savedWorkspace.layout)) return savedWorkspace.layout;
    const stored = Number(localStorage.getItem('omnideck.layout'));
    return LAYOUTS.includes(stored as LayoutSize) ? stored as LayoutSize : 16;
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(['device-01']));
  const [focusedId, setFocusedId] = useState<string | null>('device-01');
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [wallOnly, setWallOnly] = useState(false);
  const [lastAnchor, setLastAnchor] = useState<string | null>('device-01');
  const [toast, setToast] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');

  const activeGroup = groups.find(group => group.id === groupId) ?? groups[0];
  const groupDevices = devices.filter(device => activeGroup.deviceIds.includes(device.id));
  const visibleDevices = groupDevices.slice(0, layout);
  const selectedDevice = devices.find(device => device.id === (fullscreenId ?? focusedId)) ?? null;

  const refresh = useCallback(() => setDevices([...deviceManager.getAll()]), [deviceManager]);

  useEffect(() => {
    sessionManager.applyStreamPolicy(layout, focusedId, fullscreenId, visibleDevices.map(device => device.id));
    refresh();
    localStorage.setItem('omnideck.layout', String(layout));
  }, [layout, focusedId, fullscreenId, groupId]);

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

  const setLayout = (next: LayoutSize) => setLayoutState(next);
  const setGroupId = (nextId: string) => {
    const next = groups.find(group => group.id === nextId) ?? groups[0];
    setGroupIdState(next.id);
    setLayoutState(next.preferredLayout);
    setSelectedIds(new Set());
    setFocusedId(next.deviceIds[0] ?? null);
    localStorage.setItem('omnideck.group', next.id);
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
      } else {
        next.clear();
        next.add(id);
      }
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
    const targetIds = [...selectedIds].filter(id => deviceManager.get(id)?.status === 'ONLINE');
    if (!targetIds.length) return setToast('Select at least one online device');
    const tasks = scheduler.createBatch(goal, targetIds);
    tasks.forEach(task => deviceManager.update(task.deviceId, session => {
      const busy = session.currentTask?.status === 'RUNNING';
      return { ...session, currentTask: busy ? session.currentTask : task, taskQueue: busy ? [...session.taskQueue, task] : session.taskQueue, agentStatus: busy ? session.agentStatus : task.status === 'RUNNING' ? 'RUNNING' : 'WAITING', agentSession: busy ? session.agentSession : { ...session.agentSession, status: task.status === 'RUNNING' ? 'RUNNING' : 'WAITING', workerId: task.status === 'RUNNING' ? `worker-${task.deviceId}` : null }, taskContext: busy ? session.taskContext : { goal, step: 0, variables: {} }, actionHistory: [...session.actionHistory, { id: `${task.id}-queued`, time: new Date().toLocaleTimeString([], { hour12: false }), kind: 'SYSTEM', message: task.status === 'RUNNING' ? 'Worker assigned' : 'Waiting for AI worker' }] };
    }));
    refresh();
    setToast(`${tasks.length} independent task instances created`);
  };

  const applyBatchAction = (action: 'PAUSED' | 'RUNNING' | 'STOPPED' | 'RESTART_APP' | 'LAUNCH_APP') => {
    selectedIds.forEach(id => deviceManager.update(id, session => {
      if (action === 'RESTART_APP' || action === 'LAUNCH_APP') return { ...session, currentApp: action === 'RESTART_APP' ? `${session.currentApp} (restarted)` : 'Omni Market' };
      return { ...session, agentStatus: action === 'RUNNING' ? 'RUNNING' : action === 'PAUSED' ? 'PAUSED' : 'IDLE', currentTask: session.currentTask ? { ...session.currentTask, status: action, updatedAt: Date.now() } : null };
    }));
    refresh();
    setToast(`${action.replace('_', ' ')} sent to ${selectedIds.size} sessions`);
  };

  const toggleOffline = (id: string) => {
    if (deviceManager.get(id)?.status === 'OFFLINE') deviceManager.recover(id); else deviceManager.setOffline(id);
    refresh();
  };

  const saveWorkspace = () => {
    const name = workspaceName.trim() || `${activeGroup.name} workspace`;
    const workspace: WorkspacePreset = { id: `workspace-${Date.now()}`, name, layout, deviceIds: visibleDevices.map(device => device.id), groupId };
    localStorage.setItem('omnideck.workspace', JSON.stringify(workspace));
    setWorkspaceName('');
    setToast(`Workspace “${name}” saved`);
  };

  const createCustomGroup = () => {
    if (!selectedIds.size) return setToast('Select devices before creating a group');
    const name = workspaceName.trim() || `Custom Group ${customGroups.length + 1}`;
    const deviceIds = [...selectedIds];
    const group: DeviceGroup = { id: `custom-${Date.now()}`, name, deviceIds, preferredLayout: layoutForCount(deviceIds.length) };
    const next = [...customGroups, group];
    setCustomGroups(next);
    localStorage.setItem('omnideck.custom-groups', JSON.stringify(next));
    setWorkspaceName('');
    setGroupIdState(group.id);
    setLayoutState(group.preferredLayout);
    setToast(`Group “${name}” created with ${deviceIds.length} devices`);
  };

  const stats = useMemo(() => ({
    total: devices.length,
    online: devices.filter(device => device.status === 'ONLINE').length,
    running: devices.filter(device => device.agentStatus === 'RUNNING').length,
    idle: devices.filter(device => device.agentStatus === 'IDLE').length,
    errors: devices.filter(device => device.status === 'ERROR' || device.status === 'OFFLINE').length,
    human: devices.filter(device => device.agentStatus === 'HUMAN_CONTROL').length,
  }), [devices]);

  return { devices, groups, groupId, layout, visibleDevices, selectedIds, focusedId, fullscreenId, wallOnly, selectedDevice, stats, workerSnapshot: scheduler.workers.snapshot(), workspaceName, toast, setLayout, setGroupId, selectDevice, toggleCheckbox, selectAll, clearSelection, closeInspector, setFullscreenId, setWallOnly, runBatch, applyBatchAction, toggleOffline, setWorkspaceName, saveWorkspace, createCustomGroup };
}
