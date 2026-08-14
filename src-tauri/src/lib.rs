mod device_process;
mod port_allocator;
mod process_supervisor;

use device_process::{build_android_scrcpy_command, build_ios_iproxy_command, validate_process_token, AndroidScrcpyOptions, DeviceProcessKey, DeviceProcessPlatform, DeviceProcessSnapshot, ProcessKind};
use port_allocator::{PortAllocation, PortAllocator};
use process_supervisor::ProcessSupervisor;
use serde::Serialize;
use std::{
    collections::VecDeque,
    env,
    io::{BufRead, BufReader},
    net::{TcpStream, ToSocketAddrs},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

const DEFAULT_DAEMON_PORT: u16 = 4317;
const LOG_LIMIT: usize = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeHostStatus {
    available: bool,
    running: bool,
    pid: Option<u32>,
    base_url: String,
    project_root: String,
    command: String,
    log_tail: Vec<String>,
    last_error: Option<String>,
}

struct NativeHostState {
    daemon: Mutex<DaemonProcess>,
    process_supervisor: Mutex<ProcessSupervisor>,
    port_allocator: Mutex<PortAllocator>,
}

struct DaemonProcess {
    child: Option<Child>,
    log_tail: Arc<Mutex<VecDeque<String>>>,
    last_error: Option<String>,
}

impl DaemonProcess {
    fn new() -> Self {
        Self {
            child: None,
            log_tail: Arc::new(Mutex::new(VecDeque::new())),
            last_error: None,
        }
    }

    fn refresh(&mut self) {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.last_error = Some(format!("ControlDaemon exited with status {status}"));
                    self.child = None;
                }
                Ok(None) => {}
                Err(error) => {
                    self.last_error = Some(format!("ControlDaemon status check failed: {error}"));
                    self.child = None;
                }
            }
        }
    }

    fn status(&mut self) -> NativeHostStatus {
        self.refresh();
        let running = self.child.is_some() || daemon_port_listening();
        NativeHostStatus {
            available: true,
            running,
            pid: self.child.as_ref().map(Child::id),
            base_url: daemon_base_url(),
            project_root: project_root().display().to_string(),
            command: daemon_command_display(),
            log_tail: self.log_tail.lock().map(|logs| logs.iter().cloned().collect()).unwrap_or_default(),
            last_error: self.last_error.clone(),
        }
    }

    fn start(&mut self) -> Result<NativeHostStatus, String> {
        self.refresh();
        if self.child.is_some() {
            return Ok(self.status());
        }
        if daemon_port_listening() {
            push_log(&self.log_tail, "native", "ControlDaemon already reachable on configured port");
            self.last_error = None;
            return Ok(self.status());
        }

        let command = daemon_command();
        let mut child = Command::new(&command.program)
            .args(&command.args)
            .current_dir(project_root())
            .env("OMNIDECK_PORT", daemon_port().to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start ControlDaemon with {}: {error}", daemon_command_display()))?;

        if let Some(stdout) = child.stdout.take() {
            pipe_logs(stdout, "stdout", Arc::clone(&self.log_tail));
        }
        if let Some(stderr) = child.stderr.take() {
            pipe_logs(stderr, "stderr", Arc::clone(&self.log_tail));
        }

        self.last_error = None;
        self.child = Some(child);
        Ok(self.status())
    }

    fn stop(&mut self) -> Result<NativeHostStatus, String> {
        if let Some(mut child) = self.child.take() {
            if let Err(error) = child.kill() {
                self.last_error = Some(format!("Failed to stop ControlDaemon: {error}"));
                return Err(self.last_error.clone().unwrap_or_else(|| "Failed to stop ControlDaemon".to_string()));
            }
            let _ = child.wait();
            push_log(&self.log_tail, "native", "ControlDaemon stopped by native host");
            self.last_error = None;
        }
        Ok(self.status())
    }
}

