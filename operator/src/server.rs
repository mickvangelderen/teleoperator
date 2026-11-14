use crate::diagnostics::Event;
use crate::tracking::Hub;
use crate::{
    protocol::{self, ControlDecoder, Message, Session},
    publication::Catalog,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Notify, Semaphore, mpsc, watch},
    time::timeout,
};
use webrtc::{
    api::APIBuilder,
    data_channel::RTCDataChannel,
    peer_connection::{
        configuration::RTCConfiguration,
        peer_connection_state::RTCPeerConnectionState,
        sdp::{sdp_type::RTCSdpType, session_description::RTCSessionDescription},
    },
};

struct Server {
    next_peer: AtomicU64,
    slots: Arc<Semaphore>,
    shutdown: watch::Receiver<bool>,
    hub: Arc<Hub>,
}

enum PeerEvent {
    Channel(Arc<RTCDataChannel>),
    Control(bytes::Bytes),
    Clock(u32, i64),
}

struct Peer {
    id: u64,
    channels: AtomicU8,
    hub: Arc<Hub>,
    close: Notify,
    events: mpsc::Sender<PeerEvent>,
    message_limit: usize,
}

impl Peer {
    fn attach(self: Arc<Self>, dc: Arc<RTCDataChannel>) {
        let label = dc.label().to_string();
        let control = label == "reliable";
        let bit = if control { 1 } else { 2 };
        let valid = matches!(label.as_str(), "reliable" | "unreliable")
            && dc.protocol() == "xrop"
            && dc.ordered() == control
            && dc.max_retransmits() == if control { None } else { Some(0) }
            && dc.max_packet_lifetime().is_none();
        if !valid || self.channels.fetch_or(bit, Ordering::SeqCst) & bit != 0 {
            log::warn!("Invalid or duplicate data channel: {label}");
            self.close.notify_one();
            return;
        }
        if self
            .events
            .try_send(PeerEvent::Channel(dc.clone()))
            .is_err()
        {
            self.close.notify_one();
            return;
        }
        dc.on_open(Box::new(move || {
            Box::pin(async move {
                log::info!("Data channel open: {label}");
            })
        }));
        let peer = self.clone();
        dc.on_close(Box::new(move || {
            let peer = peer.clone();
            Box::pin(async move {
                peer.close.notify_one();
            })
        }));
        let peer = self.clone();
        dc.on_error(Box::new(move |error| {
            let peer = peer.clone();
            Box::pin(async move {
                log::warn!("Data channel failed: {error}");
                peer.close.notify_one();
            })
        }));
        dc.on_message(Box::new(move |message| {
            let peer = self.clone();
            Box::pin(async move {
                let received_at = peer.hub.now();
                peer.hub.trace.record(
                    received_at,
                    Event::Packet {
                        peer: peer.id,
                        channel: if control { "reliable" } else { "unreliable" },
                        action: "receive",
                        data: message.data.clone(),
                        buffered_bytes: 0,
                    },
                );
                if !control {
                    if !message.is_string && message.data.len() == 5 && message.data[0] == 10 {
                        let id = u32::from_le_bytes(message.data[1..].try_into().unwrap());
                        let _ = peer.events.try_send(PeerEvent::Clock(id, received_at));
                    }
                    return;
                }
                if message.is_string
                    || message.data.len() > protocol::MAX_CONTROL * 2
                    || peer
                        .events
                        .try_send(PeerEvent::Control(message.data))
                        .is_err()
                {
                    peer.close.notify_one();
                }
            })
        }));
    }
}

