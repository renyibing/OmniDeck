type JsonObject = Record<string, unknown>;

const daemonUrl = (process.env.OMNIDECK_DAEMON_URL ?? 'http://127.0.0.1:4317').replace(/\/+$/, '');
const targetSerial = process.env.OMNIDECK_SMOKE_ANDROID_SERIAL?.trim();
const targetDeviceId = process.env.OMNIDECK_SMOKE_DEVICE_ID?.trim();
const appId = process.env.OMNIDECK_SMOKE_APP_ID?.trim() || 'com.android.settings';
const actionList = (process.env.OMNIDECK_SMOKE_ACTIONS ?? '')
  .split(',')
  .map(action => action.trim())
  .filter(Boolean);
const confirmed = process.env.OMNIDECK_SMOKE_CONFIRM_ACTIONS === 'I_AUTHORIZE_DEVICE_ACTIONS';
const textInput = process.env.OMNIDECK_SMOKE_TEXT ?? 'OmniDeck smoke';

if (process.argv.includes('--help')) {
  printHelp();
  process.exit(0);
}

if (!targetSerial) {
  printHelp();
  fail('OMNIDECK_SMOKE_ANDROID_SERIAL is required so the smoke test cannot hit an implicit ADB target.');
}

const candidate = await discoverAndroidCandidate();
const deviceId = stringValue(candidate.deviceId);
if (!deviceId) fail('Discovered Android candidate did not include a deviceId.');
if (targetDeviceId && targetDeviceId !== deviceId) fail(`Requested deviceId ${targetDeviceId} did not match discovered ${deviceId}.`);

console.log(`Target Android device: ${deviceId} serial=${targetSerial}`);
await post('/api/devices/configure', {
  commandId: commandId('configure'),
  timestamp: Date.now(),
  configuration: {
    deviceId,
    platform: 'ANDROID',
    name: stringValue(candidate.name) || `Android ${targetSerial}`,
    identifier: targetSerial,
    appId,
    transport: 'ADB',
    orientation: 'PORTRAIT',
    driverMode: 'ANDROID_ADB_SCRCPY',
  },
});
await post(`/api/devices/${encodeURIComponent(deviceId)}/connect`, command(deviceId, 'connect'));
await post(`/api/devices/${encodeURIComponent(deviceId)}/take-control`, command(deviceId, 'take-control'));

const beforeTree = await getUiTree(deviceId);
assertNonEmptyUiTree(beforeTree, 'before actions');
console.log(`UI tree reachable before actions: ${beforeTree.nodes.length} nodes`);
await assertRuntimeSummaryIsLightweight(deviceId);

if (!actionList.length) {
  console.log('No device actions requested. Set OMNIDECK_SMOKE_ACTIONS to back,home,swipe-up,swipe-down,long-press,input-text,stop-app after authorizing the target device.');
  process.exit(0);
}
if (!confirmed) fail('Set OMNIDECK_SMOKE_CONFIRM_ACTIONS=I_AUTHORIZE_DEVICE_ACTIONS before running real device actions.');

for (const action of actionList) await runAction(deviceId, action);

const afterTree = await getUiTree(deviceId);
assertNonEmptyUiTree(afterTree, 'after actions');
const detail = await requestJson(`/api/devices/${encodeURIComponent(deviceId)}`);
const history = JSON.stringify((detail.device as JsonObject | undefined)?.actionHistory ?? []);
if (actionList.includes('input-text') && history.includes(textInput)) fail('ActionHistory leaked raw input text.');
assertActionHistory(actionList, history);
console.log(`UI tree reachable after actions: ${afterTree.nodes.length} nodes`);
console.log('Android action smoke completed without cross-device or summary UI-tree leakage checks failing.');

async function discoverAndroidCandidate(): Promise<JsonObject> {
  const discovery = await requestJson('/api/devices/discovery');
  const devices = Array.isArray(discovery.devices) ? discovery.devices as JsonObject[] : [];
  const exact = devices.find(device => device.platform === 'ANDROID' && device.identifier === targetSerial);
  if (exact) return exact;
  const available = devices
    .filter(device => device.platform === 'ANDROID')
    .map(device => `${stringValue(device.deviceId) ?? 'unknown'}:${stringValue(device.identifier) ?? 'unknown'}`)
    .join(', ');
  fail(`No discovered Android candidate matched serial ${targetSerial}. Available Android candidates: ${available || 'none'}.`);
}

