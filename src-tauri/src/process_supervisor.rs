use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::device_process::{command_display, DeviceProcessCommand, DeviceProcessKey, DeviceProcessSnapshot, ProcessKind, ProcessStatus};

const LOG_LIMIT: usize = 300;

pub struct ProcessSupervisor {
    processes: HashMap<DeviceProcessKey, ManagedProcess>,
}

struct ManagedProcess {
    key: DeviceProcessKey,
    child: Option<Child>,
    status: ProcessStatus,
    command: String,
    log_tail: Arc<Mutex<VecDeque<String>>>,
    started_at_ms: Option<u128>,
    updated_at_ms: u128,
    exit_code: Option<i32>,
    last_error: Option<String>,
}

impl ProcessSupervisor {
    pub fn new() -> Self {
        Self { processes: HashMap::new() }
    }

    pub fn start_process(&mut self, key: DeviceProcessKey, command: DeviceProcessCommand) -> Result<DeviceProcessSnapshot, String> {
        if let Some(existing) = self.processes.get_mut(&key) {
            existing.refresh();
            if existing.status == ProcessStatus::Running || existing.status == ProcessStatus::Starting {
                return Ok(existing.snapshot());
            }
        }

        let command_text = command_display(&command);
        let log_tail = Arc::new(Mutex::new(VecDeque::new()));
        push_log(&log_tail, "native", &format!("starting {command_text}"));
        let mut child = Command::new(&command.program)
            .args(&command.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start {command_text}: {error}"))?;

        if let Some(stdout) = child.stdout.take() {
            pipe_logs(stdout, "stdout", Arc::clone(&log_tail));
        }
        if let Some(stderr) = child.stderr.take() {
            pipe_logs(stderr, "stderr", Arc::clone(&log_tail));
        }

        let now = now_ms();
        let managed = ManagedProcess {
            key: key.clone(),
            child: Some(child),
            status: ProcessStatus::Running,
            command: command_text,
            log_tail,
            started_at_ms: Some(now),
            updated_at_ms: now,
            exit_code: None,
            last_error: None,
        };
        let snapshot = managed.snapshot();
        self.processes.insert(key, managed);
        Ok(snapshot)
    }

    pub fn stop_process(&mut self, device_id: &str, process_kind: ProcessKind) -> Result<DeviceProcessSnapshot, String> {
        let key = self.find_key(device_id, process_kind).ok_or_else(|| format!("No {process_kind:?} process for {device_id}"))?;
        let process = self.processes.get_mut(&key).ok_or_else(|| format!("No {process_kind:?} process for {device_id}"))?;
        process.stop()?;
        Ok(process.snapshot())
    }

    pub fn get_process(&mut self, device_id: &str, process_kind: ProcessKind) -> Option<DeviceProcessSnapshot> {
        let key = self.find_key(device_id, process_kind)?;
        let process = self.processes.get_mut(&key)?;
        process.refresh();
        Some(process.snapshot())
    }

    pub fn list_processes(&mut self) -> Vec<DeviceProcessSnapshot> {
        self.processes.values_mut().map(|process| {
            process.refresh();
            process.snapshot()
        }).collect()
    }

    pub fn read_logs(&mut self, device_id: &str, process_kind: ProcessKind) -> Vec<String> {
        self.get_process(device_id, process_kind)
            .map(|snapshot| snapshot.log_tail)
            .unwrap_or_default()
    }

    fn find_key(&self, device_id: &str, process_kind: ProcessKind) -> Option<DeviceProcessKey> {
        self.processes.keys()
            .find(|key| key.device_id == device_id && key.process_kind == process_kind)
            .cloned()
    }
}

impl Drop for ProcessSupervisor {
    fn drop(&mut self) {
        for process in self.processes.values_mut() {
            let _ = process.stop();
        }
    }
}

impl ManagedProcess {
    fn refresh(&mut self) {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.exit_code = status.code();
                    self.status = if status.success() { ProcessStatus::Exited } else { ProcessStatus::Failed };
                    self.last_error = if status.success() { None } else { Some(format!("process exited with status {status}")) };
                    self.child = None;
                    self.updated_at_ms = now_ms();
                    push_log(&self.log_tail, "native", &format!("process exited with status {status}"));
                }
                Ok(None) => {
                    self.status = ProcessStatus::Running;
                }
                Err(error) => {
                    self.status = ProcessStatus::Failed;
                    self.last_error = Some(format!("process status check failed: {error}"));
                    self.child = None;
                    self.updated_at_ms = now_ms();
                }
            }
        }
    }

    fn stop(&mut self) -> Result<(), String> {
        self.refresh();
        if let Some(mut child) = self.child.take() {
            child.kill().map_err(|error| format!("failed to stop {}: {error}", self.command))?;
            let _ = child.wait();
            push_log(&self.log_tail, "native", "process stopped by native host");
        }
        self.status = ProcessStatus::Stopped;
        self.updated_at_ms = now_ms();
        self.exit_code = None;
        self.last_error = None;
        Ok(())
    }

    fn snapshot(&self) -> DeviceProcessSnapshot {
        DeviceProcessSnapshot {
            key: self.key.clone(),
            status: self.status,
            pid: self.child.as_ref().map(Child::id),
            command: self.command.clone(),
            started_at_ms: self.started_at_ms,
            updated_at_ms: self.updated_at_ms,
            exit_code: self.exit_code,
            last_error: self.last_error.clone(),
            log_tail: self.log_tail.lock().map(|logs| logs.iter().cloned().collect()).unwrap_or_default(),
        }
    }
}

fn pipe_logs<R>(reader: R, source: &'static str, target: Arc<Mutex<VecDeque<String>>>)
where
    R: std::io::Read + Send + 'static,
{
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            push_log(&target, source, &line);
        }
    });
}

fn push_log(target: &Arc<Mutex<VecDeque<String>>>, source: &str, line: &str) {
    if let Ok(mut logs) = target.lock() {
        logs.push_back(format!("[{source}] {line}"));
        while logs.len() > LOG_LIMIT {
            logs.pop_front();
        }
    }
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis()).unwrap_or_default()
}