impl Peer {
    async fn send(
        &self,
        dc: &RTCDataChannel,
        mut message: Vec<u8>,
        control: bool,
    ) -> Result<(), String> {
        let buffered = dc.buffered_amount().await;
        if control && buffered > protocol::MAX_CONTROL {
            return Err("Control backpressure limit".into());
        }
        if !control && message.first() == Some(&11) {
            message[13..21].copy_from_slice(&(self.hub.now() as u64).to_le_bytes());
        }
        let data = bytes::Bytes::from(message);
        let chunk_size = if control {
            self.message_limit
        } else {
            data.len()
        };
        for start in (0..data.len()).step_by(chunk_size) {
            let chunk = data.slice(start..(start + chunk_size).min(data.len()));
            self.hub.trace.record(
                self.hub.now(),
                Event::Packet {
                    peer: self.id,
                    channel: if control { "reliable" } else { "unreliable" },
                    action: "send",
                    data: chunk.clone(),
                    buffered_bytes: buffered,
                },
            );
            timeout(Duration::from_secs(2), dc.send(&chunk))
                .await
                .map_err(|_| "Data channel send timed out")?
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    async fn run(&self, mut incoming: mpsc::Receiver<PeerEvent>) -> Result<(), String> {
        let mut updates = self.hub.updates.subscribe();
        let mut control = None;
        let mut tracking: Option<Arc<RTCDataChannel>> = None;
        let mut decoder = ControlDecoder::default();
        let mut session: Option<(Catalog, Session)> = None;
        let mut pending_offer = None;
        let deadline = tokio::time::sleep(Duration::from_secs(12));
        tokio::pin!(deadline);
        loop {
            let next_due = session
                .as_ref()
                .and_then(|(_, s)| s.active.values().filter_map(|s| s.next_due).min());
            let wait = next_due.map_or(Duration::from_secs(3600), |due| {
                Duration::from_nanos(due.saturating_sub(self.hub.now() as u64))
            });
            tokio::select! {
                _ = tokio::time::sleep(wait), if next_due.is_some() => {},
                _ = &mut deadline, if session.is_none() || control.is_none() || tracking.is_none() => return Err("Protocol setup timed out".into()),
                event = incoming.recv() => match event.ok_or("Peer event channel closed")? {
                    PeerEvent::Clock(id, received_at) => {
                        if let (Some((_, state)), Some(dc)) = (&session, &tracking)
                            && state.negotiated && self.message_limit >= 21 && tracking_fits(dc.buffered_amount().await, 21) {
                            self.send(dc, protocol::clock_response(id, received_at as u64, 0), false).await?;
                        }
                    },
                    PeerEvent::Channel(dc) => { if dc.label() == "reliable" { control = Some(dc); } else { tracking = Some(dc); } },
                    PeerEvent::Control(bytes) => {
                        for message in decoder.feed(&bytes)? {
                            if let Some((_, state)) = session.as_mut() {
                                for reply in state.handle(message, self.hub.now())? {
                                    self.send(control.as_ref().ok_or("Missing control channel")?, protocol::encode(&reply), true).await?;
                                }
                            } else {
                                if pending_offer.is_some() || !matches!(message, Message::Offer(_)) { return Err("Version offer must be first".into()); }
                                pending_offer = Some(message);
                            }
                        }
                    },
                },
                _ = updates.changed() => {},
            }
            if pending_offer.is_some() && self.hub.initialized.load(Ordering::SeqCst) {
                let catalog = Catalog::snapshot(&self.hub);
                let mut state = Session::new(catalog.capabilities.clone());
                state.packet_limit = self.message_limit;
                for reply in state.handle(pending_offer.take().unwrap(), self.hub.now())? {
                    self.send(
                        control.as_ref().ok_or("Missing control channel")?,
                        protocol::encode(&reply),
                        true,
                    )
                    .await?;
                }
                if !state.negotiated {
                    return Err("No supported protocol version".into());
                }
                session = Some((catalog, state));
            }
            let Some((catalog, session)) = session.as_mut() else {
                continue;
            };
            let now = self.hub.now();
            let due: std::collections::HashSet<_> = session
                .active
                .iter()
                .filter_map(|(id, sub)| sub.due(now as u64).then_some(*id))
                .collect();
            // Advance even without a sample or an open channel, so missed slots cannot spin.
            for sub in session.active.values_mut() {
                if sub.next_due.is_some_and(|t| t <= now as u64) {
                    sub.advance(now as u64)?;
                }
            }
            if catalog.changed(&self.hub) {
                return Err("Device capabilities changed; reconnect".into());
            }
            let Some(dc) = tracking.as_ref() else {
                continue;
            };
            if dc.ready_state()
                != webrtc::data_channel::data_channel_state::RTCDataChannelState::Open
            {
                continue;
            }
            if !self.hub.available.load(Ordering::SeqCst) {
                for id in session.active.keys().copied().collect::<Vec<_>>() {
                    for reply in session.end(id, "Device acquisition stopped") {
                        self.send(control.as_ref().unwrap(), protocol::encode(&reply), true)
                            .await?;
                    }
                }
                continue;
            }
            let sample = self.hub.latest.lock().unwrap().clone();
            let Some(sample) = sample else {
                continue;
            };
            // Recenter keeps the selected space; wait for an acquisition in its new origin.
            if sample.reference_version != *self.hub.reference_version.lock().unwrap() {
                continue;
            }
            // Acquisition can advance after due-slot bookkeeping; validate the copied sample now.
            let sampled_at = self.hub.now();
            for subscription in session.active.values_mut() {
                if !due.contains(&subscription.request.id) {
                    continue;
                }
                let Some(timestamp) = subscription.timestamp(sample.acquired_at, sampled_at) else {
                    continue;
                };
                // Skip superseded acquisitions under congestion; never retain a tracking backlog.
                let values = subscription
                    .request
                    .samples
                    .iter()
                    .map(|s| catalog.value(s.descriptor, &sample))
                    .collect::<Vec<_>>();
                let packet = protocol::tracking(
                    &catalog.capabilities,
                    &subscription.request,
                    timestamp,
                    catalog.predicted_for(&subscription.request, &sample, &values),
                    &values,
                );
                if !subscription.should_publish(&packet) {
                    continue;
                }
                let reliable = subscription.request.delivery == 2;
                let channel = if reliable {
                    control.as_ref().unwrap()
                } else {
                    dc
                };
                let framed = if reliable {
                    protocol::encode(&Message::Publication(packet.clone()))
                } else {
                    [&[9], packet.as_slice()].concat()
                };
                if !reliable && !tracking_fits(channel.buffered_amount().await, framed.len()) {
                    continue;
                }
                self.send(channel, framed, reliable).await?;
                subscription.published(&packet);
            }
        }
    }
}

fn tracking_fits(buffered: usize, packet: usize) -> bool {
    buffered.saturating_add(packet) <= protocol::MAX_PACKET
}

type HttpError = (StatusCode, String);

async fn offer(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Json(offer): Json<RTCSessionDescription>,
) -> Result<Json<RTCSessionDescription>, HttpError> {
    // Browser access goes through the Viewer proxy; reject direct cross-origin requests.
    if headers.contains_key("origin") {
        return Err((
            StatusCode::FORBIDDEN,
            "Use the Viewer signaling proxy".into(),
        ));
    }
    if offer.sdp_type != RTCSdpType::Offer {
        return Err((StatusCode::BAD_REQUEST, "Expected an SDP offer".into()));
    }
    let permit = server.slots.clone().try_acquire_owned().map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "All four peer slots are in use".into(),
        )
    })?;
    let parsed = offer
        .unmarshal()
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let remote_limit = parsed
        .media_descriptions
        .iter()
        .find(|m| m.media_name.media == "application")
        .and_then(|m| m.attribute("max-message-size").flatten())
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(65_536);
    let message_limit = if remote_limit == 0 {
        protocol::MAX_PACKET
    } else {
        (remote_limit as usize).min(protocol::MAX_PACKET)
    };
    let (events, incoming) = mpsc::channel(32);
    let peer = Arc::new(Peer {
        id: server.next_peer.fetch_add(1, Ordering::SeqCst),
        channels: AtomicU8::new(0),
        hub: server.hub.clone(),
        close: Notify::new(),
        events,
        message_limit,
    });
    // 0.17 retains remote DCEP reliability settings and avoids the 0.21 negotiated-channel race.
    let pc = Arc::new(
        APIBuilder::new()
            .build()
            .new_peer_connection(RTCConfiguration::default())
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
    );
    let channel_peer = peer.clone();
    pc.on_data_channel(Box::new(move |dc| {
        let peer = channel_peer.clone();
        Box::pin(async move {
            peer.attach(dc);
        })
    }));
    let state_peer = peer.clone();
    pc.on_peer_connection_state_change(Box::new(move |state| {
        let peer = state_peer.clone();
        Box::pin(async move {
            log::info!("WebRTC state: {state}");
            if matches!(
                state,
                RTCPeerConnectionState::Failed
                    | RTCPeerConnectionState::Closed
                    | RTCPeerConnectionState::Disconnected
            ) {
                peer.close.notify_one();
            }
        })
    }));

    let live_pc = pc.clone();
    let live_peer = peer.clone();
    let mut shutdown = server.shutdown.clone();
    tokio::spawn(async move {
        let _permit = permit;
        tokio::select! {
            _ = live_peer.close.notified() => {},
            result = live_peer.run(incoming) => if let Err(error) = result { log::warn!("Peer session ended: {error}"); },
            _ = shutdown.wait_for(|stopped| *stopped) => {},
        }
        let _ = live_pc.close().await;
    });

    let negotiation = async {
        pc.set_remote_description(offer).await?;
        let answer = pc.create_answer(None).await?;
        let mut gathered = pc.gathering_complete_promise().await;
        pc.set_local_description(answer).await?;
        gathered.recv().await;
        pc.local_description()
            .await
            .ok_or(webrtc::error::Error::ErrConnectionClosed)
    };
    match timeout(Duration::from_secs(8), negotiation).await {
        Ok(Ok(answer)) => Ok(Json(answer)),
        outcome => {
            peer.close.notify_one();
            let reason = match outcome {
                Ok(Err(e)) => e.to_string(),
                _ => "ICE gathering timed out".into(),
            };
            Err((StatusCode::BAD_REQUEST, reason))
        }
    }
}

