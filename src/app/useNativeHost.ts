import { useCallback, useEffect, useState } from 'react';
import type { DeviceSummaryDTO } from '../server/protocol';
import {
  allocateNativeIosWdaPort,
  getNativeDeviceProcess,
  getNativeHostStatus,
  isNativeHostAvailable,
  nativeProcessKindsForDevice,
  readNativeDeviceProcessLogs,
  shouldLoadNativeProcessLogs,
  startNativeAndroidScrcpy,
  startNativeControlDaemon,
  startNativeIosIproxy,
  stopNativeAndroidScrcpy,
  stopNativeControlDaemon,
  stopNativeIosIproxy,
  type IosWdaPortAllocation,
  type NativeDeviceProcessStatus,
  type NativeHostStatus,
  type NativeProcessKind,
} from './nativeHostClient';

export interface NativeHostController {
  available: boolean;
  loading: boolean;
  status: NativeHostStatus | null;
  selectedDeviceProcess: NativeSelectedDeviceProcess;
  error: string | null;
  refresh: () => void;
  startDaemon: () => void;
  stopDaemon: () => void;
}

export interface NativeSelectedDeviceProcess {
  loading: boolean;
  processes: NativeDeviceProcessStatus[];
  logs: string[];
  allocatedWdaPort: IosWdaPortAllocation | null;
  refresh: () => void;
  startScrcpy: () => void;
  stopScrcpy: () => void;
  allocateWdaPort: () => void;
  startIproxy: () => void;
  stopIproxy: () => void;
}

