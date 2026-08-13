import { Socket } from 'node:net';
import { ProcessRunner } from './nativeProcess';

export type IOSWdaReadinessState =
  | 'UNCONFIGURED'
  | 'WDA_URL_ASSIGNED'
  | 'PORT_TUNNEL_MISSING'
  | 'WDA_NOT_RUNNING'
  | 'WDA_READY'
  | 'SESSION_CONNECTED'
  | 'SIGNING_REQUIRED'
  | 'UNKNOWN';

export interface IOSWdaStatus {
  deviceId: string;
  udid: string | null;
  wdaUrl: string | null;
  localHost: string | null;
  localPort: number | null;
  configured: boolean;
  detected: boolean;
  iproxyDetected: boolean;
  localPortListening: boolean;
  statusReady: boolean;
  sessionReady: boolean;
  state: IOSWdaReadinessState;
  lastError: string | null;
  nextAction: string;
  commands: {
    iproxy: string | null;
    xcodebuild: string | null;
  };
  checkedAt: number;
}

export interface IOSWdaDiagnosticsInput {
  deviceId: string;
  udid?: string | null;
  wdaUrl?: string | null;
  configured: boolean;
  detected: boolean;
  sessionConnected?: boolean;
  previousError?: string | null;
  wdaBundleId?: string | null;
}

interface LocalPortProbe {
  listening: boolean;
  error: string | null;
  code: string | null;
}

interface IOSWdaDiagnosticsOptions {
  runner?: ProcessRunner;
  request?: typeof fetch;
  probeLocalPort?: (host: string, port: number, timeoutMs: number) => Promise<LocalPortProbe>;
  timeoutMs?: number;
}

export class IOSWdaDiagnostics {
  private readonly runner: ProcessRunner;
  private readonly request: typeof fetch;
  private readonly probe: (host: string, port: number, timeoutMs: number) => Promise<LocalPortProbe>;
  private readonly timeoutMs: number;

  constructor(options: IOSWdaDiagnosticsOptions = {}) {
    this.runner = options.runner ?? new ProcessRunner();
    this.request = options.request ?? fetch;
    this.probe = options.probeLocalPort ?? probeLocalPort;
    this.timeoutMs = options.timeoutMs ?? 4_000;
  }

