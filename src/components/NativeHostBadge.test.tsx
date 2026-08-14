import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NativeHostController } from '../app/useNativeHost';
import { NativeHostBadge } from './NativeHostBadge';

function makeHost(overrides: Partial<NativeHostController>): NativeHostController {
  return {
    available: false,
    loading: false,
    status: null,
    selectedDeviceProcess: {
      loading: false,
      processes: [],
      logs: [],
      allocatedWdaPort: null,
      refresh: vi.fn(),
      startScrcpy: vi.fn(),
      stopScrcpy: vi.fn(),
      allocateWdaPort: vi.fn(),
      startIproxy: vi.fn(),
      stopIproxy: vi.fn(),
    },
    error: null,
    refresh: vi.fn(),
    startDaemon: vi.fn(),
    stopDaemon: vi.fn(),
    ...overrides,
  };
}

describe('NativeHostBadge', () => {
  it('does not render outside Tauri', () => {
    expect(renderToStaticMarkup(<NativeHostBadge host={makeHost({ available: false })}/>)).toBe('');
  });

  it('renders daemon state inside Tauri without exposing full logs', () => {
    const html = renderToStaticMarkup(<NativeHostBadge host={makeHost({
      available: true,
      status: {
        available: true,
        running: true,
        pid: 1234,
        baseUrl: 'http://127.0.0.1:4317',
        projectRoot: '/tmp/project',
        command: 'npm run start:daemon',
        logTail: ['line one', 'line two'],
        lastError: null,
      },
    })}/>);

    expect(html).toContain('Desktop');
    expect(html).toContain('daemon 1234');
    expect(html).not.toContain('line one');
  });
});
