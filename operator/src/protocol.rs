use crate::{streams::Stream, tracking::Hub};
use flatbuffers::{FlatBufferBuilder, UnionWIPOffset, WIPOffset};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Weak};

#[allow(unused_imports, dead_code, clippy::all, mismatched_lifetime_syntaxes)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/wire_generated.rs"));
}
pub use generated::xr_operator::wire;

pub const MAX_PACKET: usize = 65_536;
const MAX_REQUESTS: usize = 65_536;

pub struct Connection {
    pub hub: Arc<Hub>,
    pub streams: Vec<Stream>,
    pub known_subscriptions: HashMap<u64, Weak<crate::tracking::Subscription>>,
    pub advertised: bool,
    pub advertised_body: bool,
    pub resumed_at: i64,
    session: wire::SessionId,
    pub negotiated: bool,
    rejected: bool,
    requests: HashSet<u64>,
    probes: HashSet<u64>,
}

pub(crate) fn finish(
    mut builder: FlatBufferBuilder<'_>,
    kind: wire::Message,
    message: WIPOffset<UnionWIPOffset>,
) -> Vec<u8> {
    let packet = wire::Packet::create(
        &mut builder,
        &wire::PacketArgs {
            message_type: kind,
            message: Some(message),
        },
    );
    wire::finish_packet_buffer(&mut builder, packet);
    builder.finished_data().to_vec()
}

pub fn packet(data: &[u8]) -> Result<wire::Packet<'_>, &'static str> {
    if data.len() < 8 || data.len() > MAX_PACKET || !wire::packet_buffer_has_identifier(data) {
        return Err("Invalid packet size or XROP identifier");
    }
    wire::root_as_packet(data).map_err(|_| "Malformed FlatBuffer")
}

impl Connection {
    pub fn new(session: wire::SessionId) -> Self {
        Self::with_hub(session, Hub::new("none"))
    }
    pub fn with_hub(session: wire::SessionId, hub: Arc<Hub>) -> Self {
        Self {
            hub,
            streams: Vec::new(),
            known_subscriptions: HashMap::new(),
            advertised: false,
            advertised_body: false,
            resumed_at: 0,
            session,
            negotiated: false,
            rejected: false,
            requests: HashSet::new(),
            probes: HashSet::new(),
        }
    }

