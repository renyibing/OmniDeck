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
      this.devices.update(session.id, current => {
        if (current.stream.mode === stream.mode && current.stream.width === stream.width && current.stream.height === stream.height && current.stream.fps === stream.fps && current.stream.bitrateKbps === stream.bitrateKbps) return current;
        current.stream = stream;
        current.screenStream.profile = stream;
        return current;
      });
    });
  }

  getStableSession(id: string): DeviceSession | undefined { return this.devices.get(id); }
}
