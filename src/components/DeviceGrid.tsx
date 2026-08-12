import type { LayoutSize } from '../domain';
import type { DeviceSummaryDTO } from '../server/protocol';
import { DeviceTile } from './DeviceTile';

interface Props { devices: DeviceSummaryDTO[]; layout: LayoutSize; selectedIds: Set<string>; focusedId: string | null; onSelect: (id: string, event: React.MouseEvent) => void; onToggle: (id: string) => void; onOpen: (id: string) => void }

export function DeviceGrid({ devices, layout, selectedIds, focusedId, onSelect, onToggle, onOpen }: Props) {
  return <div className={`device-grid layout-${layout}`} style={{ '--tile-count': layout } as React.CSSProperties}>
    {devices.map(device => <DeviceTile key={device.id} device={device} selected={selectedIds.has(device.id)} focused={focusedId === device.id} dense={layout >= 16} onSelect={event => onSelect(device.id, event)} onToggle={() => onToggle(device.id)} onOpen={() => onOpen(device.id)}/>)}
    {Array.from({ length: Math.max(0, layout - devices.length) }, (_, index) => <div className="empty-tile" key={index}><span>EMPTY CHANNEL</span></div>)}
  </div>;
}