  async diagnose(input: IOSWdaDiagnosticsInput): Promise<IOSWdaStatus> {
    const endpoint = input.wdaUrl ? parseWdaEndpoint(input.wdaUrl) : null;
    const commands = makeCommands(input.udid ?? null, endpoint?.port ?? null, input.wdaBundleId ?? null);
    const signingState = classifyWdaFailure(input.previousError);
    if (!input.configured) {
      return this.status(input, endpoint, {
        state: input.detected && endpoint ? 'WDA_URL_ASSIGNED' : 'UNCONFIGURED',
        nextAction: endpoint ? 'Save this iOS device configuration before connecting.' : 'Run detection and save the iOS device configuration.',
        commands,
      });
    }
    if (!endpoint) {
      return this.status(input, endpoint, {
        state: 'UNCONFIGURED',
        lastError: 'iOS XCUITest requires a WDA URL',
        nextAction: 'Enter or accept the auto-assigned WDA URL, then save the device configuration.',
        commands,
      });
    }

    const [localPort, iproxyDetected] = await Promise.all([
      this.probe(endpoint.host, endpoint.port, this.timeoutMs),
      this.detectIproxy(endpoint.port, input.udid ?? null),
    ]);
    if (!localPort.listening) {
      if (signingState === 'SIGNING_REQUIRED') {
        return this.status(input, endpoint, {
          state: 'SIGNING_REQUIRED',
          localPortListening: false,
          iproxyDetected,
          lastError: input.previousError ?? 'WDA signing or provisioning requires user action',
          nextAction: 'Resolve Xcode signing/provisioning for WebDriverAgentRunner, then rerun WDA and retry connection.',
          commands,
        });
      }
      return this.status(input, endpoint, {
        state: 'PORT_TUNNEL_MISSING',
        localPortListening: false,
        iproxyDetected,
        lastError: localPort.error ?? `No listener on ${endpoint.host}:${endpoint.port}`,
        nextAction: commands.iproxy ? `Start the device-specific port tunnel: ${commands.iproxy}` : 'Start the device-specific iproxy tunnel, then retry WDA status.',
        commands,
      });
    }

    const status = await this.probeWdaStatus(endpoint.url);
    if (status.ready) {
      return this.status(input, endpoint, {
        state: input.sessionConnected ? 'SESSION_CONNECTED' : 'WDA_READY',
        localPortListening: true,
        iproxyDetected,
        statusReady: true,
        sessionReady: input.sessionConnected === true,
        nextAction: input.sessionConnected ? 'XCUITest session is connected.' : 'WDA /status is ready. Click Connect to create an XCUITest session.',
        commands,
      });
    }

    const failureState = classifyWdaFailure(status.error) === 'SIGNING_REQUIRED'
      || signingState === 'SIGNING_REQUIRED'
      ? 'SIGNING_REQUIRED'
      : isWdaUnreachable(status.error)
        ? 'WDA_NOT_RUNNING'
        : 'UNKNOWN';
    return this.status(input, endpoint, {
      state: failureState,
      localPortListening: true,
      iproxyDetected,
      lastError: status.error,
      nextAction: failureState === 'SIGNING_REQUIRED'
        ? 'Resolve Xcode signing/provisioning for WebDriverAgentRunner, then rerun WDA and retry connection.'
        : failureState === 'WDA_NOT_RUNNING' && /timed out/i.test(status.error ?? '')
          ? 'iproxy is listening but WDA is not responding (still starting or overloaded). Restart WDA: ./scripts/stop-wda-device.sh then ./scripts/start-wda-device.sh for this UDID/port. Unlock the device and close heavy foreground apps before retrying.'
          : commands.xcodebuild
            ? `Keep iproxy running and start WebDriverAgentRunner for this UDID. Command: ${commands.xcodebuild}`
            : 'Keep iproxy running and start WebDriverAgentRunner for this UDID, then retry WDA status.',
      commands,
    });
  }

  async detectIproxy(localPort: number, udid: string | null): Promise<boolean> {
    try {
      const listeners = await this.runner.run({ command: 'lsof', args: ['-nP', `-iTCP:${localPort}`, '-sTCP:LISTEN'], timeoutMs: 1_500 });
      if (listeners.code !== 0 || !listeners.stdout.includes('iproxy')) return false;
      if (!udid) return true;
      const pids = listeners.stdout.split('\n')
        .map(line => line.trim().split(/\s+/))
        .filter(parts => parts[0] === 'iproxy' && /^\d+$/.test(parts[1] ?? ''))
        .map(parts => parts[1]);
      if (!pids.length) return true;
      const processes = await this.runner.run({ command: 'ps', args: ['-p', pids.join(','), '-o', 'command='], timeoutMs: 1_500 });
      return processes.code === 0 && processes.stdout.includes(udid);
    } catch {
      return false;
    }
  }

