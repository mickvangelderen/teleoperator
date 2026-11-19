use mdns_sd::{IfKind, ServiceDaemon, ServiceInfo};
use std::net::{IpAddr, SocketAddr};

/// Appends the `.local.` suffix to a DNS host label.
pub fn local_hostname(label: &str) -> String {
    format!("{label}.local.")
}

/// Publishes the bound endpoint under the caller's DNS-SD service type, instance name, and target hostname.
/// Loopback listeners are discoverable on this host only.
/// Call `shutdown` when serving ends.
pub fn advertise(
    bound: SocketAddr,
    service_type: &str,
    instance_name: &str,
    host: &str,
) -> mdns_sd::Result<ServiceDaemon> {
    let service = service_info(bound, service_type, instance_name, host)?;
    let daemon = ServiceDaemon::new()?;
    if let Err(error) = restrict_interfaces(&daemon, bound).and_then(|()| daemon.register(service))
    {
        let _ = daemon.shutdown();
        return Err(error);
    }
    Ok(daemon)
}

/// Keep announcements on the links where the advertised address has meaning.
/// A peer on the LAN would interpret `127.0.0.1` or `::1` as its own machine.
/// For a bind like `[fe80::1%3]:8080`, the address record carries `fe80::1`
/// without the scope ID. Announce only on interface 3 because the same IP
/// can identify a different machine on another link.
fn restrict_interfaces(daemon: &ServiceDaemon, bound: SocketAddr) -> mdns_sd::Result<()> {
    let allowed = match bound {
        addr if addr.ip().to_canonical().is_loopback() => {
            vec![IfKind::LoopbackV4, IfKind::LoopbackV6]
        }
        SocketAddr::V6(v6) if v6.scope_id() != 0 => vec![IfKind::IndexV6(v6.scope_id())],
        _ => return Ok(()),
    };
    // Enabling interfaces is additive, and mdns-sd starts with all eligible interfaces enabled.
    daemon.disable_interface(IfKind::All)?;
    daemon.enable_interface(allowed)
}

fn service_info(
    bound: SocketAddr,
    service_type: &str,
    instance_name: &str,
    host: &str,
) -> mdns_sd::Result<ServiceInfo> {
    let ip = bound.ip().to_canonical();
    let (addresses, auto_family) = advertised_addresses(&ip);
    let mut service = ServiceInfo::new(
        service_type,
        instance_name,
        host,
        addresses,
        bound.port(),
        None,
    )?;
    if let Some(family) = auto_family {
        service = service.enable_addr_auto();
        service.set_interfaces(vec![family]);
    }
    Ok(service)
}

/// mdns-sd 0.22 takes constructor addresses literally. For a wildcard, let it
/// discover addresses in the bound family. A bare `[::]` address carries no
/// information about whether the socket also accepts IPv4.
fn advertised_addresses(ip: &IpAddr) -> (&[IpAddr], Option<IfKind>) {
    match ip {
        IpAddr::V4(v4) if v4.is_unspecified() => (&[], Some(IfKind::IPv4)),
        IpAddr::V6(v6) if v6.is_unspecified() => (&[], Some(IfKind::IPv6)),
        _ => (std::slice::from_ref(ip), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concrete_bind_advertises_only_its_ip_and_port() {
        let bound: SocketAddr = "192.0.2.40:28148".parse().unwrap();
        let info =
            service_info(bound, "_http._tcp.local.", "website", "workstation.local.").unwrap();
        assert_eq!(info.get_type(), "_http._tcp.local.");
        assert_eq!(info.get_hostname(), "workstation.local.");
        assert_eq!(info.get_port(), bound.port());
        assert_eq!(
            info.get_addresses().iter().copied().collect::<Vec<_>>(),
            [bound.ip()]
        );
        assert!(!info.is_addr_auto());
    }

    #[test]
    fn wildcard_binds_select_their_own_family() {
        assert!(matches!(
            advertised_addresses(&"0.0.0.0".parse().unwrap()),
            ([], Some(IfKind::IPv4))
        ));
        assert!(matches!(
            advertised_addresses(&"::".parse().unwrap()),
            ([], Some(IfKind::IPv6))
        ));
    }
}
