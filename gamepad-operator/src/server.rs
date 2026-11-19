//! WebRTC transport adapted from android-phone-operator at 842f759.
//! Independent transport; no phone or XR operator dependency.
use crate::input::{Hub, RATE, Source};
use crate::protocol::{self, Message, Session};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use rtc::peer_connection::configuration::setting_engine::SctpMaxMessageSize;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Notify, Semaphore, mpsc, watch},
    time::timeout,
};
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent},
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceGatheringState,
        RTCPeerConnectionState, RTCSdpType, RTCSessionDescription, SettingEngineBuilder,
    },
};

struct Server {
    slots: Arc<Semaphore>,
    shutdown: watch::Receiver<bool>,
    source: Arc<Source>,
}

enum UnreliableEvent {
    Clock(u32, i64),
    Acknowledgment(bytes::Bytes),
}

#[derive(Clone, Default)]
struct Channels {
    // Protocol channel values are 1 (unreliable) and 2 (reliable).
    connections: [Option<Arc<dyn DataChannel>>; 2],
    open: [bool; 2],
}
impl Channels {
    fn get(&self, channel: u8) -> Option<&Arc<dyn DataChannel>> {
        let index = channel as usize - 1;
        self.open[index]
            .then_some(self.connections[index].as_ref())
            .flatten()
    }
    fn ready(&self) -> [bool; 2] {
        std::array::from_fn(|i| self.open[i] && self.connections[i].is_some())
    }
}

struct PeerInbox {
    controls: mpsc::Receiver<bytes::Bytes>,
    unreliable: mpsc::Receiver<UnreliableEvent>,
    channels: watch::Receiver<Channels>,
}
struct Peer {
    claimed_channels: AtomicU8,
    hub: Arc<Hub>,
    close: Notify,
    // Separate bounded paths: reliable controls wait for capacity in receive
    // order; unreliable traffic is dropped on saturation. Channel readiness is
    // coalesced state and cannot be displaced by either traffic class.
    controls: mpsc::Sender<bytes::Bytes>,
    unreliable: mpsc::Sender<UnreliableEvent>,
    channel_state: watch::Sender<Channels>,
    message_limit: usize,
}
impl Peer {
    fn new(hub: Arc<Hub>, message_limit: usize) -> (Arc<Self>, PeerInbox) {
        let (controls, control_rx) = mpsc::channel(32);
        let (unreliable, unreliable_rx) = mpsc::channel(32);
        let (channel_state, channels) = watch::channel(Channels::default());
        (
            Arc::new(Self {
                claimed_channels: AtomicU8::new(0),
                hub,
                close: Notify::new(),
                controls,
                unreliable,
                channel_state,
                message_limit,
            }),
            PeerInbox {
                controls: control_rx,
                unreliable: unreliable_rx,
                channels,
            },
        )
    }
    async fn enqueue_control(&self, bytes: bytes::Bytes) -> Result<(), String> {
        if bytes.len() > protocol::MAX_CLIENT_MESSAGE {
            return Err("Control decoding size limit".into());
        }
        self.controls
            .send(bytes)
            .await
            .map_err(|_| "Peer control receiver closed".into())
    }
}
fn next_publication(session: &Session, ready: [bool; 2], hub: &Hub) -> Option<u64> {
    session
        .active
        .values()
        .filter(|s| ready[s.request.channel as usize - 1])
        .filter_map(|s| s.publication.lock().unwrap().next_wake())
        .map(|slot| hub.publication_deadline(slot))
        .min()
}

struct PeerHandler {
    peer: Arc<Peer>,
    gathered: Arc<Notify>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for PeerHandler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.gathered.notify_one();
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        log::info!("WebRTC state: {state}");
        if matches!(
            state,
            RTCPeerConnectionState::Failed
                | RTCPeerConnectionState::Closed
                | RTCPeerConnectionState::Disconnected
        ) {
            self.peer.close.notify_one();
        }
    }

    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let peer = self.peer.clone();
        // Poll independently so the connection driver can keep delivering events.
        tokio::spawn(async move {
            if let Err(error) = peer.attach(dc).await {
                log::warn!("Data channel failed: {error}");
            }
            peer.close.notify_one();
        });
    }
}