impl Drop for DaemonProcess {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct DaemonCommand {
    program: String,
    args: Vec<String>,
}

#[tauri::command]
fn daemon_status(state: tauri::State<'_, NativeHostState>) -> Result<NativeHostStatus, String> {
    state.daemon.lock().map_err(|_| "Native host lock poisoned".to_string()).map(|mut daemon| daemon.status())
}

#[tauri::command]
fn start_control_daemon(state: tauri::State<'_, NativeHostState>) -> Result<NativeHostStatus, String> {
    state.daemon.lock().map_err(|_| "Native host lock poisoned".to_string())?.start()
}

#[tauri::command]
fn stop_control_daemon(state: tauri::State<'_, NativeHostState>) -> Result<NativeHostStatus, String> {
    state.daemon.lock().map_err(|_| "Native host lock poisoned".to_string())?.stop()
}

#[tauri::command]
fn read_control_daemon_logs(state: tauri::State<'_, NativeHostState>) -> Result<Vec<String>, String> {
    state.daemon.lock().map_err(|_| "Native host lock poisoned".to_string())?.log_tail
        .lock()
        .map(|logs| logs.iter().cloned().collect())
        .map_err(|_| "Native host log lock poisoned".to_string())
}

#[tauri::command]
fn list_device_processes(state: tauri::State<'_, NativeHostState>) -> Result<Vec<DeviceProcessSnapshot>, String> {
    state.process_supervisor.lock().map_err(|_| "Process supervisor lock poisoned".to_string()).map(|mut supervisor| supervisor.list_processes())
}

#[tauri::command]
fn get_device_process(state: tauri::State<'_, NativeHostState>, device_id: String, process_kind: ProcessKind) -> Result<Option<DeviceProcessSnapshot>, String> {
    validate_process_token("deviceId", &device_id)?;
    state.process_supervisor.lock().map_err(|_| "Process supervisor lock poisoned".to_string()).map(|mut supervisor| supervisor.get_process(&device_id, process_kind))
}

#[tauri::command]
fn start_android_scrcpy(state: tauri::State<'_, NativeHostState>, device_id: String, serial: String, options: AndroidScrcpyOptions) -> Result<DeviceProcessSnapshot, String> {
    validate_process_token("deviceId", &device_id)?;
    validate_process_token("serial", &serial)?;
    let command = build_android_scrcpy_command(scrcpy_bin(), &serial, &options)?;
    let key = DeviceProcessKey {
        device_id,
        platform: DeviceProcessPlatform::Android,
        process_kind: ProcessKind::Scrcpy,
        identifier: serial,
    };
    state.process_supervisor.lock().map_err(|_| "Process supervisor lock poisoned".to_string())?.start_process(key, command)
}

#[tauri::command]
fn stop_android_scrcpy(state: tauri::State<'_, NativeHostState>, device_id: String) -> Result<DeviceProcessSnapshot, String> {
    validate_process_token("deviceId", &device_id)?;
    state.process_supervisor.lock().map_err(|_| "Process supervisor lock poisoned".to_string())?.stop_process(&device_id, ProcessKind::Scrcpy)
}

#[tauri::command]
fn start_ios_iproxy(state: tauri::State<'_, NativeHostState>, device_id: String, udid: String, local_port: u16, remote_port: u16) -> Result<DeviceProcessSnapshot, String> {
    validate_process_token("deviceId", &device_id)?;
    validate_process_token("udid", &udid)?;
    let command = build_ios_iproxy_command(iproxy_bin(), &udid, local_port, remote_port)?;
    let key = DeviceProcessKey {
        device_id,
        platform: DeviceProcessPlatform::Ios,
        process_kind: ProcessKind::Iproxy,
        identifier: udid,
    };
    state.process_supervisor.lock().map_err(|_| "Process supervisor lock poisoned".to_string())?.start_process(key, command)
}

#[tauri::command]
fn stop_ios_iproxy(state: tauri::State<'_, NativeHostState>, device_id: String) -> Result<DeviceProcessSnapshot, String> {
    validate_process_token("deviceId", &device_id)?;
    let snapshot = state.process_supervisor.lock().map_err(|_| "Process supervisor lock poisoned".to_string())?.stop_process(&device_id, ProcessKind::Iproxy)?;
    let _released = state.port_allocator.lock().map_err(|_| "Port allocator lock poisoned".to_string())?.release_udid(&snapshot.key.identifier);
    Ok(snapshot)
}

#[tauri::command]
fn allocate_ios_wda_port(state: tauri::State<'_, NativeHostState>, device_id: String, udid: String) -> Result<PortAllocation, String> {
    state.port_allocator.lock().map_err(|_| "Port allocator lock poisoned".to_string())?.allocate_ios_wda_port(&device_id, &udid)
}

#[tauri::command]
fn read_device_process_logs(state: tauri::State<'_, NativeHostState>, device_id: String, process_kind: ProcessKind) -> Result<Vec<String>, String> {
    validate_process_token("deviceId", &device_id)?;
    Ok(state.process_supervisor.lock().map_err(|_| "Process supervisor lock poisoned".to_string())?.read_logs(&device_id, process_kind))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(NativeHostState {
            daemon: Mutex::new(DaemonProcess::new()),
            process_supervisor: Mutex::new(ProcessSupervisor::new()),
            port_allocator: Mutex::new(PortAllocator::default()),
        })
        .invoke_handler(tauri::generate_handler![
            daemon_status,
            start_control_daemon,
            stop_control_daemon,
            read_control_daemon_logs,
            list_device_processes,
            get_device_process,
            start_android_scrcpy,
            stop_android_scrcpy,
            start_ios_iproxy,
            stop_ios_iproxy,
            allocate_ios_wda_port,
            read_device_process_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OmniDeck desktop host");
}

fn daemon_command() -> DaemonCommand {
    if let Ok(raw) = env::var("OMNIDECK_DAEMON_COMMAND") {
        let parts = shell_split(&raw);
        if let Some((program, args)) = parts.split_first() {
            return DaemonCommand { program: program.clone(), args: args.to_vec() };
        }
    }
    DaemonCommand {
        program: env::var("OMNIDECK_NPM_BIN").unwrap_or_else(|_| "npm".to_string()),
        args: vec!["run".to_string(), "start:daemon".to_string()],
    }
}

fn daemon_command_display() -> String {
    let command = daemon_command();
    std::iter::once(command.program).chain(command.args).collect::<Vec<_>>().join(" ")
}

fn project_root() -> PathBuf {
    if let Ok(root) = env::var("OMNIDECK_PROJECT_ROOT") {
        return PathBuf::from(root);
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.parent().map(PathBuf::from).unwrap_or(manifest_dir)
}

fn daemon_port() -> u16 {
    env::var("OMNIDECK_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_DAEMON_PORT)
}

fn daemon_base_url() -> String {
    format!("http://127.0.0.1:{}", daemon_port())
}

fn daemon_port_listening() -> bool {
    let address = ("127.0.0.1", daemon_port())
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next());
    let Some(address) = address else { return false; };
    TcpStream::connect_timeout(&address, Duration::from_millis(120)).is_ok()
}

fn scrcpy_bin() -> String {
    env::var("OMNIDECK_SCRCPY_BIN").unwrap_or_else(|_| "scrcpy".to_string())
}

fn iproxy_bin() -> String {
    env::var("OMNIDECK_IPROXY_BIN").unwrap_or_else(|_| "iproxy".to_string())
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

fn shell_split(value: &str) -> Vec<String> {
    value.split_whitespace().map(ToString::to_string).collect()
}
