import { useState } from 'react';
import type { LayoutSize } from '../domain';
import type { DeviceSummaryDTO } from '../server/protocol';
import { DeviceTile } from './DeviceTile';
import type { ScreenTapPoint } from '../app/controlCenterClient';

interface Props {
  devices: DeviceSummaryDTO[];
  layout: LayoutSize;
  selectedIds: Set<string>;
  focusedId: string | null;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onTap: (id: string, point: ScreenTapPoint) => void;
  onReorder: (sourceId: string, targetId: string) => void;
}

export function DeviceGrid({ devices, layout, selectedIds, focusedId, onSelect, onToggle, onOpen, onTap, onReorder }: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const beginDrag = (deviceId: string, event: React.DragEvent) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', deviceId);
    setDraggingId(deviceId);
    setDropTargetId(null);
  };

  const finishDrag = () => {
    setDraggingId(null);
    setDropTargetId(null);
  };

  return <div className={`device-grid layout-${layout}`} style={{ '--tile-count': layout } as React.CSSProperties}>
    {devices.map(device => <DeviceTile
      key={device.id}
      device={device}
      selected={selectedIds.has(device.id)}
      focused={focusedId === device.id}
      dense={layout >= 16}
      dragging={draggingId === device.id}
      dropTarget={dropTargetId === device.id}
      onSelect={event => onSelect(device.id, event)}
      onToggle={() => onToggle(device.id)}
      onOpen={() => onOpen(device.id)}
      onTap={point => onTap(device.id, point)}
      onDragStart={event => beginDrag(device.id, event)}
      onDragOver={event => {
        if (!draggingId || draggingId === device.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTargetId(device.id);
      }}
      onDrop={event => {
        event.preventDefault();
        const sourceId = event.dataTransfer.getData('text/plain') || draggingId;
        if (sourceId && sourceId !== device.id) onReorder(sourceId, device.id);
        finishDrag();
      }}
      onDragEnd={finishDrag}
    />)}
    {Array.from({ length: Math.max(0, layout - devices.length) }, (_, index) => <div className="empty-tile" key={index}><span>EMPTY CHANNEL</span></div>)}
  </div>;
}
