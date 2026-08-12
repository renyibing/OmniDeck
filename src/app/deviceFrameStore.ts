type Listener = (url: string | null) => void;

interface FrameEntry {
  listeners: Set<Listener>;
  url: string | null;
  running: boolean;
  timer: number | null;
  controller: AbortController | null;
  intervalMs: number;
}

const entries = new Map<string, FrameEntry>();

export function subscribeDeviceFrame(deviceId: string, intervalMs: number, listener: Listener): () => void {
  const entry = entries.get(deviceId) ?? {
    listeners: new Set<Listener>(), url: null, running: false, timer: null, controller: null, intervalMs,
  };
  const previousInterval = entry.intervalMs;
  entry.intervalMs = Math.min(entry.intervalMs || intervalMs, intervalMs);
  entry.listeners.add(listener);
  entries.set(deviceId, entry);
  listener(entry.url);
  if (!entry.running) {
    if (entry.timer !== null && entry.intervalMs < previousInterval) {
      window.clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.timer === null) void refresh(deviceId, entry);
  }

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size) return;
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.controller?.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
    entries.delete(deviceId);
  };
}

async function refresh(deviceId: string, entry: FrameEntry): Promise<void> {
  if (!entry.listeners.size) return;
  entry.running = true;
  entry.timer = null;
  entry.controller = new AbortController();
  const startedAt = performance.now();
  let nextUrl: string | null = null;
  try {
    const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/frame`, {
      cache: 'no-store', signal: entry.controller.signal,
    });
    if (!response.ok) throw new Error(`Frame request failed (${response.status})`);
    nextUrl = URL.createObjectURL(await response.blob());
    // Double-buffer: decode the next frame fully before swapping the visible URL.
    // Setting img.src to a new blob clears Chrome's bitmap until load completes (classic flicker).
    await decodeImage(nextUrl);
    if (!entry.listeners.size) {
      URL.revokeObjectURL(nextUrl);
      return;
    }
    const previous = entry.url;
    entry.url = nextUrl;
    entry.listeners.forEach(current => current(nextUrl));
    nextUrl = null;
    if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 1_000);
  } catch (error) {
    if (nextUrl) URL.revokeObjectURL(nextUrl);
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      entry.listeners.forEach(current => current(entry.url));
    }
  } finally {
    entry.running = false;
    entry.controller = null;
    if (entry.listeners.size) {
      const delay = Math.max(0, entry.intervalMs - (performance.now() - startedAt));
      entry.timer = window.setTimeout(() => void refresh(deviceId, entry), delay);
    }
  }
}

function decodeImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Unable to decode device frame'));
    image.src = url;
  });
}