impl Peer {
    async fn attach(&self, dc: Arc<dyn DataChannel>) -> Result<(), String> {
        let label = dc.label().await.map_err(|e| e.to_string())?;
        let control = label == "reliable";
        let bit = if control { 1 } else { 2 };
        let valid = matches!(label.as_str(), "reliable" | "unreliable")
            && dc.protocol().await.map_err(|e| e.to_string())? == "xrop"
            && dc.ordered().await.map_err(|e| e.to_string())? == control
            && dc.max_retransmits().await.map_err(|e| e.to_string())?
                == if control { None } else { Some(0) }
            && dc
                .max_packet_life_time()
                .await
                .map_err(|e| e.to_string())?
                .is_none();
        if !valid || self.claimed_channels.fetch_or(bit, Ordering::SeqCst) & bit != 0 {
            return Err(format!("Invalid or duplicate data channel: {label}"));
        }
        let index = if control { 1 } else { 0 };
        self.channel_state
            .send_modify(|channels| channels.connections[index] = Some(dc.clone()));
        while let Some(event) = dc.poll().await {
            match event {
                DataChannelEvent::OnOpen => {
                    self.channel_state
                        .send_modify(|channels| channels.open[index] = true);
                    log::info!("Data channel open: {label}");
                }
                DataChannelEvent::OnClose => break,
                DataChannelEvent::OnError => return Err(format!("Channel error: {label}")),
                DataChannelEvent::OnMessage(message) => {
                    let received_at = self.hub.now();
                    let data = message.data.freeze();
                    if !control {
                        if !message.is_string && data.len() == 5 && data[0] == 10 {
                            let id = u32::from_le_bytes(data[1..].try_into().unwrap());
                            let _ = self
                                .unreliable
                                .try_send(UnreliableEvent::Clock(id, received_at));
                        }
                        if !message.is_string && data.first() == Some(&13) && data.len() <= 13 {
                            let _ = self
                                .unreliable
                                .try_send(UnreliableEvent::Acknowledgment(data));
                        }
                        continue;
                    }
                    // The server has no inbound publication subscriptions. Publications
                    // are discarded on either channel, including malformed bodies.
                    if !message.is_string && data.first() == Some(&9) {
                        continue;
                    }
                    if message.is_string {
                        return Err("Control messages must be binary".into());
                    }
                    self.enqueue_control(data).await?;
                }
                _ => {}
            }
        }
        Ok(())
    }
}

