use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DeviceProcessPlatform {
    Android,
    Ios,
    Desktop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProcessKind {
    ControlDaemon,
    AdbServer,
    Scrcpy,
    Iproxy,
    WdaRunnerHelper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProcessStatus {
    Stopped,
    Starting,
    Running,
    Exited,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProcessKey {
    pub device_id: String,
    pub platform: DeviceProcessPlatform,
    pub process_kind: ProcessKind,
    pub identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProcessSnapshot {
    pub key: DeviceProcessKey,
    pub status: ProcessStatus,
    pub pid: Option<u32>,
    pub command: String,
    pub started_at_ms: Option<u128>,
    pub updated_at_ms: u128,
    pub exit_code: Option<i32>,
    pub last_error: Option<String>,
    pub log_tail: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DeviceProcessCommand {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidScrcpyOptions {
    pub max_size: Option<u16>,
    pub max_fps: Option<u16>,
    pub video_bit_rate: Option<String>,
    pub no_audio: Option<bool>,
}

pub fn build_android_scrcpy_command(program: String, serial: &str, options: &AndroidScrcpyOptions) -> Result<DeviceProcessCommand, String> {
    validate_tool_program(&program, ProcessKind::Scrcpy)?;
    validate_process_token("serial", serial)?;
    let mut args = vec!["--serial".to_string(), serial.to_string()];
    if let Some(max_size) = options.max_size {
        if !(1..=4096).contains(&max_size) {
            return Err("maxSize must be between 1 and 4096".to_string());
        }
        args.extend(["--max-size".to_string(), max_size.to_string()]);
    }
    if let Some(max_fps) = options.max_fps {
        if !(1..=120).contains(&max_fps) {
            return Err("maxFps must be between 1 and 120".to_string());
        }
        args.extend(["--max-fps".to_string(), max_fps.to_string()]);
    }
    if let Some(bit_rate) = options.video_bit_rate.as_deref() {
        validate_bitrate(bit_rate)?;
        args.extend(["--video-bit-rate".to_string(), bit_rate.to_string()]);
    }
    if options.no_audio.unwrap_or(true) {
        args.push("--no-audio".to_string());
    }
    Ok(DeviceProcessCommand { program, args })
}

pub fn build_ios_iproxy_command(program: String, udid: &str, local_port: u16, remote_port: u16) -> Result<DeviceProcessCommand, String> {
    validate_tool_program(&program, ProcessKind::Iproxy)?;
    validate_process_token("udid", udid)?;
    validate_port("localPort", local_port)?;
    validate_port("remotePort", remote_port)?;
    Ok(DeviceProcessCommand {
        program,
        args: vec![local_port.to_string(), remote_port.to_string(), "-u".to_string(), udid.to_string()],
    })
}

pub fn validate_tool_program(program: &str, kind: ProcessKind) -> Result<(), String> {
    let expected = match kind {
        ProcessKind::AdbServer => "adb",
        ProcessKind::Scrcpy => "scrcpy",
        ProcessKind::Iproxy => "iproxy",
        ProcessKind::ControlDaemon | ProcessKind::WdaRunnerHelper => return Err(format!("{kind:?} cannot be started through device process supervisor yet")),
    };
    let executable = Path::new(program)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "tool program must have an executable name".to_string())?;
    if executable != expected {
        return Err(format!("only whitelisted tool {expected} may start {kind:?}"));
    }
    validate_program_path(program)
}

pub fn validate_process_token(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 160 {
        return Err(format!("{name} is required and must be at most 160 characters"));
    }
    if !value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':')) {
        return Err(format!("{name} contains unsupported characters"));
    }
    Ok(())
}

fn validate_program_path(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 512 {
        return Err("tool program path is invalid".to_string());
    }
    if value.chars().any(|ch| ch.is_control() || matches!(ch, ';' | '&' | '|' | '`' | '$' | '>' | '<' | '\n' | '\r')) {
        return Err("tool program path contains shell metacharacters".to_string());
    }
    Ok(())
}

fn validate_bitrate(value: &str) -> Result<(), String> {
    if value.len() > 16 || !value.chars().all(|ch| ch.is_ascii_digit() || matches!(ch, 'K' | 'M' | 'k' | 'm')) {
        return Err("videoBitRate must be a compact value such as 2M".to_string());
    }
    Ok(())
}

fn validate_port(name: &str, value: u16) -> Result<(), String> {
    if value == 0 {
        return Err(format!("{name} must be a non-zero TCP port"));
    }
    Ok(())
}

pub fn command_display(command: &DeviceProcessCommand) -> String {
    std::iter::once(command.program.clone()).chain(command.args.clone()).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_shell_metacharacters_in_device_identifiers() {
        assert!(validate_process_token("serial", "abc-123_ok.1").is_ok());
        assert!(validate_process_token("serial", "abc;rm -rf /").is_err());
        assert!(validate_process_token("udid", "00008110-001C50E2026A801E").is_ok());
        assert!(validate_process_token("udid", "00008110 $(touch bad)").is_err());
    }

    #[test]
    fn rejects_non_whitelisted_programs() {
        assert!(validate_tool_program("/usr/local/bin/scrcpy", ProcessKind::Scrcpy).is_ok());
        assert!(validate_tool_program("/opt/homebrew/bin/iproxy", ProcessKind::Iproxy).is_ok());
        assert!(validate_tool_program("sh", ProcessKind::Scrcpy).is_err());
        assert!(validate_tool_program("scrcpy;rm", ProcessKind::Scrcpy).is_err());
    }

    #[test]
    fn builds_structured_scrcpy_args_without_shell_joining() {
        let command = build_android_scrcpy_command(
            "scrcpy".to_string(),
            "serial-01",
            &AndroidScrcpyOptions { max_size: Some(720), max_fps: Some(10), video_bit_rate: Some("2M".to_string()), no_audio: Some(true) },
        ).expect("scrcpy command");
        assert_eq!(command.program, "scrcpy");
        assert_eq!(command.args, ["--serial", "serial-01", "--max-size", "720", "--max-fps", "10", "--video-bit-rate", "2M", "--no-audio"]);
    }

    #[test]
    fn rejects_injected_scrcpy_args() {
        let command = build_android_scrcpy_command(
            "scrcpy".to_string(),
            "serial-01;open",
            &AndroidScrcpyOptions { max_size: None, max_fps: None, video_bit_rate: None, no_audio: None },
        );
        assert!(command.is_err());
    }
}
