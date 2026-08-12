import { DeviceManager } from './deviceManager';
import type { DeviceSession, LayoutSize, StreamMode } from './types';
import { StreamManager } from './streamManager';

export class SessionManager {
  private readonly streamManager = new StreamManager();
  constructor(private readonly devices: DeviceManager) {}

  applyStreamPolicy(layout: LayoutSize, selectedId: string | null, fullscreenId: string | null, visibleIds: string[]) {
    this.devices.getAll().forEach(session => {
      const mode: StreamMode = fullscreenId === session.id ? 'FULLSCREEN' : selectedId === session.id ? 'FOCUSED' : visibleIds.includes(session.id) ? 'PREVIEW' : 'BACKGROUND';
      const stream = this.streamManager.getProfile(mode, layout);
      this.devices.update(session.id, current => ({ ...current, stream, screenStream: { ...current.screenStream, profile: stream }, sessionRevision: current.sessionRevision }));
    });
  }

  getStableSession(id: string): DeviceSession | undefined { return this.devices.get(id); }
}
