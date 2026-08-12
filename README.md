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

Available protocol routes include `GET /api/devices`, `GET /api/devices/discovery`, `GET /api/devices/:deviceId`, `GET /api/runtime`, `GET /api/events`, `POST /api/devices/configure`, `POST /api/devices/:deviceId/connect`, `POST /api/devices/:deviceId/tap`, `POST /api/tasks/batch`, device lifecycle/action commands, and `POST /api/session/stream-policy`.

The monitor wall supports 1, 4, 8, 9, 16, 25, and 32 channels, keyboard/mouse multi-selection, inspector-only detailed rendering, saved workspace settings, and monitor-only mode.

## Current scope

- Eight, sixteen, and thirty-two device sessions are covered by unit simulation; the UI starts with 32 isolated simulated sessions.
- API integration tests cover 32 backend sessions, lightweight/detail DTO separation, command target validation and idempotency, monotonic/atomic SSE replay, worker limits, disconnect/recovery, explicit resume, and human takeover isolation.
- The default runtime remains fully simulated. It performs no hardware discovery or device command.
- `AndroidAdbScrcpyDriver` executes device-scoped `adb -s <serial>` commands, takes independent `adb exec-out screencap -p` AI screenshots, and can supervise a no-control scrcpy preview process.
- `IOSXCUITestDriver` communicates only with an explicitly configured device-local WebDriverAgent URL. WDA provisioning, signing, installation, and MJPEG/WebRTC delivery remain deployment concerns outside source control.
- A browser video gateway is not implemented yet: starting scrcpy is not equivalent to delivering a real stream to a `DeviceTile`. WebRTC/MSE fan-out is the next required layer for a real monitor wall.
- AI observation is event/screenshot driven. Monitor streams are preview profiles and are not passed continuously to the agent.

## Guarded native-driver mode

Native drivers are opt-in. The daemon refuses to create an Android driver without a serial and refuses to create an iOS driver without both UDID and WDA URL. Nothing below runs unless `OMNIDECK_ENABLE_REAL_DEVICES=true` is set.

```bash
# One explicitly named Android device. No default ADB target is ever used.
OMNIDECK_ENABLE_REAL_DEVICES=true \
OMNIDECK_DRIVER_MODE=ANDROID_ADB_SCRCPY \
OMNIDECK_ANDROID_SERIAL=<serial> \
npm run start:daemon

# One explicitly named iPhone backed by an already-running device-local WDA.
OMNIDECK_ENABLE_REAL_DEVICES=true \
OMNIDECK_DRIVER_MODE=IOS_XCUITEST \
OMNIDECK_IOS_UDID=<udid> \
OMNIDECK_WDA_URL=http://127.0.0.1:<wda-port> \
npm run start:daemon

# Mixed one-Android plus two-iPhone mode; remaining device slots stay simulated.
OMNIDECK_ENABLE_REAL_DEVICES=true \
OMNIDECK_ANDROID_SERIALS=<android-serial> \
OMNIDECK_IOS_UDIDS=<ios-udid-1>,<ios-udid-2> \
OMNIDECK_WDA_URLS=http://127.0.0.1:<wda-port-1>,http://127.0.0.1:<wda-port-2> \
npm run start:daemon
```

Before enabling either mode, enumerate the exact serial/UDID, verify authorization or trust without changing it, and run a one-device smoke test. Do not use these switches for unreviewed batch actions.

Connected native devices expose a browser preview at `/api/devices/:deviceId/frame`. When a device is in `HUMAN_CONTROL`, fullscreen preview taps are sent through `/api/devices/:deviceId/tap` as device-scoped normalized coordinates. The monitor wall refreshes this screenshot-driven preview at up to 5 FPS according to the current stream policy; AI screenshots remain a separate high-resolution path. Set `OMNIDECK_START_SCRCPY_PROCESS=true` only when the daemon should also supervise a separate no-control scrcpy process.