impl Peer {
    async fn send(
        &self,
        dc: &Arc<dyn DataChannel>,
        mut message: Vec<u8>,
        control: bool,
    ) -> Result<(), String> {
        let buffered = dc.outstanding_bytes().await.map_err(|e| e.to_string())?;
        if control && buffered.saturating_add(message.len()) > 1_048_576 {
            return Err("Control backpressure limit".into());
        }
        if !control && message.first() == Some(&11) {
            message[13..21].copy_from_slice(&(self.hub.now() as u64).to_le_bytes());
        }
        if message.len() > self.message_limit {
            return Err(format!(
                "Message of {} bytes exceeds channel limit of {} bytes",
                message.len(),
                self.message_limit
            ));
        }
        let data = bytes::BytesMut::from(message.as_slice());
        timeout(Duration::from_secs(2), dc.send(data))
            .await
            .map_err(|_| "Data channel send timed out")?
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    async fn run(&self, mut incoming: PeerInbox) -> Result<(), String> {
        let mut updates = self.hub.updates.subscribe();
        let mut retired = self.hub.retired.subscribe();
        let mut state = Session::new(self.hub.capabilities.clone());
        state.packet_limit = self.message_limit;
        state.max_publication_rate_hz = RATE as f64;
        let deadline = tokio::time::sleep(Duration::from_secs(12));
        tokio::pin!(deadline);
        loop {
            if *retired.borrow() {
                return Err(
                    "Device epoch changed; reconnect to discover current capabilities".into(),
                );
            }
            let channels = incoming.channels.borrow_and_update().clone();
            let ready = channels.ready();
            let next = next_publication(&state, ready, &self.hub);
            let wait = next.map_or(Duration::from_secs(3600), |due| {
                Duration::from_nanos(due.saturating_sub(self.hub.now() as u64))
            });
            tokio::select! {
                _ = retired.changed() => return Err("Device epoch changed; reconnect required".into()),
                _ = &mut deadline, if !state.negotiated || !ready.into_iter().all(|v|v) => return Err("Protocol setup timed out".into()),
                changed = incoming.channels.changed() => { changed.map_err(|_| "Channel state closed")?; },
                bytes = incoming.controls.recv() => {
                    let bytes = bytes.ok_or("Peer control receiver closed")?;
                    let message = protocol::decode_client(&bytes)?;
                    let reschedule = matches!(message, Message::UpdateSchedule { .. } | Message::Unsubscribe { .. });
                    let replies = state.handle_with_source(message, self.hub.now(), |r|self.hub.check(r))?;
                    if reschedule { self.hub.reschedule(); }
                    for reply in replies {
                        if let Message::Accepted { id } = reply {
                            let subscription = &state.active[&id];
                            self.hub.observe(&subscription.request, &subscription.publication)?;
                        }
                        let control = incoming.channels.borrow().get(2).cloned().ok_or("Missing reliable channel")?;
                        self.send(&control, protocol::encode(&reply), true).await?;
                    }
                    if !state.negotiated {return Err("No supported protocol version".into());}
                },
                _ = tokio::time::sleep(wait), if next.is_some() => {},
                changed = updates.changed() => {changed.map_err(|_|"Source closed")?;},
                event = incoming.unreliable.recv() => match event.ok_or("Unreliable receiver closed")? {
                    UnreliableEvent::Acknowledgment(bytes) => state.acknowledge(&bytes),
                    UnreliableEvent::Clock(id, received_at) => {
                        if let Some(dc) = channels.get(1)
                            && state.negotiated && self.message_limit >= 21 && tracking_fits(dc.outstanding_bytes().await.map_err(|e|e.to_string())?,21) {
                            self.send(dc,protocol::clock_response(id,received_at as u64,0),false).await?;
                        }
                    }
                }
            }
            let channels = incoming.channels.borrow().clone();
            let mut ended = Vec::new();
            for subscription in state.active.values() {
                let channel_id = subscription.request.channel;
                let Some(dc) = channels.get(channel_id) else {
                    continue;
                };
                let candidate = {
                    let mut p = subscription.publication.lock().unwrap();
                    if let Some(e) = p.error.clone() {
                        ended.push((subscription.request.id, e));
                        continue;
                    }
                    let now = self.hub.now() as u64;
                    if p.next_wake()
                        .is_some_and(|slot| self.hub.publication_deadline(slot) > now)
                        || !p.opportunity(now)
                    {
                        continue;
                    }
                    p.candidate()
                };
                let Some(candidate) = candidate else {
                    continue;
                };
                let buffered = dc.outstanding_bytes().await.map_err(|e| e.to_string())?;
                let size = candidate.body.len() + 1;
                if if channel_id == 2 {
                    buffered.saturating_add(size) > 1_048_576
                } else {
                    !tracking_fits(buffered, size)
                } {
                    continue;
                }
                let mut framed = vec![9];
                framed.extend_from_slice(&candidate.body);
                self.send(dc, framed, channel_id == 2).await?;
                // Record the exact submitted candidate, even if a sensor updated during send.
                subscription
                    .publication
                    .lock()
                    .unwrap()
                    .submitted(candidate);
            }
            for (id, reason) in ended {
                for reply in state.end(id, &reason) {
                    self.send(
                        channels.get(2).ok_or("Missing reliable channel")?,
                        protocol::encode(&reply),
                        true,
                    )
                    .await?;
                }
            }
        }
    }
}

fn tracking_fits(buffered: usize, packet: usize) -> bool {
    packet <= protocol::MAX_SERVER_MESSAGE
        && (buffered == 0 || buffered.saturating_add(packet) <= 16_384)
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
    let hub = server.source.current().ok_or_else(|| {
        let health = server.source.status();
        let reason = health["backend"]["status"]
            .as_str()
            .unwrap_or("Waiting for gamepad discovery");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("No selected gamepad. {reason}"),
        )
    })?;
    if *hub.retired.borrow() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Gamepad capabilities changed. Reconnect to discover current samples.".into(),
        ));
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
    let send_limit = SctpMaxMessageSize::Bounded(protocol::MAX_SERVER_MESSAGE as u32);
    // rtc 0.21 caps messages at 256 KiB, even when a higher bound is configured.
    let message_limit = if remote_limit == 0 {
        send_limit.as_usize()
    } else {
        (remote_limit as usize).min(send_limit.as_usize())
    };
    let (peer, incoming) = Peer::new(hub, message_limit);
    let settings = SettingEngineBuilder::new()
        .with_sctp_max_message_size(send_limit)
        .build();
    let gathered = Arc::new(Notify::new());
    let pc = Arc::new(
        PeerConnectionBuilder::new()
            .with_setting_engine(settings)
            .with_handler(Arc::new(PeerHandler {
                peer: peer.clone(),
                gathered: gathered.clone(),
            }))
            .with_udp_addrs(vec!["0.0.0.0:0"])
            .build()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
    );

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
        pc.set_local_description(answer).await?;
        gathered.notified().await;
        pc.local_description()
            .await
            .ok_or(webrtc::error::Error::ErrConnectionClosed)
    };
    let mut negotiation_shutdown = server.shutdown.clone();
    let outcome = tokio::select! {
        result = timeout(Duration::from_secs(8), negotiation) => result,
        _ = negotiation_shutdown.wait_for(|stopped| *stopped) => {
            peer.close.notify_one();
            return Err((StatusCode::SERVICE_UNAVAILABLE, "Server shutting down".into()));
        }
    };
    match outcome {
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
    source: Arc<Source>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let server = Arc::new(Server {
        source,
        slots: Arc::new(Semaphore::new(4)),
        shutdown: shutdown.clone(),
    });
    let router = Router::new()
        .route(
            "/health",
            get(|State(server): State<Arc<Server>>| async move { Json(server.source.status()) }),
        )
        .route("/offer", post(offer))
        .layer(DefaultBodyLimit::max(65_536))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(10),
        ))
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
    Ok(())
}
