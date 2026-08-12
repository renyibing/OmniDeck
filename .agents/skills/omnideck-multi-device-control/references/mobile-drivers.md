# Mobile Driver Integration

Use official vendor tooling and isolate every command by device ID.

## Shared driver contract

Implement platform drivers behind a device-scoped interface with operations such as:

```ts
interface DeviceDriver {
  connect(signal?: AbortSignal): Promise<void>;
  screenshot(options: ScreenshotOptions, signal?: AbortSignal): Promise<Buffer>;
  launchApp(appId: string, signal?: AbortSignal): Promise<void>;
  stopApp(appId: string, signal?: AbortSignal): Promise<void>;
  tap(point: NormalizedPoint, signal?: AbortSignal): Promise<void>;
  health(signal?: AbortSignal): Promise<DriverHealth>;
  disconnect(): Promise<void>;
}
```

Bind the concrete driver instance permanently to one `deviceId`. Validate action preconditions against current health and task revision. Use `AbortSignal` to stop actions on disconnect, task cancellation, timeout, or human takeover.

## Android

- Discover devices with `adb devices -l`; reject ambiguous or unauthorized entries.
- Pass `-s <serial>` on every ADB command. Never rely on the default target when multiple devices are connected.
- Use scrcpy or a dedicated encoder for human-monitoring streams; keep AI screenshots on a separate `adb exec-out screencap -p` or driver screenshot path.
- Bound ADB command concurrency and subprocess lifetime. Capture exit code, timeout, and serial in audit metadata.
- Normalize coordinates only after reading the current display size and orientation. Prefer semantic selectors through Appium/UIAutomator when available.

## iOS

- Bind Appium/XCUITest/WebDriverAgent sessions to an explicit UDID.
- Treat WebDriverAgent lifecycle as device-local health, not a global singleton.
- Keep signing/provisioning configuration outside source control.
- Use semantic accessibility identifiers first. Coordinate actions require current viewport/orientation checks.
- Bound iOS session startup separately because provisioning and WDA startup are more expensive than ordinary commands.

## Appium

- Use one Appium session per actively controlled device, created on demand and released when idle; do not allocate permanent sessions for all devices.
- Give parallel sessions unique system ports and platform-specific auxiliary ports.
- Store capabilities as validated structured data, not shell-concatenated strings.
- Keep platform adapters thin; domain task state belongs to OmniDeck, not the Appium client object.
- Record sanitized command name, device ID, task ID, latency, result, and retry count. Do not record sensitive text input or unredacted screenshots by default.

## Real-device gate

Before running against hardware:

1. List exact serials/UDIDs and platforms.
2. Confirm the requested target set and action.
3. Verify authorization/trust state without changing it.
4. Run one-device smoke validation.
5. Expand to 8 devices while watching CPU, memory, network, encoder load, and action error rate.
6. Keep 16/32 validation simulated until capacity and failure isolation are demonstrated.
