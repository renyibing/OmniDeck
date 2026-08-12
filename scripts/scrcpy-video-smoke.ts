import { ScrcpyVideoSession } from '../src/domain/scrcpyVideoSession.ts';

const serial = process.env.OMNIDECK_ANDROID_SERIAL ?? '63c7a9c9';
const session = new ScrcpyVideoSession({
  deviceId: 'device-01',
  serial,
  scrcpyPath: process.env.OMNIDECK_SCRCPY_PATH ?? 'scrcpy',
});

let count = 0;
session.subscribe(packet => {
  count += 1;
  console.log(JSON.stringify({
    kind: packet.kind,
    bytes: packet.data.length,
    head: packet.data.subarray(0, 12).toString('hex'),
  }));
  if (count >= 8) {
    void session.stop().then(() => process.exit(0));
  }
});

await session.ensure({
  mode: 'FOCUSED',
  width: 720,
  height: 1280,
  fps: 30,
  bitrateKbps: 3500,
});

setTimeout(() => {
  console.error(`Timed out after receiving ${count} packets`);
  void session.stop().finally(() => process.exit(1));
}, 12_000);
