# OmniDeck Control Center

A runnable multi-device Android/iOS monitoring wall and AI task-control prototype. The current runtime uses simulated device drivers while keeping the production driver boundary explicit.

## Run

```bash
npm install
npm run dev
```

`npm run dev` starts both the local Control Daemon (`127.0.0.1:4317`) and Vite. If port 5173 is occupied, Vite selects the next available port. The browser talks to the daemon through the Vite `/api` proxy; it never constructs or mutates a `DeviceSession`.

## Architecture

- `DeviceManager` owns stable, isolated `DeviceSession` objects.
- `SessionManager` changes stream policy without restarting device or agent sessions.
- `TaskScheduler` expands a batch goal into one independent `TaskInstance` per device.
- `ControlPlane` executes device-scoped screenshot/action flows, pause/resume, offline recovery, and human takeover.
- `AgentWorkerPool` limits concurrent AI work and queues overflow.
- `StreamManager` separates preview, focused, fullscreen, background, and AI screenshot quality.
- `HealthMonitor` classifies device health and supports offline/resume behavior.

The local service is implemented in `src/server/`:

- `ControlDaemon` owns the single process-local `DeviceManager`, `SessionManager`, `TaskScheduler`, `DriverRegistry`, and `ControlPlane`.
- `protocol.ts` exposes versioned `DeviceSummaryDTO` wall snapshots and `DeviceDetailDTO` inspector snapshots. Histories, task context, and selected-device logs are fetched only for the selected device.
- `ControlCenterClient` uses HTTP for snapshots/commands and SSE for ordered, replayable events. Commands include a `commandId`, timestamp, and explicit device targets; repeated command IDs are idempotent.
- `EventStore` is bounded and in-memory in this phase, with atomic replay subscription and a replaceable interface for a later durable event store.

Available protocol routes include `GET /api/devices`, `GET /api/devices/:deviceId`, `GET /api/runtime`, `GET /api/events`, `POST /api/tasks/batch`, device lifecycle/action commands, and `POST /api/session/stream-policy`.

The monitor wall supports 1, 4, 8, 9, 16, 25, and 32 channels, keyboard/mouse multi-selection, inspector-only detailed rendering, saved workspace settings, and monitor-only mode.

## Current scope

- Eight, sixteen, and thirty-two device sessions are covered by unit simulation; the UI starts with 32 isolated simulated sessions.
- API integration tests cover 32 backend sessions, lightweight/detail DTO separation, command target validation and idempotency, monotonic/atomic SSE replay, worker limits, disconnect/recovery, explicit resume, and human takeover isolation.
- Android ADB, iOS XCUITest/Appium, scrcpy/iOS mirroring, backend transport, persistent task storage, and real telemetry are adapter/infrastructure work still to be connected.
- AI observation is event/screenshot driven. Monitor streams are preview profiles and are not passed continuously to the agent.

All device actions remain simulated. No real Android or iOS hardware is accessed by this repository yet.
