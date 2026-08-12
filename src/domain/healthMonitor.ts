import type { DeviceSession, HealthState } from './types';

export class HealthMonitor {
  evaluate(session: DeviceSession): HealthState {
    if (session.status === 'OFFLINE' || session.metrics.network === 'OFFLINE') return 'OFFLINE';
    if (session.status === 'ERROR' || session.metrics.latency > 180 || session.metrics.temperature > 42) return 'DEGRADED';
    return 'HEALTHY';
  }
}
