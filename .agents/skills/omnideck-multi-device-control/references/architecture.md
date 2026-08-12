# OmniDeck Architecture Reference

## Ownership tree

```text
Desktop Control Center
└── DeviceManager
    └── DeviceSession[deviceId]
        ├── DeviceDriver
        ├── ScreenStream
        ├── AgentRuntime / AgentSession
        ├── TaskContext / taskQueue
        ├── ActionHistory / Memory
        └── HealthMonitor / HealthState

TaskScheduler
├── AgentWorkerPool
├── AI / VLM / ADB / iOS resource limiters
└── independent TaskInstance[deviceId]
```

## Current repository mapping

| Concern | Owner |
| --- | --- |
| Domain contracts | `src/domain/types.ts` |
| Stable device registry | `src/domain/deviceManager.ts` |
| View-driven stream policy | `src/domain/sessionManager.ts` |
| Adaptive profiles and AI captures | `src/domain/streamManager.ts` |
| Batch expansion and analysis flow | `src/domain/taskScheduler.ts` |
| Worker/resource/rate limits | `src/domain/workerPool.ts` |
| Device-scoped execution lifecycle | `src/domain/controlPlane.ts` |
| Platform driver contract/registry | `src/domain/deviceDriver.ts` |
| Health classification | `src/domain/healthMonitor.ts` |
| UI orchestration/persistence | `src/app/useControlCenter.ts` |
| Wall tiles and inspector | `src/components/` |

## Control Daemon boundary

```text
React DTO state
  HTTP snapshots/commands + SSE replay
Local ControlDaemon
  DeviceManager -> stable DeviceSession[deviceId]
  SessionManager -> stream policy only
  TaskScheduler -> independent TaskInstance + bounded workers/resources
  ControlPlane -> device-scoped execution and lifecycle
  DriverRegistry -> simulated driver adapters in this phase
  EventStore -> ordered in-memory event replay
```

`DeviceSummaryDTO` is the wall contract and excludes histories, memory, task context, and driver internals. `DeviceDetailDTO` is loaded only for the selected device. `sessionEpoch` identifies the daemon process and `sessionRevision` identifies a stable device session; neither changes for layout, fullscreen, inspector, or page refresh while the daemon remains running.

Commands are validated with Zod and require `commandId`, `timestamp`, and explicit device target IDs. The daemon caches successful command results to make transport retries idempotent and rejects conflicting reuse of a command ID.

## State rules

- Registry keys are stable physical/logical device IDs.
- React view state stores IDs, layout, selection, and workspace data. It must not own device runtime identity.
- Mutations always resolve a device by ID and update that device only.
- A running task cannot be overwritten by a new batch task; enqueue the new instance in that device's `taskQueue`.
- Worker completion promotes exactly one queued task and keeps active counts accurate.
- Recovering a disconnected device leaves its interrupted task resumable rather than silently restarting it.

## Stream policy

| Mode | Typical profile | Purpose |
| --- | --- | --- |
| Fullscreen | 1080p / 60 FPS | Manual control / large view |
| Focused | 720p / 30 FPS | Selected device |
| Preview | 720p/30 to 360p/5 | Visible wall tiles, layout dependent |
| Background | 360p / 1 FPS or event snapshot | Invisible devices |
| AI screenshot | 1440x2560 on demand | VLM observation, independent of monitor stream |

Resource pressure may reduce preview FPS and bitrate, but must not silently lower AI screenshot fidelity.

## Scheduler rules

- Batch input: one immutable goal plus target device IDs.
- Output: one unique `TaskInstance` per target.
- Queue ordering: higher priority first, then creation order.
- Use independent limits for AI, VLM, Android transport, and iOS transport.
- Apply retry budgets and timeout metadata per task instance.
- Drive AI with: screenshot -> analyze -> device-scoped action -> wait for UI change -> screenshot.

## UI performance rules

- Keep `DeviceTile` lightweight and bounded.
- Do not mount 32 timelines, logs, UI trees, thought views, or screenshot histories.
- Layout changes update stream profiles and visible IDs only.
- Double-click/fullscreen and ESC return preserve agent/task identity.
- For 32 channels prefer 8x4 on wide screens and adaptive tracks on narrower screens.