    fn request(&mut self, id: u64) -> Result<(), &'static str> {
        if id == 0 || self.requests.len() >= MAX_REQUESTS || !self.requests.insert(id) {
            return Err("Invalid, reused, or exhausted request ID");
        }
        Ok(())
    }

    pub fn control(&mut self, data: &[u8]) -> Result<Vec<Vec<u8>>, &'static str> {
        if self.rejected {
            return Err("Negotiation was rejected");
        }
        let packet = packet(data)?;
        if let Some(hello) = packet.message_as_client_hello() {
            if self.negotiated {
                return Err("Hello already completed");
            }
            self.request(hello.request_id())?;
            let versions = hello.supported_versions();
            let unique: HashSet<_> = versions.iter().collect();
            if versions.is_empty()
                || versions.len() > 32
                || unique.len() != versions.len()
                || unique.contains(&0)
            {
                return Err("Invalid supported versions");
            }
            let selected = if unique.contains(&1) { 1 } else { 0 };
            let mut builder = FlatBufferBuilder::new();
            let supported = builder.create_vector(&[1u32]);
            let reason =
                (selected == 0).then(|| builder.create_string("No common protocol version"));
            let message = wire::ServerHello::create(
                &mut builder,
                &wire::ServerHelloArgs {
                    request_id: hello.request_id(),
                    selected_version: selected,
                    supported_versions: Some(supported),
                    reason,
                    server_session_id: (selected != 0).then_some(&self.session),
                },
            );
            let response = finish(
                builder,
                wire::Message::ServerHello,
                message.as_union_value(),
            );
            self.negotiated = selected != 0;
            self.rejected = selected == 0;
            log::info!(
                "ClientHello request={} selected_version={selected}",
                hello.request_id()
            );
            Ok(if self.negotiated {
                self.advertised = self.hub.available.load(std::sync::atomic::Ordering::SeqCst);
                self.advertised_body = self.hub.skeleton.lock().unwrap().is_some();
                vec![response, crate::streams::capabilities(&self.hub)]
            } else {
                vec![response]
            })
        } else {
            let id = match packet.message_type() {
                wire::Message::Subscribe => packet.message_as_subscribe().unwrap().request_id(),
                wire::Message::UpdatePublication => {
                    packet.message_as_update_publication().unwrap().request_id()
                }
                wire::Message::Unsubscribe => packet.message_as_unsubscribe().unwrap().request_id(),
                _ => return Err("Unexpected message on control channel"),
            };
            self.request(id)?;
            if self.negotiated {
                return Ok(self.request_stream(packet, id));
            }
            let (code, reason) = if !self.negotiated {
                (
                    wire::RejectionCode::InvalidRequest,
                    "Complete ClientHello before requesting streams",
                )
            } else if packet.message_type() == wire::Message::Subscribe {
                (
                    wire::RejectionCode::UnsupportedCapability,
                    "OpenXR acquisition is not implemented yet",
                )
            } else {
                (wire::RejectionCode::UnknownStream, "No such stream")
            };
            let mut builder = FlatBufferBuilder::new();
            let reason = builder.create_string(reason);
            let alternatives = builder.create_vector::<WIPOffset<wire::Alternative<'_>>>(&[]);
            let message = wire::RequestRejected::create(
                &mut builder,
                &wire::RequestRejectedArgs {
                    request_id: id,
                    code,
                    reason: Some(reason),
                    alternatives: Some(alternatives),
                },
            );
            Ok(vec![finish(
                builder,
                wire::Message::RequestRejected,
                message.as_union_value(),
            )])
        }
    }

    pub fn tracking(
        &mut self,
        data: &[u8],
        received_at: i64,
        sent_at: impl FnOnce() -> i64,
    ) -> Option<Vec<u8>> {
        if !self.negotiated {
            return None;
        }
        let packet = packet(data).ok()?;
        let probe = packet.message_as_clock_probe()?;
        let id = probe.request_id();
        if id == 0 || self.probes.len() >= MAX_REQUESTS || !self.probes.insert(id) {
            return None;
        }
        let mut builder = FlatBufferBuilder::new();
        let message = wire::ClockReply::create(
            &mut builder,
            &wire::ClockReplyArgs {
                request_id: id,
                received_at,
                sent_at: sent_at(),
            },
        );
        Some(finish(
            builder,
            wire::Message::ClockReply,
            message.as_union_value(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hello(id: u64, versions: &[u32]) -> Vec<u8> {
        let mut b = FlatBufferBuilder::new();
        let versions = b.create_vector(versions);
        let m = wire::ClientHello::create(
            &mut b,
            &wire::ClientHelloArgs {
                request_id: id,
                supported_versions: Some(versions),
            },
        );
        finish(b, wire::Message::ClientHello, m.as_union_value())
    }
    fn connection() -> Connection {
        Connection::new(wire::SessionId::new(11, 22))
    }
    #[test]
    fn negotiation_and_discovery() {
        let mut c = connection();
        let replies = c.control(&hello(u64::MAX, &[8, 1, 2])).unwrap();
        assert_eq!(replies.len(), 2);
        let h = packet(&replies[0])
            .unwrap()
            .message_as_server_hello()
            .unwrap();
        assert_eq!(h.request_id(), u64::MAX);
        assert_eq!(h.selected_version(), 1);
        assert_eq!(h.server_session_id().unwrap().high(), 22);
        let caps = packet(&replies[1])
            .unwrap()
            .message_as_capabilities()
            .unwrap();
        assert!(caps.pose().is_none() && caps.controller().is_none() && caps.body().is_none());
        assert!(c.control(&hello(2, &[1])).is_err());
    }
    #[test]
    fn incompatible_and_invalid_hellos() {
        let mut c = connection();
        let replies = c.control(&hello(1, &[2])).unwrap();
        assert_eq!(replies.len(), 1);
        let h = packet(&replies[0])
            .unwrap()
            .message_as_server_hello()
            .unwrap();
        assert_eq!(h.selected_version(), 0);
        assert!(h.server_session_id().is_none());
        assert!(!h.reason().unwrap().is_empty());
        assert!(c.control(&hello(2, &[1])).is_err());
        for versions in [&[][..], &[1, 1], &[0, 1]] {
            assert!(connection().control(&hello(1, versions)).is_err());
        }
        assert!(connection().control(&hello(0, &[1])).is_err());
    }
    #[test]
    fn malformed_packets_and_channel_direction() {
        let data = hello(1, &[1]);
        for end in 0..data.len() {
            assert!(connection().control(&data[..end]).is_err());
        }
        let mut corrupt = data.clone();
        corrupt[4] = 0;
        assert!(connection().control(&corrupt).is_err());
        assert!(
            connection()
                .control(&crate::streams::capabilities(&Hub::new("none")))
                .is_err()
        );
        assert!(connection().tracking(&data, 0, || 1).is_none());
    }
    #[test]
    fn clock_requires_hello_and_echoes_once() {
        let mut b = FlatBufferBuilder::new();
        let m = wire::ClockProbe::create(
            &mut b,
            &wire::ClockProbeArgs {
                request_id: u64::MAX,
            },
        );
        let probe = finish(b, wire::Message::ClockProbe, m.as_union_value());
        let mut c = connection();
        assert!(c.tracking(&probe, 0, || 1).is_none());
        c.control(&hello(1, &[1])).unwrap();
        let response = c.tracking(&probe, 0, || 9).unwrap();
        let reply = packet(&response).unwrap().message_as_clock_reply().unwrap();
        assert_eq!(reply.request_id(), u64::MAX);
        assert_eq!((reply.received_at(), reply.sent_at()), (0, 9));
        assert!(c.tracking(&probe, 1, || 2).is_none());
        assert!(c.control(&probe).is_err());
    }
}
