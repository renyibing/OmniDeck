import { invoke } from '@tauri-apps/api/core';

export interface NativeHostStatus {
  available: boolean;
  running: boolean;
  pid: number | null;
  baseUrl: string;
  projectRoot: string;
  command: string;
  logTail: string[];
  lastError: string | null;
}

export type NativeProcessKind = 'CONTROL_DAEMON' | 'ADB_SERVER' | 'SCRCPY' | 'IPROXY' | 'WDA_RUNNER_HELPER';
export type NativeProcessStatusValue = 'STOPPED' | 'STARTING' | 'RUNNING' | 'EXITED' | 'FAILED';

export interface NativeDeviceProcessKey {
  deviceId: string;
  platform: 'ANDROID' | 'IOS' | 'DESKTOP';
  processKind: NativeProcessKind;
  identifier: string;
}

export interface NativeDeviceProcessStatus {
  key: NativeDeviceProcessKey;
  status: NativeProcessStatusValue;
  pid: number | null;
  command: string;
  startedAtMs: number | null;
  updatedAtMs: number;
  exitCode: number | null;
  lastError: string | null;
  logTail: string[];
}

export interface IosWdaPortAllocation {
  deviceId: string;
  udid: string;
  localPort: number;
  remotePort: number;
  reused: boolean;
}

export interface AndroidScrcpyOptions {
  maxSize?: number;
  maxFps?: number;
  videoBitRate?: string;
  noAudio?: boolean;
}

export interface NativeDeviceRef {
  id: string;
  platform: 'ANDROID' | 'IOS';
}

export function isNativeHostAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function getNativeHostStatus(): Promise<NativeHostStatus | null> {
  if (!isNativeHostAvailable()) return null;
  return invoke<NativeHostStatus>('daemon_status');
}

export async function startNativeControlDaemon(): Promise<NativeHostStatus> {
  return invoke<NativeHostStatus>('start_control_daemon');
}

export async function stopNativeControlDaemon(): Promise<NativeHostStatus> {
  return invoke<NativeHostStatus>('stop_control_daemon');
}

export async function readNativeControlDaemonLogs(): Promise<string[]> {
  if (!isNativeHostAvailable()) return [];
  return invoke<string[]>('read_control_daemon_logs');
}

export async function listNativeDeviceProcesses(): Promise<NativeDeviceProcessStatus[]> {
  if (!isNativeHostAvailable()) return [];
  return invoke<NativeDeviceProcessStatus[]>('list_device_processes');
}

export async function getNativeDeviceProcess(deviceId: string, processKind: NativeProcessKind): Promise<NativeDeviceProcessStatus | null> {
  if (!isNativeHostAvailable()) return null;
  return invoke<NativeDeviceProcessStatus | null>('get_device_process', { deviceId, processKind });
}

export async function startNativeAndroidScrcpy(deviceId: string, serial: string, options: AndroidScrcpyOptions = {}): Promise<NativeDeviceProcessStatus> {
  return invoke<NativeDeviceProcessStatus>('start_android_scrcpy', { deviceId, serial, options });
}

export async function stopNativeAndroidScrcpy(deviceId: string): Promise<NativeDeviceProcessStatus> {
  return invoke<NativeDeviceProcessStatus>('stop_android_scrcpy', { deviceId });
}

export async function startNativeIosIproxy(deviceId: string, udid: string, localPort: number, remotePort = 8100): Promise<NativeDeviceProcessStatus> {
  return invoke<NativeDeviceProcessStatus>('start_ios_iproxy', { deviceId, udid, localPort, remotePort });
}

export async function stopNativeIosIproxy(deviceId: string): Promise<NativeDeviceProcessStatus> {
  return invoke<NativeDeviceProcessStatus>('stop_ios_iproxy', { deviceId });
}

export async function allocateNativeIosWdaPort(deviceId: string, udid: string): Promise<IosWdaPortAllocation> {
  return invoke<IosWdaPortAllocation>('allocate_ios_wda_port', { deviceId, udid });
}

export async function readNativeDeviceProcessLogs(deviceId: string, processKind: NativeProcessKind): Promise<string[]> {
  if (!isNativeHostAvailable()) return [];
  return invoke<string[]>('read_device_process_logs', { deviceId, processKind });
}

export function nativeProcessKindsForDevice(device: NativeDeviceRef | null | undefined): NativeProcessKind[] {
  if (!device) return [];
  if (device.platform === 'ANDROID') return ['SCRCPY'];
  if (device.platform === 'IOS') return ['IPROXY'];
  return [];
}

export function shouldLoadNativeProcessLogs(available: boolean, device: NativeDeviceRef | null | undefined): boolean {
  return available && nativeProcessKindsForDevice(device).length > 0;
}