export function useNativeHost(selectedDevice?: (DeviceSummaryDTO | null)): NativeHostController {
  const [available] = useState(() => isNativeHostAvailable());
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<NativeHostStatus | null>(null);
  const [processLoading, setProcessLoading] = useState(false);
  const [processes, setProcesses] = useState<NativeDeviceProcessStatus[]>([]);
  const [processLogs, setProcessLogs] = useState<string[]>([]);
  const [allocatedWdaPort, setAllocatedWdaPort] = useState<IosWdaPortAllocation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!available) return;
    setLoading(true);
    void getNativeHostStatus()
      .then(next => { setStatus(next); setError(null); })
      .catch(caught => setError(describeNativeHostError(caught)))
      .finally(() => setLoading(false));
  }, [available]);

  const startDaemon = useCallback(() => {
    if (!available) return;
    setLoading(true);
    void startNativeControlDaemon()
      .then(next => { setStatus(next); setError(null); })
      .catch(caught => setError(describeNativeHostError(caught)))
      .finally(() => setLoading(false));
  }, [available]);

  const stopDaemon = useCallback(() => {
    if (!available) return;
    setLoading(true);
    void stopNativeControlDaemon()
      .then(next => { setStatus(next); setError(null); })
      .catch(caught => setError(describeNativeHostError(caught)))
      .finally(() => setLoading(false));
  }, [available]);

  const refreshSelectedProcesses = useCallback(() => {
    if (!shouldLoadNativeProcessLogs(available, selectedDevice)) {
      setProcesses([]);
      setProcessLogs([]);
      return;
    }
    const kinds = nativeProcessKindsForDevice(selectedDevice);
    setProcessLoading(true);
    void Promise.all(kinds.map(kind => getNativeDeviceProcess(selectedDevice!.id, kind)))
      .then(async results => {
        const nextProcesses = results.filter((process): process is NativeDeviceProcessStatus => Boolean(process));
        setProcesses(nextProcesses);
        const logKind = kinds[0];
        const logs = logKind ? await readNativeDeviceProcessLogs(selectedDevice!.id, logKind) : [];
        setProcessLogs(logs);
        setError(null);
      })
      .catch(caught => setError(describeNativeHostError(caught)))
      .finally(() => setProcessLoading(false));
  }, [available, selectedDevice?.id, selectedDevice?.platform]);

  const startScrcpy = useCallback(() => {
    if (!available || selectedDevice?.platform !== 'ANDROID') return;
    const serial = selectedDevice.configuration?.identifier;
    if (!serial) { setError('Android serial is not configured for this device'); return; }
    setProcessLoading(true);
    void startNativeAndroidScrcpy(selectedDevice.id, serial, { maxSize: 720, maxFps: 10, videoBitRate: '2M', noAudio: true })
      .then(process => { setProcesses([process]); setProcessLogs(process.logTail); setError(null); })
      .catch(caught => setError(describeNativeHostError(caught)))
      .finally(() => setProcessLoading(false));
  }, [available, selectedDevice?.id, selectedDevice?.platform, selectedDevice?.configuration?.identifier]);

  const stopScrcpy = useCallback(() => {
    if (!available || selectedDevice?.platform !== 'ANDROID') return;
    setProcessLoading(true);
    void stopNativeAndroidScrcpy(selectedDevice.id)
      .then(process => { setProcesses([process]); setProcessLogs(process.logTail); setError(null); })
      .catch(caught => setError(describeNativeHostError(caught)))
      .finally(() => setProcessLoading(false));
  }, [available, selectedDevice?.id, selectedDevice?.platform]);

  const allocateWdaPort = useCallback(() => {
    if (!available || selectedDevice?.platform !== 'IOS') return;
    const udid = selectedDevice.configuration?.identifier;
    if (!udid) { setError('iOS UDID is not configured for this device'); return; }
    setProcessLoading(true);
    void allocateNativeIosWdaPort(selectedDevice.id, udid)
      .then(allocation => { setAllocatedWdaPort(allocation); setError(null); })
      .catch(caught => setError(describeNativeHostError(caught)))
      .finally(() => setProcessLoading(false));
  }, [available, selectedDevice?.id, selectedDevice?.platform, selectedDevice?.configuration?.identifier]);

  const startIproxy = useCallback(() => {
    if (!available || selectedDevice?.platform !== 'IOS') return;
    const udid = selectedDevice.configuration?.identifier;
    if (!udid) { setError('iOS UDID is not configured for this device'); return; }
    setProcessLoading(true);
    const portPromise = allocatedWdaPort && allocatedWdaPort.udid === udid
      ? Promise.resolve(allocatedWdaPort)
      : allocateNativeIosWdaPort(selectedDevice.id, udid);
    void portPromise
      .then(allocation => {
        setAllocatedWdaPort(allocation);
        return startNativeIosIproxy(selectedDevice.id, udid, allocation.localPort, allocation.remotePort);
      })
      .then(process => { setProcesses([process]); setProcessLogs(process.logTail); setError(null); })
      .catch(caught => setError(describeNativeHostError(caught)))
      .finally(() => setProcessLoading(false));
  }, [available, allocatedWdaPort, selectedDevice?.id, selectedDevice?.platform, selectedDevice?.configuration?.identifier]);

  const stopIproxy = useCallback(() => {
    if (!available || selectedDevice?.platform !== 'IOS') return;
    setProcessLoading(true);
    void stopNativeIosIproxy(selectedDevice.id)
      .then(process => { setProcesses([process]); setProcessLogs(process.logTail); setAllocatedWdaPort(null); setError(null); })
      .catch(caught => setError(describeNativeHostError(caught)))
      .finally(() => setProcessLoading(false));
  }, [available, selectedDevice?.id, selectedDevice?.platform]);

  useEffect(() => {
    if (!available) return;
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [available, refresh]);

  useEffect(() => {
    setAllocatedWdaPort(null);
    refreshSelectedProcesses();
  }, [refreshSelectedProcesses]);

  return {
    available,
    loading,
    status,
    error,
    refresh,
    startDaemon,
    stopDaemon,
    selectedDeviceProcess: {
      loading: processLoading,
      processes,
      logs: processLogs,
      allocatedWdaPort,
      refresh: refreshSelectedProcesses,
      startScrcpy,
      stopScrcpy,
      allocateWdaPort,
      startIproxy,
      stopIproxy,
    },
  };
}

function describeNativeHostError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Native host command failed';
}
