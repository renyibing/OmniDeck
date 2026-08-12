---
name: omnideck-multi-device-control
description: Implement, review, or validate OmniDeck multi-device Android/iOS control-center features. Use for DeviceManager, DeviceSession isolation, AgentWorkerPool, TaskScheduler, StreamManager, HealthMonitor, monitor-wall layouts, DeviceTile/Inspector behavior, batch tasks, human takeover, Appium/ADB/XCUITest integration, or 8/16/32-device simulation and performance work in this repository.
---

# OmniDeck Multi-Device Control

Work from the repository root. Inspect current code before changing it.

## Load references selectively

- Read `references/architecture.md` for domain/session/scheduler/stream changes.
- Read `references/mobile-drivers.md` before adding Android, iOS, Appium, ADB, scrcpy, WebDriverAgent, or XCUITest integration.
- Read `references/acceptance.md` for UI behavior, tests, load simulation, and release validation.

## Preserve invariants

1. Keep one stable `DeviceSession` per device identity. Layout, selection, inspector, or fullscreen changes must not recreate it.
2. Keep `AgentSession`, `TaskContext`, `ActionHistory`, `Memory`, `HealthState`, `ScreenStream`, and task queues device-local. Never share mutable live task state between devices.
3. Expand every batch goal into independent per-device `TaskInstance` objects. Never implement coordinate broadcast or copy one mutable task object across devices.
4. Bound AI, VLM, ADB, and iOS concurrency independently. Queue overflow with priority, timeout, retry, and rate limits.
5. Treat monitoring streams and AI observation as separate pipelines. AI uses triggered high-resolution screenshots, not continuous video analysis.
6. Stop in-flight device actions on disconnect, mark the task `DEVICE_OFFLINE`, and preserve enough context to resume after recovery.
7. Render only thumbnail/basic state per wall tile. Mount detailed timeline, logs, UI tree, thoughts, and screenshot history for the selected device only.
8. Require explicit per-device authorization and audit events for human takeover and device actions. Never log secrets, account credentials, raw tokens, or sensitive screenshot content by default.

## Implementation workflow

1. Map the requested change to the existing owner module. Extend existing types and managers before adding a parallel abstraction.
2. Identify affected invariants and acceptance cases before editing.
3. Keep domain logic independent of React. UI components consume snapshots and dispatch device-scoped commands.
4. Add focused unit tests for session identity, per-device isolation, scheduling, stream policy, and offline behavior.
5. For visual changes, run the app and inspect 8, 16, and 32 layouts at desktop and narrow viewports. Exercise single click, multi-select, double click, ESC return, and batch actions.
6. Run `scripts/validate_omnideck.sh` before handing off.

## Safety boundaries

- Use simulated drivers unless the user explicitly authorizes commands against connected hardware.
- Enumerate exact device IDs before any real-device batch action.
- Do not install mobile profiles, accept trust dialogs, unlock devices, change accounts, or transmit screenshots without explicit authorization.
- Do not weaken TLS or certificate verification to work around tooling failures.
- Keep logs bounded and redact device/account identifiers at external telemetry boundaries.

## Completion contract

Report changed modules, verified layouts/device counts, test commands, and any requirement that remains simulated. Do not claim real-device validation when only simulated sessions were exercised.
