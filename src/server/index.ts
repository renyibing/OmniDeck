import { ControlDaemon } from './controlDaemon';

const driverMode = process.env.OMNIDECK_DRIVER_MODE as 'SIMULATED' | 'ANDROID_ADB_SCRCPY' | 'IOS_XCUITEST' | undefined;
const androidDriverMode = process.env.OMNIDECK_ANDROID_DRIVER_MODE as 'SIMULATED' | 'ANDROID_ADB_SCRCPY' | undefined;
const iosDriverMode = process.env.OMNIDECK_IOS_DRIVER_MODE as 'SIMULATED' | 'IOS_XCUITEST' | undefined;
const daemon = new ControlDaemon({
  driverMode,
  androidDriverMode,
  iosDriverMode,
  realDevices: process.env.OMNIDECK_ENABLE_REAL_DEVICES === 'true',
  androidSerial: process.env.OMNIDECK_ANDROID_SERIAL,
  iosUdid: process.env.OMNIDECK_IOS_UDID,
  wdaUrl: process.env.OMNIDECK_WDA_URL,
  adbPath: process.env.OMNIDECK_ADB_PATH,
  scrcpyPath: process.env.OMNIDECK_SCRCPY_PATH,
});
const port = Number(process.env.OMNIDECK_PORT ?? 4317);
await daemon.listen({ host: process.env.OMNIDECK_HOST ?? '127.0.0.1', port });
console.log(`OmniDeck Control Daemon listening on http://127.0.0.1:${port}`);

const shutdown = async () => { await daemon.close(); process.exit(0); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
