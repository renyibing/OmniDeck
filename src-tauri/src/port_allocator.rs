use serde::Serialize;
use std::{collections::HashMap, net::TcpListener};

use crate::device_process::validate_process_token;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortAllocation {
    pub device_id: String,
    pub udid: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub reused: bool,
}

#[derive(Debug)]
pub struct PortAllocator {
    start: u16,
    end: u16,
    assignments: HashMap<String, PortAssignment>,
}

#[derive(Debug, Clone)]
struct PortAssignment {
    device_id: String,
    local_port: u16,
    remote_port: u16,
}

impl Default for PortAllocator {
    fn default() -> Self {
        Self::new(8100, 8199)
    }
}

impl PortAllocator {
    pub fn new(start: u16, end: u16) -> Self {
        Self { start, end, assignments: HashMap::new() }
    }

    pub fn allocate_ios_wda_port(&mut self, device_id: &str, udid: &str) -> Result<PortAllocation, String> {
        self.allocate_with_probe(device_id, udid, 8100, port_available)
    }

    pub fn release_udid(&mut self, udid: &str) -> Option<u16> {
        self.assignments.remove(udid).map(|assignment| assignment.local_port)
    }

    pub fn current(&self, udid: &str) -> Option<PortAllocation> {
        self.assignments.get(udid).map(|assignment| PortAllocation {
            device_id: assignment.device_id.clone(),
            udid: udid.to_string(),
            local_port: assignment.local_port,
            remote_port: assignment.remote_port,
            reused: true,
        })
    }

    fn allocate_with_probe<F>(&mut self, device_id: &str, udid: &str, remote_port: u16, is_available: F) -> Result<PortAllocation, String>
    where
        F: Fn(u16) -> bool,
    {
        validate_process_token("deviceId", device_id)?;
        validate_process_token("udid", udid)?;
        if let Some(existing) = self.current(udid) {
            return Ok(existing);
        }
        for port in self.start..=self.end {
            if self.assignments.values().any(|assignment| assignment.local_port == port) {
                continue;
            }
            if !is_available(port) {
                continue;
            }
            self.assignments.insert(udid.to_string(), PortAssignment { device_id: device_id.to_string(), local_port: port, remote_port });
            return Ok(PortAllocation { device_id: device_id.to_string(), udid: udid.to_string(), local_port: port, remote_port, reused: false });
        }
        Err(format!("No available iOS WDA local ports in {}-{}", self.start, self.end))
    }
}

fn port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_stable_port_for_same_udid() {
        let mut allocator = PortAllocator::new(8100, 8105);
        let first = allocator.allocate_with_probe("device-03", "udid-1", 8100, |_| true).expect("first");
        let second = allocator.allocate_with_probe("device-03", "udid-1", 8100, |_| true).expect("second");
        assert_eq!(first.local_port, 8100);
        assert_eq!(second.local_port, 8100);
        assert!(second.reused);
    }

    #[test]
    fn avoids_reusing_ports_for_different_udids() {
        let mut allocator = PortAllocator::new(8100, 8105);
        let first = allocator.allocate_with_probe("device-03", "udid-1", 8100, |_| true).expect("first");
        let second = allocator.allocate_with_probe("device-07", "udid-2", 8100, |_| true).expect("second");
        assert_ne!(first.local_port, second.local_port);
        assert_eq!(second.local_port, 8101);
    }

    #[test]
    fn skips_occupied_ports() {
        let mut allocator = PortAllocator::new(8100, 8105);
        let allocated = allocator.allocate_with_probe("device-03", "udid-1", 8100, |port| port != 8100).expect("allocated");
        assert_eq!(allocated.local_port, 8101);
    }

    #[test]
    fn release_allows_port_reuse() {
        let mut allocator = PortAllocator::new(8100, 8105);
        let first = allocator.allocate_with_probe("device-03", "udid-1", 8100, |_| true).expect("first");
        assert_eq!(allocator.release_udid("udid-1"), Some(first.local_port));
        let second = allocator.allocate_with_probe("device-07", "udid-2", 8100, |_| true).expect("second");
        assert_eq!(second.local_port, first.local_port);
    }
}
