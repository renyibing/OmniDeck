# Acceptance Matrix

## Required automated checks

| Area | Required assertion |
| --- | --- |
| Session identity | Switching 8/16/32 and fullscreen does not change session revision or device-local object identity |
| Isolation | Task context, history, memory, health, driver, stream, and queues are unique per device |
| Batch tasks | N targets produce N unique task instances and independent states |
| Worker pool | Active AI never exceeds configured maximum; completion promotes one queued task |
| Resources | AI, VLM, ADB, and iOS limits are enforced independently |
| Rate limits | Requests beyond the rolling window are rejected or queued |
| Offline | One disconnect stops only that device and marks its task `DEVICE_OFFLINE` |
| Recovery | Recovered task is resumable and is not silently restarted |
| Streams | Selected/fullscreen/preview/background profiles follow policy |
| AI observation | AI uses on-demand high-resolution screenshots and never continuous video analysis |

## Control Daemon checks

- `GET /api/runtime` exposes 32 summaries with a stable `sessionEpoch`; repeated reload-like reads do not create sessions.
- `GET /api/devices/:deviceId` is the only public route that returns timeline/task-history detail.
- Batch and device commands reject malformed input, require explicit IDs, and return the same result for a retried `commandId`.
- `GET /api/events?since=N` replays events in strictly increasing sequence order; the client performs a full runtime resync before reconnecting.
- SSE replay subscription registers the live listener before replaying the bounded backlog, so an event appended during reconnect cannot be lost.
- API integration tests cover worker configuration (`maxConcurrentAI=8`, `maxConcurrentVLM=4`), isolated disconnect, recovery with explicit resume, and human takeover.

## Browser validation

Verify desktop 8, 16, and 32 layouts plus a narrow viewport:

- No tile, toolbar, status bar, inspector, or batch bar overlap.
- No horizontal document overflow.
- Single click focuses and shows one inspector.
- Checkbox, Shift, Ctrl/Command, and Select All produce the expected device set.
- Double-click opens one-device large view; ESC restores the previous wall layout.
- Layout/fullscreen changes preserve task status and session revision.
- Monitor-only mode hides navigation/inspector/log surfaces and exits with ESC.
- 32 tiles do not mount per-device timelines or log views.
- Browser console contains no current runtime errors.

## Scale validation

- Unit/simulation: run 8, 16, and 32 device sessions on every relevant change.
- Real devices: require at least 8 authorized devices before claiming hardware acceptance.
- Record CPU, memory, GPU/encoder, network, render latency, FPS distribution, queue depth, error rate, and recovery time.
- Inject one-device disconnect, slow screen response, task failure, and VLM throttling. Confirm other devices continue.

## Standard commands

```bash
npm run lint
npm test
npm run build
```

Use `scripts/validate_omnideck.sh` to run these checks together and scan for prohibited broadcast/video-analysis patterns.
