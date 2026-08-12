import { describe, expect, it } from 'vitest';
import { EventStore } from './eventStore';

describe('EventStore replay subscription', () => {
  it('returns replay events and keeps the live listener registered atomically', () => {
    const store = new EventStore();
    store.append('DEVICE_UPDATED', { deviceId: 'device-01' });
    store.append('HEALTH_UPDATED', { deviceId: 'device-01' });
    const received: number[] = [];
    const subscription = store.subscribeSince(1, event => received.push(event.sequence));
    const replaySequences = subscription.replay.map(event => event.sequence);
    store.append('DEVICE_UPDATED', { deviceId: 'device-02' });

    expect(replaySequences).toEqual([2]);
    expect(received).toEqual([3]);
    subscription.unsubscribe();
  });
});
