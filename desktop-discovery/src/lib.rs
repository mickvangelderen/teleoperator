use mdns_sd::{IfKind, IfPredicate, ServiceDaemon, ServiceInfo};
use socket2::SockRef;
use std::{
    error::Error,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::net::TcpListener;

const SERVICE: &str = "_teleoperator._tcp.local.";

/// Hold this for the lifetime of the signaling listener.
pub struct Advertisement(ServiceDaemon);

impl Drop for Advertisement {
    fn drop(&mut self) {
        // Shutdown sends DNS-SD goodbye records before the worker exits.
        if let Ok(done) = self.0.shutdown() {
            let _ = done.recv_timeout(Duration::from_secs(1));
        }
    }
}

fn matches_listener(address: SocketAddr, dual_stack: bool, ip: IpAddr, index: Option<u32>) -> bool {
    let bound = address.ip().to_canonical();
    if ip.is_loopback() || ip.is_unspecified() {
        return false;
    }
    if let SocketAddr::V6(v6) = address {
        if v6.scope_id() != 0 && Some(v6.scope_id()) != index {
            return false;
        }
    }
    if bound.is_unspecified() {
        bound.is_ipv4() == ip.is_ipv4() || dual_stack
    } else {
        bound == ip
    }
}

fn start(listener: &TcpListener, name: &str) -> Result<Option<Advertisement>, Box<dyn Error>> {
    let address = listener.local_addr()?;
    if address.ip().to_canonical().is_loopback() {
        return Ok(None);
    }
    let dual_stack =
        address.is_ipv6() && address.ip().is_unspecified() && !SockRef::from(listener).only_v6()?;
    let eligible = move |intf: &if_addrs::Interface| {
        !intf.is_loopback() && matches_listener(address, dual_stack, intf.ip(), intf.index)
    };
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for intf in interfaces.iter().filter(|i| i.is_oper_up() && eligible(i)) {
            // IPv6 link-local literals need the client's interface scope.
            if !matches!(intf.ip(), IpAddr::V6(ip) if ip.is_unicast_link_local()) {
                eprintln!(
                    "LAN signaling: http://{}",
                    SocketAddr::new(intf.ip(), address.port())
                );
            }
        }
    }

    let host = hostname::get()?;
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
    let target = format!("teleoperator-{label}-{}.local.", address.port());
    let info =
        ServiceInfo::new(SERVICE, &instance, &target, (), address.port(), None)?.enable_addr_auto();
    let publisher = Advertisement(ServiceDaemon::new()?);
    publisher
        .0
        .disable_interface(IfKind::Predicate(IfPredicate::new(move |i| !eligible(i))))?;
    publisher.0.register(info)?;
    eprintln!("DNS-SD: {instance} ({SERVICE})");
    Ok(Some(publisher))
}

pub fn advertise(listener: &TcpListener, name: &str) -> Option<Advertisement> {
    start(listener, name).unwrap_or_else(|error| {
        eprintln!("DNS-SD advertisement unavailable: {error}");
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_addresses_must_be_reachable_through_the_bound_listener() {
        let supports = |bind: &str, dual, ip: &str, index| {
            matches_listener(
                bind.parse().unwrap(),
                dual,
                ip.parse().unwrap(),
                Some(index),
            )
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
