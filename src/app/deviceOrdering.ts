import type { DeviceSummaryDTO } from '../server/protocol';

const connectionPriority: Record<DeviceSummaryDTO['connection']['state'], number> = {
  CONNECTED: 0,
  CONNECTING: 1,
  FAILED: 2,
  DISCONNECTED: 3,
};

export function sortDevicesForWall(
  devices: DeviceSummaryDTO[],
  scopedDeviceIds: string[],
  manualOrder: string[],
): DeviceSummaryDTO[] {
  const scopeIndex = new Map(scopedDeviceIds.map((id, index) => [id, index]));
  const manualIndex = new Map(normalizeOrder([...manualOrder, ...scopedDeviceIds]).map((id, index) => [id, index]));

  return devices
    .filter(device => scopeIndex.has(device.id))
    .slice()
    .sort((left, right) => {
      const priorityDelta = previewPriority(left) - previewPriority(right);
      if (priorityDelta !== 0) return priorityDelta;
      const manualDelta = (manualIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (manualIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      if (manualDelta !== 0) return manualDelta;
      const scopeDelta = (scopeIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (scopeIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      if (scopeDelta !== 0) return scopeDelta;
      return left.id.localeCompare(right.id);
    });
}

export function reorderDeviceIds(currentOrder: string[], sourceId: string, targetId: string, scopedDeviceIds: string[]): string[] {
  if (sourceId === targetId) return normalizeOrder([...currentOrder, ...scopedDeviceIds]);
  const next = normalizeOrder([...currentOrder, ...scopedDeviceIds]);
  const sourceIndex = next.indexOf(sourceId);
  const targetIndex = next.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return next;
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

function normalizeOrder(order: string[]): string[] {
  return Array.from(new Set(order.filter(Boolean)));
}

function previewPriority(device: DeviceSummaryDTO): number {
  if (device.connection.state === 'CONNECTED' && device.livePreview) return 0;
  if (device.connection.state === 'CONNECTED') return 1;
  return connectionPriority[device.connection.state] + 2;
}
