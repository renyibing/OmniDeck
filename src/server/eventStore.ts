import type { EventEnvelope, EventType } from './protocol';

type EventListener = (event: EventEnvelope) => void;

export class EventStore {
  private readonly events: EventEnvelope[] = [];
  private readonly listeners = new Set<EventListener>();
  private sequence = 0;

  append(type: EventType, args: { deviceId?: string | null; taskId?: string | null; payload?: Record<string, unknown> } = {}): EventEnvelope {
    const event: EventEnvelope = {
      version: 'v1',
      eventId: `event-${Date.now()}-${++this.sequence}`,
      sequence: this.sequence,
      occurredAt: Date.now(),
      type,
      deviceId: args.deviceId ?? null,
      taskId: args.taskId ?? null,
      payload: args.payload ?? {},
    };
    this.events.push(event);
    if (this.events.length > 2_000) this.events.splice(0, this.events.length - 2_000);
    this.listeners.forEach(listener => listener(event));
    return event;
  }

  since(sequence = 0): EventEnvelope[] { return this.events.filter(event => event.sequence > sequence); }
  latest(): number { return this.sequence; }
  subscribe(listener: EventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
