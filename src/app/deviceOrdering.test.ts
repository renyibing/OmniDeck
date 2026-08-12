import { describe, expect, it } from 'vitest';
import type { DeviceSummaryDTO } from '../server/protocol';
import { reorderDeviceIds, sortDevicesForWall } from './deviceOrdering';

function makeDevice(
  id: string,
  connectionState: DeviceSummaryDTO['connection']['state'],
  livePreview = connectionState === 'CONNECTED',
): DeviceSummaryDTO {
  return {
    id,
    name: id,
    platform: id.includes('ios') ? 'IOS' : 'ANDROID',
    model: 'test',
    status: 'ONLINE',
    agentStatus: 'IDLE',
    health: 'HEALTHY',
    currentApp: 'app',
    groupIds: ['all'],
    metrics: { fps: 5, latency: 80, cpu: 10, memory: 10, battery: 80, temperature: 30, network: 'WIFI' },
    stream: { mode: 'PREVIEW', width: 360, height: 780, fps: 5, bitrateKbps: 900 },
    currentTask: null,
    queuedTaskCount: 0,
    screenshotSeed: 0,
    sessionRevision: 1,
    configuration: null,
    connection: { state: connectionState, lastAttemptAt: null, connectedAt: null, error: null },
    livePreview,
    previewVideoUrl: livePreview && id.includes('android') ? `/api/devices/${id}/video` : null,
    previewStreamUrl: livePreview && !id.includes('android') ? `/api/devices/${id}/mjpeg` : null,
  };
}

describe('deviceOrdering', () => {
  it('prioritizes connected previews before disconnected devices', () => {
    const devices = [
      makeDevice('device-03', 'DISCONNECTED', false),
      makeDevice('device-01', 'CONNECTED', true),
      makeDevice('device-02', 'CONNECTING', false),
      makeDevice('device-04', 'CONNECTED', false),
    ];

    expect(sortDevicesForWall(devices, devices.map(device => device.id), [])).toMatchObject([
      { id: 'device-01' },
      { id: 'device-04' },
      { id: 'device-02' },
      { id: 'device-03' },
    ]);
  });

  it('uses manual order within the same connection priority bucket', () => {
    const devices = [
      makeDevice('device-01', 'CONNECTED', true),
      makeDevice('device-02', 'CONNECTED', true),
      makeDevice('device-03', 'CONNECTED', true),
    ];

    expect(sortDevicesForWall(devices, devices.map(device => device.id), ['device-03', 'device-01', 'device-02']).map(device => device.id))
      .toEqual(['device-03', 'device-01', 'device-02']);
  });

  it('reorders visible devices without dropping unseen ids', () => {
    expect(reorderDeviceIds(['device-09'], 'device-03', 'device-01', ['device-01', 'device-03', 'device-07']))
      .toEqual(['device-09', 'device-03', 'device-01', 'device-07']);
  });
});
