import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';

type CliOptions = {
  serials: string[];
  dryRun: boolean;
  passthrough: string[];
};

function parseCli(argv: string[]): CliOptions {
  const serials: string[] = [];
  const passthrough: string[] = [];
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--dry-run' || arg === '--print-env') {
      dryRun = true;
      continue;
    }
    if (arg === '--serial') {
      const value = argv[index + 1];
      if (!value) throw new Error('--serial requires a value');
      serials.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--serial=')) {
      serials.push(arg.slice('--serial='.length));
      continue;
    }
    passthrough.push(arg);
  }

  return { serials: serials.filter(Boolean), dryRun, passthrough };
}

function envSerials(): string[] {
  const raw = process.env.OMNIDECK_ANDROID_SERIALS ?? process.env.OMNIDECK_ANDROID_SERIAL ?? '';
  return raw.split(',').map(serial => serial.trim()).filter(Boolean);
}

function discoverAuthorizedAndroidSerials(): string[] {
  const adb = process.env.OMNIDECK_ADB_PATH ?? 'adb';
  const result = spawnSync(adb, ['devices', '-l'], { encoding: 'utf8' });
  if (result.error) throw new Error(`Unable to run ${adb} devices -l: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`adb devices -l failed: ${result.stderr.trim() || result.stdout.trim()}`);

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('List of devices attached'))
    .map(line => line.split(/\s+/u))
    .filter(parts => parts[1] === 'device')
    .map(parts => parts[0]!)
    .filter(Boolean);
}

function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function daemonPort(): number {
  const parsed = Number(process.env.OMNIDECK_PORT ?? 4317);
  return Number.isFinite(parsed) ? parsed : 4317;
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(150);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

const options = parseCli(process.argv.slice(2));
const serials = options.serials.length ? options.serials : envSerials().length ? envSerials() : discoverAuthorizedAndroidSerials();

if (!serials.length) {
  throw new Error('No authorized Android devices found. Confirm USB debugging, run `adb devices -l`, then retry with `npm run desktop:dev:android -- --serial=<serial>`.');
}

const port = daemonPort();
if (!options.dryRun && process.env.OMNIDECK_ALLOW_EXISTING_DAEMON !== 'true' && await isPortListening(port)) {
  throw new Error(`ControlDaemon is already listening on 127.0.0.1:${port}. Stop the existing dev process first so the desktop app does not connect to a stale simulated daemon.`);
}

const env = {
  ...process.env,
  OMNIDECK_ENABLE_REAL_DEVICES: 'true',
  OMNIDECK_ANDROID_DRIVER_MODE: 'ANDROID_ADB_SCRCPY',
  OMNIDECK_ANDROID_SERIALS: serials.join(','),
  OMNIDECK_START_SCRCPY_PROCESS: process.env.OMNIDECK_START_SCRCPY_PROCESS ?? 'false',
};

console.log(`[OmniDeck] Starting desktop Android dev with serials: ${serials.join(', ')}`);
console.log('[OmniDeck] Real-device mode is opt-in for this process only.');

if (options.dryRun) {
  console.log(JSON.stringify({
    OMNIDECK_ENABLE_REAL_DEVICES: env.OMNIDECK_ENABLE_REAL_DEVICES,
    OMNIDECK_ANDROID_DRIVER_MODE: env.OMNIDECK_ANDROID_DRIVER_MODE,
    OMNIDECK_ANDROID_SERIALS: env.OMNIDECK_ANDROID_SERIALS,
    OMNIDECK_START_SCRCPY_PROCESS: env.OMNIDECK_START_SCRCPY_PROCESS,
  }, null, 2));
  process.exit(0);
}

const child = spawn(npmBin(), ['run', 'desktop:dev', '--', ...options.passthrough], {
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
