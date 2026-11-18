use crate::tracking::{Group, Hub, SubscriptionSamples};
use crate::{
    protocol::{self, Message, Session},
    publication::Catalog,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use rtc::peer_connection::configuration::setting_engine::SctpMaxMessageSize;
use std::collections::BTreeMap;
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
    hub: Arc<Hub>,
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
fn next_publication(session: Option<&Session>, ready: [bool; 2]) -> Option<u64> {
    session?
        .active
        .values()
        .filter(|s| ready[s.request.channel as usize - 1])
        .filter_map(|s| s.publication.lock().unwrap().next_wake())
        .min()
}

#[derive(Default)]
struct SamplingSubscriptions(BTreeMap<u32, SubscriptionSamples>);
impl SamplingSubscriptions {
    fn reconcile(
        &mut self,
        hub: &Arc<Hub>,
        catalog: &Catalog,
        state: &Session,
        replies: &[Message],
    ) {
        for reply in replies {
            match reply {
                Message::Ended { id, .. } => {
                    self.0.remove(id);
                }
                Message::Accepted { id } => {
                    self.0
                        .insert(*id, hub.subscribe(&state.active[id], catalog));
                }
                _ => {}
            }
        }
    }
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
    fn handle_control(
        &self,
        catalog: &mut Catalog,
        state: &mut Session,
        message: Message,
    ) -> protocol::Result<Vec<Message>> {
        state.handle_with_source(message, self.hub.now(), |request| {
            if let Some(sample) =
                Group::from_index(request.group).and_then(|group| self.hub.initial_sample(group))
            {
                catalog.refresh_skeleton(&self.hub, &sample);
                catalog.encode_acquisition(request, &sample)?;
            }
            Ok(())
        })
    }
    async fn run(&self, mut incoming: PeerInbox) -> Result<(), String> {
        let mut updates = self.hub.updates.subscribe();
        let mut session: Option<(Catalog, Session)> = None;
        let mut pending_offer = None;
        let mut sampling = SamplingSubscriptions::default();
        let deadline = tokio::time::sleep(Duration::from_secs(12));
        tokio::pin!(deadline);
        loop {
            let channels = incoming.channels.borrow_and_update().clone();
            let ready = channels.ready();
            let next = next_publication(session.as_ref().map(|(_, state)| state), ready);
            let wait = next.map_or(Duration::from_secs(3600), |due| {
                Duration::from_nanos(due.saturating_sub(self.hub.now() as u64))
            });
            tokio::select! {
                biased;
                _ = &mut deadline, if session.is_none() || !ready.into_iter().all(|open| open) => return Err("Protocol setup timed out".into()),
                changed = incoming.channels.changed() => { changed.map_err(|_| "Channel state closed")?; },
                bytes = incoming.controls.recv() => {
                    let bytes = bytes.ok_or("Peer control receiver closed")?;
                    let message = protocol::decode_client(&bytes)?;
                    if let Some((catalog, state)) = session.as_mut() {
                        let replies = self.handle_control(catalog, state, message)?;
                        sampling.reconcile(&self.hub, catalog, state, &replies);
                        for reply in replies {
                            self.send(channels.get(2).ok_or("Missing open reliable channel")?, protocol::encode(&reply), true).await?;
                        }
                    } else {
                        if pending_offer.is_some() || !matches!(message, Message::Offer(_)) { return Err("Version offer must be first".into()); }
                        pending_offer = Some(message);
                    }
                },
                _ = tokio::time::sleep(wait), if next.is_some() => {},
                _ = updates.changed() => {},
                event = incoming.unreliable.recv() => match event.ok_or("Peer unreliable receiver closed")? {
                    UnreliableEvent::Acknowledgment(bytes) => {
                        if let Some((_, state)) = &session { state.acknowledge(&bytes); }
                    },
                    UnreliableEvent::Clock(id, received_at) => {
                        if let (Some((_, state)), Some(dc)) = (&session, channels.get(1))
                            && state.negotiated && self.message_limit >= 21 && tracking_fits(dc.outstanding_bytes().await.map_err(|e| e.to_string())?, 21) {
                            self.send(dc, protocol::clock_response(id, received_at as u64, 0), false).await?;
                        }
                    },
                },
            }
            if pending_offer.is_some() && ready[1] && self.hub.initialized.load(Ordering::SeqCst) {
                let catalog = Catalog::snapshot(&self.hub);
                let mut state = Session::new(catalog.capabilities.clone());
                state.packet_limit = self.message_limit;
                for reply in state.handle(pending_offer.take().unwrap(), self.hub.now())? {
                    self.send(
                        channels.get(2).ok_or("Missing open reliable channel")?,
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
            if catalog.changed(&self.hub) {
                return Err("Device capabilities changed; reconnect".into());
            }
            if !self.hub.available.load(Ordering::SeqCst) {
                for id in session.active.keys().copied().collect::<Vec<_>>() {
                    sampling.0.remove(&id);
                    for reply in session.end(id, "Device acquisition stopped") {
                        self.send(channels.get(2).unwrap(), protocol::encode(&reply), true)
                            .await?;
                    }
                }
                continue;
            }
            let mut buffered = [0; 2];
            for channel in [1, 2] {
                if let Some(dc) = channels.get(channel) {
                    buffered[channel as usize - 1] =
                        dc.outstanding_bytes().await.map_err(|e| e.to_string())?;
                }
            }
            let mut ended = Vec::new();
            for subscription in session.active.values() {
                let id = subscription.request.id;
                let (error, opportunity) = {
                    let mut publication = subscription.publication.lock().unwrap();
                    (
                        publication.error.clone(),
                        channels.get(subscription.request.channel).is_some()
                            && publication.opportunity(self.hub.now() as u64),
                    )
                };
                if let Some(error) = error {
                    ended.push((id, error));
                    continue;
                }
                if !opportunity {
                    continue;
                }
                let channel = channels.get(subscription.request.channel).unwrap();
                let reliable = subscription.request.channel == 2;
                let buffered = &mut buffered[subscription.request.channel as usize - 1];
                let candidate = subscription.publication.lock().unwrap().candidate();
                let Some(candidate) = candidate else {
                    continue;
                };
                let packet_size = candidate.body.len() + 1;
                let ready = if reliable {
                    buffered.saturating_add(packet_size) <= 1_048_576
                } else {
                    tracking_fits(*buffered, packet_size)
                };
                if !ready {
                    continue;
                }
                let mut framed = bytes::BytesMut::with_capacity(packet_size);
                framed.extend_from_slice(&[9]);
                framed.extend_from_slice(&candidate.body);
                timeout(Duration::from_secs(2), channel.send(framed))
                    .await
                    .map_err(|_| "Data channel send timed out")?
                    .map_err(|e| e.to_string())?;
                // Acquisitions can change during send. Record exactly the candidate
                // submitted, never the current revision at completion time.
                subscription
                    .publication
                    .lock()
                    .unwrap()
                    .submitted(candidate);
                *buffered = buffered.saturating_add(packet_size);
            }
            for (id, reason) in ended {
                sampling.0.remove(&id);
                for reply in session.end(id, &reason) {
                    self.send(channels.get(2).unwrap(), protocol::encode(&reply), true)
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
    let (peer, incoming) = Peer::new(server.hub.clone(), message_limit);
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
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let server = Arc::new(Server {
        hub,
        slots: Arc::new(Semaphore::new(4)),
        shutdown: shutdown.clone(),
    });
    let router = Router::new().route("/health", get(|State(server): State<Arc<Server>>| async move { Json(serde_json::json!({"application": "XR Operator", "tracking": server.hub.available.load(Ordering::SeqCst), "source": server.hub.source, "prediction": "subscription_schedule"})) }))
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct GatherHandler(Arc<Notify>);

    #[async_trait::async_trait]
    impl PeerConnectionEventHandler for GatherHandler {
        async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
            if state == RTCIceGatheringState::Complete {
                self.0.notify_one();
            }
        }
    }

    async fn receive(dc: &Arc<dyn DataChannel>) -> bytes::Bytes {
        loop {
            match dc.poll().await.expect("Data channel closed") {
                DataChannelEvent::OnMessage(message) => {
                    assert!(!message.is_string);
                    return message.data.freeze();
                }
                DataChannelEvent::OnClose | DataChannelEvent::OnError => {
                    panic!("Data channel failed before receiving a message");
                }
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn capabilities_above_64k_arrive_as_one_webrtc_message() {
        use webrtc::data_channel::RTCDataChannelInit;

        let hub = Hub::new("test");
        hub.initialized.store(true, Ordering::SeqCst);
        hub.body_supported.store(true, Ordering::SeqCst);
        let mut skeleton = (*crate::body::synthetic_skeleton()).clone();
        for joint in &mut skeleton.joints {
            joint.name = "joint".repeat(32);
        }
        *hub.skeleton.lock().unwrap() = Some(Arc::new(skeleton));
        let expected =
            protocol::encode(&Message::Capabilities(Catalog::snapshot(&hub).capabilities));
        assert!(expected.len() > 65_536 && expected.len() < 262_144);
        let (stop, shutdown) = watch::channel(false);
        let server = Arc::new(Server {
            slots: Arc::new(Semaphore::new(4)),
            shutdown,
            hub,
        });
        // This test peer accepts larger messages, like the browser.
        let settings = SettingEngineBuilder::new()
            .with_sctp_max_message_size(SctpMaxMessageSize::Bounded(262_144))
            .build();
        let gathered = Arc::new(Notify::new());
        let client = PeerConnectionBuilder::new()
            .with_setting_engine(settings)
            .with_handler(Arc::new(GatherHandler(gathered.clone())))
            .with_udp_addrs(vec!["0.0.0.0:0"])
            .build()
            .await
            .unwrap();
        let mut channels = Vec::new();
        for control in [true, false] {
            let dc = client
                .create_data_channel(
                    if control { "reliable" } else { "unreliable" },
                    Some(RTCDataChannelInit {
                        protocol: "xrop".into(),
                        ordered: control,
                        max_retransmits: if control { None } else { Some(0) },
                        ..Default::default()
                    }),
                )
                .await
                .unwrap();
            channels.push(dc);
        }
        let exchange = async {
            client
                .set_local_description(client.create_offer(None).await.unwrap())
                .await
                .unwrap();
            gathered.notified().await;
            let description = client.local_description().await.unwrap();
            let Json(answer) = offer(State(server.clone()), HeaderMap::new(), Json(description))
                .await
                .unwrap();
            client.set_remote_description(answer).await.unwrap();
            for dc in &channels {
                assert!(matches!(dc.poll().await, Some(DataChannelEvent::OnOpen)));
            }
            let reliable = &channels[0];
            let unreliable = &channels[1];
            reliable
                .send(protocol::encode(&Message::Offer(vec![1])).as_slice().into())
                .await
                .unwrap();
            assert_eq!(receive(reliable).await.as_ref(), &[2, 1, 0]);
            assert_eq!(receive(reliable).await.as_ref(), expected);
            unreliable
                .send(bytes::BytesMut::from(&[10, 1, 0, 0, 0][..]))
                .await
                .unwrap();
            let response = receive(unreliable).await;
            assert_eq!(response.len(), 21);
            assert_eq!(&response[..5], &[11, 1, 0, 0, 0]);
        };
        let result = timeout(Duration::from_secs(15), exchange).await;
        let _ = stop.send(true);
        client.close().await.unwrap();
        result.unwrap();
    }

    #[test]
    fn source_admission_waits_initially_and_rejects_malformed_replacement_atomically() {
        use crate::{
            inputs,
            protocol::{Request, SampleBinding},
            tracking::Pose,
        };
        let hub = Hub::new("test");
        hub.initialized.store(true, Ordering::SeqCst);
        hub.set_available(true);
        let (peer, _incoming) = Peer::new(hub.clone(), protocol::MAX_SERVER_MESSAGE);
        let mut catalog = Catalog::snapshot(&hub);
        let mut session = Session::new(catalog.capabilities.clone());
        session.handle(Message::Offer(vec![1]), 0).unwrap();
        let head = Request {
            id: 1,
            group: 0,
            channel: 1,
            interval: 5_000_000,
            phase: 0,
            prediction_offset: 0,
            sequence_number_format: None,
            bundles: vec![vec![SampleBinding {
                descriptor: 0,
                format: 10,
                space: 2,
            }]],
        };
        let submit = |peer: &Peer, c: &mut Catalog, s: &mut Session, r: Request| {
            peer.handle_control(
                c,
                s,
                protocol::decode_client(&protocol::encode(&Message::Subscribe(r))).unwrap(),
            )
            .unwrap()
        };
        assert!(
            matches!(
                submit(&peer, &mut catalog, &mut session, head.clone())[0],
                Message::Accepted { .. }
            ),
            "No acquisition yet waits for actual data"
        );
        let poses = std::array::from_fn(|_| Pose::default());
        let mut inputs: Vec<_> = inputs::definitions()
            .iter()
            .map(|d| inputs::Input::inactive(d.kind))
            .collect();
        hub.acquire(Group::Poses, &poses, &inputs, None, 100, None);
        hub.acquire(Group::Inputs, &poses, &inputs, None, 100, None);
        let active = catalog
            .capabilities
            .descriptors
            .iter()
            .position(|d| d.id == "/user/hand/left/input/x/click/active")
            .unwrap() as u32;
        let status = Request {
            id: 2,
            group: Group::Inputs as u32,
            bundles: vec![vec![SampleBinding {
                descriptor: active,
                format: 1,
                space: 0,
            }]],
            ..head.clone()
        };
        assert!(matches!(
            submit(&peer, &mut catalog, &mut session, status.clone())[0],
            Message::Accepted { .. }
        ));
        // A malformed action variant invalidates its status as well as the original value.
        let action = inputs::definitions()
            .iter()
            .position(|d| d.source == "left" && d.id == "primary/click")
            .unwrap();
        inputs[action].value = inputs::Value::Scalar(0.5);
        inputs[action].active = true;
        hub.acquire(Group::Inputs, &poses, &inputs, None, 101, None);
        let replacement = Request {
            id: 1,
            ..status.clone()
        };
        assert!(matches!(
            submit(&peer, &mut catalog, &mut session, replacement)[0],
            Message::Rejected { .. }
        ));
        assert_eq!(session.active[&1].request, head);
        let sample = hub.latest(Group::Inputs).unwrap();
        assert!(
            catalog
                .publication(&session.active[&1].request, &sample, 101)
                .is_ok()
        );
        let failed: Vec<_> = session
            .active
            .values()
            .filter(|s| catalog.publication(&s.request, &sample, 101).is_err())
            .map(|s| s.request.id)
            .collect();
        assert_eq!(failed, [2]);
        for id in failed {
            session.end(id, "Selected source contract failed");
        }
        assert!(session.active.contains_key(&1));
        assert!(!session.active.contains_key(&2));
        // Missing action slots reject without losing an existing useful head selection.
        hub.acquire(Group::Inputs, &poses, &[], None, 102, None);
        assert!(matches!(
            submit(
                &peer,
                &mut catalog,
                &mut session,
                Request { id: 1, ..status }
            )[0],
            Message::Rejected { .. }
        ));
        assert_eq!(session.active[&1].request, head);
    }
    #[test]
    fn tracking_backpressure_counts_the_new_packet_without_overflow() {
        assert!(tracking_fits(16_384 - 20, 20));
        assert!(!tracking_fits(16_384 - 19, 20));
        assert!(!tracking_fits(16_384, 20));
        assert!(!tracking_fits(usize::MAX, 20));
        assert!(tracking_fits(0, protocol::MAX_SERVER_MESSAGE));
        assert!(!tracking_fits(1, protocol::MAX_SERVER_MESSAGE));
        assert!(!tracking_fits(0, protocol::MAX_SERVER_MESSAGE + 1));
    }
    #[test]
    fn due_publications_wait_only_for_their_selected_channel() {
        use protocol::{EncodedAcquisition, Request, SampleBinding};
        let hub = Hub::new("test");
        hub.initialized.store(true, Ordering::SeqCst);
        let mut session = Session::new(Catalog::snapshot(&hub).capabilities);
        session.handle(Message::Offer(vec![1]), 0).unwrap();
        for channel in [1, 2] {
            session
                .handle(
                    Message::Subscribe(Request {
                        id: channel as u32,
                        group: 0,
                        channel,
                        interval: 5_000_000,
                        phase: 0,
                        prediction_offset: 0,
                        sequence_number_format: None,
                        bundles: vec![vec![SampleBinding {
                            descriptor: 1,
                            format: 1,
                            space: 0,
                        }]],
                    }),
                    0,
                )
                .unwrap();
            session.active[&(channel as u32)]
                .publication
                .lock()
                .unwrap()
                .observe(EncodedAcquisition {
                    number: 1,
                    acquired_at: 1,
                    predicted_for: None,
                    bundles: vec![vec![0]],
                });
        }
        assert_eq!(
            next_publication(Some(&session), [false, false]),
            None,
            "A due publication cannot arm a zero-duration wake without its channel"
        );
        assert_eq!(
            next_publication(Some(&session), [false, true]),
            Some(0),
            "Reliable delivery works before the unreliable channel opens"
        );
        session.active[&2]
            .publication
            .lock()
            .unwrap()
            .opportunity(100);
        assert_eq!(
            next_publication(Some(&session), [false, true]),
            Some(5_000_000),
            "Unopened unreliable delivery cannot force a busy retry"
        );
        assert_eq!(next_publication(Some(&session), [true, false]), Some(0));
        assert_eq!(next_publication(Some(&session), [false, false]), None);
        let disconnected = Channels {
            open: [true, true],
            ..Default::default()
        };
        assert_eq!(disconnected.ready(), [false, false]);
    }
    #[tokio::test]
    async fn saturated_unreliable_ingress_cannot_fail_or_reorder_reliable_controls() {
        use std::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        let (peer, mut inbox) = Peer::new(Hub::new("test"), protocol::MAX_SERVER_MESSAGE);
        for n in 0..1024 {
            let _ = peer.unreliable.try_send(UnreliableEvent::Clock(n, 0));
        }
        assert_eq!(inbox.unreliable.len(), 32);
        for n in 0..32 {
            peer.enqueue_control(bytes::Bytes::from(vec![n]))
                .await
                .unwrap();
        }
        let mut blocked = std::pin::pin!(peer.enqueue_control(bytes::Bytes::from_static(&[32])));
        assert!(
            matches!(
                blocked
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop())),
                Poll::Pending
            ),
            "Reliable ingress waits for bounded capacity instead of closing"
        );
        assert_eq!(inbox.controls.recv().await.unwrap().as_ref(), &[0]);
        blocked.await.unwrap();
        for n in 1..=32 {
            assert_eq!(inbox.controls.recv().await.unwrap().as_ref(), &[n]);
        }
        assert_eq!(
            inbox.unreliable.len(),
            32,
            "Reliable backpressure has its own capacity"
        );
        peer.enqueue_control(bytes::Bytes::from_static(&[255]))
            .await
            .unwrap();
        assert_eq!(
            peer.run(inbox).await.unwrap_err(),
            "Invalid client message tag or direction",
            "Reliable controls are processed despite queued unreliable traffic"
        );
    }
    #[tokio::test(start_paused = true)]
    async fn setup_deadline_and_cancellation_release_bounded_ingress() {
        use std::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        let (peer, inbox) = Peer::new(Hub::new("test"), protocol::MAX_SERVER_MESSAGE);
        for n in 0..1024 {
            let _ = peer.unreliable.try_send(UnreliableEvent::Clock(n, 0));
        }
        let mut run = std::pin::pin!(peer.run(inbox));
        assert!(matches!(
            run.as_mut().poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        tokio::time::advance(Duration::from_secs(12)).await;
        assert_eq!(run.await.unwrap_err(), "Protocol setup timed out");

        let (peer, inbox) = Peer::new(Hub::new("test"), protocol::MAX_SERVER_MESSAGE);
        for _ in 0..32 {
            peer.enqueue_control(bytes::Bytes::from_static(&[1]))
                .await
                .unwrap();
        }
        let mut blocked = std::pin::pin!(peer.enqueue_control(bytes::Bytes::from_static(&[2])));
        assert!(matches!(
            blocked
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        // Cancelling the session drops its inbox, including when outbound send is
        // suspended. The channel poller must not remain stuck on ingress capacity.
        drop(inbox);
        assert_eq!(blocked.await.unwrap_err(), "Peer control receiver closed");
    }
}