pub async fn serve(
    listener: TcpListener,
    shutdown: watch::Receiver<bool>,
    hub: Arc<Hub>,
    recordings: std::path::PathBuf,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|e| format!("Diagnostic recording randomness: {e}"))?;
    let low = u64::from_le_bytes(random[..8].try_into().unwrap());
    let high = u64::from_le_bytes(random[8..].try_into().unwrap());
    if low == 0 && high == 0 {
        return Err("Invalid zero diagnostic recording ID".into());
    }
    if let Err(error) = hub
        .trace
        .start(&recordings, &format!("{high:016x}{low:016x}"), hub.source)
    {
        log::error!("Could not start diagnostic recording: {error}");
    }
    let server = Arc::new(Server {
        next_peer: AtomicU64::new(1),
        hub,
        slots: Arc::new(Semaphore::new(4)),
        shutdown: shutdown.clone(),
    });
    let router = Router::new().route("/health", get(|State(server): State<Arc<Server>>| async move { Json(serde_json::json!({"application": "XR Operator", "tracking": server.hub.available.load(Ordering::SeqCst), "source": server.hub.source, "prediction_horizon_ms": crate::tracking::PREDICTION_NS as f64 / 1e6})) }))
        .route("/offer", post(offer)).layer(DefaultBodyLimit::max(65_536))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(10)))
        .with_state(server.clone());
    log::info!("WebRTC signaling listening on {}", listener.local_addr()?);
    let mut shutdown = shutdown;
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = shutdown.wait_for(|stopped| *stopped).await;
        })
        .await?;
    // Wait for peer close tasks before Android tears down the runtime.
    let _ = timeout(Duration::from_secs(3), server.slots.acquire_many(4)).await;
    server.hub.trace.stop();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tracking_backpressure_counts_the_new_packet_without_overflow() {
        assert!(tracking_fits(protocol::MAX_PACKET - 20, 20));
        assert!(!tracking_fits(protocol::MAX_PACKET - 19, 20));
        assert!(!tracking_fits(protocol::MAX_PACKET, 20));
        assert!(!tracking_fits(usize::MAX, 20));
    }
}
