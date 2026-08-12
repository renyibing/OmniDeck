# OmniDeck Control Center

A runnable multi-device Android/iOS monitoring wall and AI task-control prototype.

## Run

```bash
npm install
npm run dev
```

## Architecture

- `DeviceManager` owns stable, isolated `DeviceSession` objects.
- `SessionManager` changes stream policy without restarting device or agent sessions.
- `TaskScheduler` expands a batch goal into one independent `TaskInstance` per device.
- `AgentWorkerPool` limits concurrent AI work and queues overflow.
- `StreamManager` separates preview, focused, fullscreen, background, and AI screenshot quality.
- `HealthMonitor` classifies device health and supports offline/resume behavior.

The monitor wall supports 1, 4, 8, 9, 16, 25, and 32 channels, keyboard/mouse multi-selection, inspector-only detailed rendering, saved workspace settings, and monitor-only mode.
