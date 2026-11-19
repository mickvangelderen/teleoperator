use if_addrs::Interface;
use mdns_sd::{IfKind, IfPredicate, ServiceDaemon, ServiceInfo};
use socket2::SockRef;
use std::{
    error::Error,
    ffi::OsStr,
    io,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::net::TcpListener;

const SERVICE: &str = "_teleoperator._tcp.local.";

/// Hold this for the lifetime of the signaling listener.
pub struct Advertisement(ServiceDaemon);

pub fn advertise(listener: &TcpListener, name: &str) -> Option<Advertisement> {
    start(listener, name).unwrap_or_else(|error| {
        eprintln!("DNS-SD advertisement unavailable: {error}");
        None
    })
}

fn start(listener: &TcpListener, name: &str) -> Result<Option<Advertisement>, Box<dyn Error>> {
    let Some(binding) = LanBinding::from_listener(listener)? else {
        return Ok(None);
    };
    print_lan_addresses(&binding);
    let host = hostname::get()?;
    let (instance, record) = build_service_record(name, &host, binding.address.port())?;
    let publisher = register_service(record, binding)?;
    eprintln!("DNS-SD: {instance} ({SERVICE})");
    Ok(Some(publisher))
}

struct LanBinding {
    address: SocketAddr,
    dual_stack: bool,
}

impl LanBinding {
    fn from_listener(listener: &TcpListener) -> io::Result<Option<Self>> {
        let address = listener.local_addr()?;
        if address.ip().to_canonical().is_loopback() {
            return Ok(None);
        }
        let dual_stack = address.is_ipv6()
            && address.ip().is_unspecified()
            && !SockRef::from(listener).only_v6()?;
        Ok(Some(Self {
            address,
            dual_stack,
        }))
    }

    fn includes(&self, interface: &Interface) -> bool {
        !interface.is_loopback() && self.matches_address(interface.ip(), interface.index)
    }

    fn matches_address(&self, ip: IpAddr, index: Option<u32>) -> bool {
        let bound = self.address.ip().to_canonical();
        if ip.is_loopback() || ip.is_unspecified() {
            return false;
        }
        if let SocketAddr::V6(v6) = self.address {
            if v6.scope_id() != 0 && Some(v6.scope_id()) != index {
                return false;
            }
        }
        if bound.is_unspecified() {
            bound.is_ipv4() == ip.is_ipv4() || self.dual_stack
        } else {
            bound == ip
        }
    }
}

fn print_lan_addresses(binding: &LanBinding) {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return;
    };
    for interface in interfaces
        .iter()
        .filter(|i| i.is_oper_up() && binding.includes(i))
    {
        let ip = interface.ip();
        // IPv6 link-local literals need the client's interface scope.
        if !matches!(ip, IpAddr::V6(ip) if ip.is_unicast_link_local()) {
            eprintln!(
                "LAN signaling: http://{}",
                SocketAddr::new(ip, binding.address.port())
            );
        }
    }
}

fn build_service_record(
    name: &str,
    host: &OsStr,
    port: u16,
) -> mdns_sd::Result<(String, ServiceInfo)> {
    let label: String = host
        .to_string_lossy()
        .split('.')
        .next()
        .unwrap_or("")
        .chars()
        .take(36)
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let label = label.trim_matches('-');
    let label = if label.is_empty() { "desktop" } else { label };
    let instance = format!("{name} on {label}");
    // A host record specific to this listener can represent an explicit single-address bind.
    let target = format!("teleoperator-{label}-{port}.local.");
    let info = ServiceInfo::new(SERVICE, &instance, &target, (), port, None)?.enable_addr_auto();
    Ok((instance, info))
}

fn register_service(record: ServiceInfo, binding: LanBinding) -> mdns_sd::Result<Advertisement> {
    let publisher = Advertisement(ServiceDaemon::new()?);
    let excluded = IfPredicate::new(move |interface| !binding.includes(interface));
    publisher.0.disable_interface(IfKind::Predicate(excluded))?;
    publisher.0.register(record)?;
    Ok(publisher)
}

impl Drop for Advertisement {
    fn drop(&mut self) {
        // Shutdown sends DNS-SD goodbye records before the worker exits.
        if let Ok(done) = self.0.shutdown() {
            let _ = done.recv_timeout(Duration::from_secs(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_addresses_must_be_reachable_through_the_bound_listener() {
        let supports = |bind: &str, dual, ip: &str, index| {
            let binding = LanBinding {
                address: bind.parse().unwrap(),
                dual_stack: dual,
            };
            binding.matches_address(ip.parse().unwrap(), Some(index))
        };
        assert!(supports("0.0.0.0:80", false, "192.0.2.1", 2));
        assert!(!supports("0.0.0.0:80", false, "127.0.0.1", 1));
        assert!(!supports("0.0.0.0:80", false, "2001:db8::1", 2));
        assert!(!supports("192.0.2.1:80", false, "192.0.2.2", 2));
        assert!(!supports("[::]:80", false, "192.0.2.1", 2));
        assert!(supports("[::]:80", true, "192.0.2.1", 2));
        assert!(!supports("[::]:80", true, "::1", 1));
        assert!(supports("[fe80::1%3]:80", false, "fe80::1", 3));
        assert!(!supports("[fe80::1%3]:80", false, "fe80::1", 4));
    }
}