  private async probeWdaStatus(wdaUrl: string): Promise<{ ready: boolean; error: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`WDA status timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    try {
      const response = await this.request(`${wdaUrl}/status`, { signal: controller.signal });
      return response.ok
        ? { ready: true, error: null }
        : { ready: false, error: `WDA /status returned HTTP ${response.status}` };
    } catch (error) {
      return { ready: false, error: describeCause(error) ?? 'WDA /status request failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  private status(input: IOSWdaDiagnosticsInput, endpoint: ReturnType<typeof parseWdaEndpoint> | null, values: Partial<IOSWdaStatus>): IOSWdaStatus {
    return {
      deviceId: input.deviceId,
      udid: input.udid ?? null,
      wdaUrl: endpoint?.url ?? input.wdaUrl ?? null,
      localHost: endpoint?.host ?? null,
      localPort: endpoint?.port ?? null,
      configured: input.configured,
      detected: input.detected,
      iproxyDetected: values.iproxyDetected ?? false,
      localPortListening: values.localPortListening ?? false,
      statusReady: values.statusReady ?? false,
      sessionReady: values.sessionReady ?? false,
      state: values.state ?? 'UNKNOWN',
      lastError: values.lastError ?? null,
      nextAction: values.nextAction ?? 'Inspect WDA, iproxy, and Xcode signing state for this device.',
      commands: values.commands ?? makeCommands(input.udid ?? null, endpoint?.port ?? null, input.wdaBundleId ?? null),
      checkedAt: Date.now(),
    };
  }
}

export async function probeLocalPort(host: string, port: number, timeoutMs: number): Promise<LocalPortProbe> {
  return new Promise(resolve => {
    const socket = new Socket();
    let settled = false;
    const finish = (result: LocalPortProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ listening: false, error: `Connection to ${host}:${port} timed out`, code: 'ETIMEDOUT' }));
    socket.once('connect', () => finish({ listening: true, error: null, code: null }));
    socket.once('error', error => finish({ listening: false, error: describeCause(error) ?? error.message, code: errorCode(error) }));
    socket.connect(port, host);
  });
}

export function classifyWdaFailure(error: unknown): IOSWdaReadinessState | null {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (/No profiles|provisioning|CODE_SIGN|codesign|development team|signing/i.test(message)) return 'SIGNING_REQUIRED';
  if (/ECONNREFUSED|not listening|No listener/i.test(message)) return 'PORT_TUNNEL_MISSING';
  if (/ECONNRESET|socket hang up|connection reset|other side closed|UND_ERR_SOCKET/i.test(message)) return 'WDA_NOT_RUNNING';
  return null;
}

function parseWdaEndpoint(rawUrl: string): { url: string; host: string; port: number } | null {
  try {
    const parsed = new URL(rawUrl);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return { url: parsed.toString().replace(/\/+$/, ''), host: parsed.hostname, port };
  } catch {
    return null;
  }
}

function makeCommands(udid: string | null, localPort: number | null, bundleId: string | null): IOSWdaStatus['commands'] {
  const iproxy = udid && localPort ? `iproxy ${localPort} 8100 -u ${udid}` : null;
  const safeBundleId = bundleId || 'com.example.omnideck.WebDriverAgentRunner';
  const xcodebuild = udid
    ? `xcodebuild -project "$HOME/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner -destination 'id=${udid}' -allowProvisioningUpdates -allowProvisioningDeviceRegistration DEVELOPMENT_TEAM=<TEAM_ID> PRODUCT_BUNDLE_IDENTIFIER=${safeBundleId} CODE_SIGN_STYLE=Automatic test`
    : null;
  return { iproxy, xcodebuild };
}

function isForwardReset(error: string | null): boolean {
  return classifyWdaFailure(error) === 'WDA_NOT_RUNNING';
}

function isWdaUnreachable(error: string | null): boolean {
  if (!error) return false;
  return isForwardReset(error) || /timed out|abort/i.test(error);
}

function describeCause(cause: unknown): string | null {
  const root = cause instanceof Error ? (cause as Error & { cause?: unknown }).cause : undefined;
  const target = objectCause(root) ?? objectCause(cause);
  const code = target ? stringValue(target.code) : null;
  const address = target ? stringValue(target.address) : null;
  const port = target && (typeof target.port === 'string' || typeof target.port === 'number') ? String(target.port) : null;
  const detail = [code, address && port ? `${address}:${port}` : address ?? port].filter(Boolean).join(' ');
  if (detail) return detail;
  if (cause instanceof Error && cause.message) return cause.message;
  return null;
}

function errorCode(error: unknown): string | null {
  const target = objectCause(error);
  return target ? stringValue(target.code) : null;
}

function objectCause(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
