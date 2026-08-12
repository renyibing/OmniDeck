# OmniDeck Control Center

A runnable multi-device Android/iOS monitoring wall and AI task-control prototype. The current runtime uses simulated device drivers while keeping the production driver boundary explicit.

## Run

```bash
npm install
npm run dev
```

## Architecture

- `DeviceManager` owns stable, isolated `DeviceSession` objects.
- `SessionManager` changes stream policy without restarting device or agent sessions.
- `TaskScheduler` expands a batch goal into one independent `TaskInstance` per device.
- `ControlPlane` executes device-scoped screenshot/action flows, pause/resume, offline recovery, and human takeover.
- `AgentWorkerPool` limits concurrent AI work and queues overflow.
- `StreamManager` separates preview, focused, fullscreen, background, and AI screenshot quality.
- `HealthMonitor` classifies device health and supports offline/resume behavior.

The monitor wall supports 1, 4, 8, 9, 16, 25, and 32 channels, keyboard/mouse multi-selection, inspector-only detailed rendering, saved workspace settings, and monitor-only mode.

## Current scope

- Eight, sixteen, and thirty-two device sessions are covered by unit simulation; the UI starts with 32 isolated simulated sessions.
- Android ADB, iOS XCUITest/Appium, scrcpy/iOS mirroring, backend transport, persistent task storage, and real telemetry are adapter/infrastructure work still to be connected.
- AI observation is event/screenshot driven. Monitor streams are preview profiles and are not passed continuously to the agent.