async function runAction(deviceId: string, action: string): Promise<void> {
  switch (action) {
    case 'back':
    case 'home':
      await post(`/api/devices/${encodeURIComponent(deviceId)}/${action}`, command(deviceId, action));
      break;
    case 'swipe-up':
      await post(`/api/devices/${encodeURIComponent(deviceId)}/swipe`, { ...command(deviceId, action), from: { x: 0.5, y: 0.78 }, to: { x: 0.5, y: 0.28 }, durationMs: 360, source: 'INSPECTOR' });
      break;
    case 'swipe-down':
      await post(`/api/devices/${encodeURIComponent(deviceId)}/swipe`, { ...command(deviceId, action), from: { x: 0.5, y: 0.28 }, to: { x: 0.5, y: 0.78 }, durationMs: 360, source: 'INSPECTOR' });
      break;
    case 'long-press':
      await post(`/api/devices/${encodeURIComponent(deviceId)}/long-press`, { ...command(deviceId, action), point: { x: 0.5, y: 0.5 }, durationMs: 650, source: 'INSPECTOR' });
      break;
    case 'input-text':
      await post(`/api/devices/${encodeURIComponent(deviceId)}/input-text`, { ...command(deviceId, action), text: textInput, source: 'INSPECTOR' });
      break;
    case 'stop-app':
      await post(`/api/devices/${encodeURIComponent(deviceId)}/stop-app`, { ...command(deviceId, action), appId });
      break;
    default:
      fail(`Unsupported smoke action: ${action}`);
  }
  console.log(`Executed ${action} on ${deviceId}`);
}

async function getUiTree(deviceId: string): Promise<{ nodes: unknown[] }> {
  const result = await requestJson(`/api/devices/${encodeURIComponent(deviceId)}/ui-tree`);
  const uiTree = result.uiTree as { nodes?: unknown[] } | undefined;
  if (!Array.isArray(uiTree?.nodes)) fail('UI tree response did not include nodes.');
  return { nodes: uiTree.nodes };
}

function assertNonEmptyUiTree(tree: { nodes: unknown[] }, phase: string): void {
  if (!tree.nodes.length) fail(`UI tree was empty ${phase}; real Android UIAutomator should expose at least the root node.`);
}

function assertActionHistory(actions: string[], history: string): void {
  const expected = new Set(actions.map(action => {
    if (action === 'swipe-up' || action === 'swipe-down') return 'action=swipe';
    if (action === 'long-press') return 'action=long_press';
    if (action === 'input-text') return 'action=input_text';
    if (action === 'stop-app') return 'action=stop_app';
    return `action=${action}`;
  }));
  expected.forEach(fragment => {
    if (!history.includes(fragment)) fail(`ActionHistory did not include ${fragment}.`);
  });
  if (!history.includes('verification=UI_HIERARCHY_AFTER_ACTION')) fail('ActionHistory did not include post-action UI hierarchy verification.');
}

async function assertRuntimeSummaryIsLightweight(deviceId: string): Promise<void> {
  const runtime = await requestJson('/api/runtime');
  const devices = Array.isArray(runtime.devices) ? runtime.devices as JsonObject[] : [];
  const summary = devices.find(device => device.id === deviceId);
  if (!summary) fail(`Runtime summary missing ${deviceId}.`);
  if ('uiTree' in summary) fail('DeviceSummaryDTO leaked uiTree into /api/runtime.');
}

function command(deviceId: string, action: string): JsonObject {
  return { commandId: commandId(action), timestamp: Date.now(), deviceId };
}

function commandId(action: string): string {
  return `android-smoke-${action}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function post(path: string, body: JsonObject): Promise<JsonObject> {
  return requestJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function requestJson(path: string, init?: RequestInit): Promise<JsonObject> {
  const response = await fetch(`${daemonUrl}${path}`, init);
  const payload = await response.json().catch(() => ({})) as JsonObject;
  if (!response.ok) fail(`${init?.method ?? 'GET'} ${path} failed (${response.status}): ${stringValue(payload.error) ?? JSON.stringify(payload)}`);
  return payload;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`Android real-device action smoke

Required daemon setup in another terminal:
  OMNIDECK_ENABLE_REAL_DEVICES=true OMNIDECK_ANDROID_SERIALS=<serial> npm run dev

Read-only readiness/UI-tree check:
  OMNIDECK_SMOKE_ANDROID_SERIAL=<serial> npm run smoke:android-actions

Authorized action check:
  OMNIDECK_SMOKE_ANDROID_SERIAL=<serial> \\
  OMNIDECK_SMOKE_ACTIONS=back,home,swipe-up,swipe-down,long-press,input-text,stop-app \\
  OMNIDECK_SMOKE_CONFIRM_ACTIONS=I_AUTHORIZE_DEVICE_ACTIONS \\
  npm run smoke:android-actions

Optional:
  OMNIDECK_DAEMON_URL=http://127.0.0.1:4317
  OMNIDECK_SMOKE_DEVICE_ID=device-01
  OMNIDECK_SMOKE_TEXT="OmniDeck smoke"
  OMNIDECK_SMOKE_APP_ID=com.android.settings`);
}
