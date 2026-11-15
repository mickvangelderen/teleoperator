use crate::tracking::{Group, Hub, SubscriptionSamples, validate_schedule};
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
    data_channel::{DataChannel, DataChannelEvent, RTCDataChannelState},
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

enum PeerEvent {
    Channel(bool, Arc<dyn DataChannel>),
    Control(bytes::Bytes),
    Clock(u32, i64),
    Progress,
}

struct Peer {
    channels: AtomicU8,
    hub: Arc<Hub>,
    close: Notify,
    events: mpsc::Sender<PeerEvent>,
    message_limit: usize,
}

struct SamplingSubscription {
    samples: SubscriptionSamples,
    sent: Option<u64>,
    packet_size: usize,
    packet: Vec<u8>,
    values: Vec<protocol::Value>,
}
#[derive(Default)]
struct SamplingSubscriptions(BTreeMap<u32, SamplingSubscription>);
impl SamplingSubscriptions {
    fn reconcile(
        &mut self,
        hub: &Arc<Hub>,
        state: &Session,
        replies: &[Message],
        updated: Option<u32>,
    ) {
        for reply in replies {
            match reply {
                Message::Ended { id, .. } => {
                    self.0.remove(id);
                }
                Message::Accepted { id } => {
                    let request = &state.active[id].request;
                    let packet_size = state
                        .capabilities
                        .validate_request(request)
                        .expect("Accepted request");
                    self.0.insert(
                        *id,
                        SamplingSubscription {
                            samples: hub.subscribe(
                                Group::from_index(state.active[id].request.group)
                                    .expect("Advertised group"),
                                state.active[id].request.schedule.clone(),
                            ),
                            sent: None,
                            packet_size: packet_size + 1,
                            packet: Vec::with_capacity(packet_size),
                            values: Vec::with_capacity(state.active[id].request.samples.len()),
                        },
                    );
                }
                _ => {}
            }
        }
        if let Some(id) = updated
            && let (Some(sampling), Some(subscription)) =
                (self.0.get_mut(&id), state.active.get(&id))
        {
            sampling
                .samples
                .update(subscription.request.schedule.clone());
            sampling.sent = None;
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
        if !valid || self.channels.fetch_or(bit, Ordering::SeqCst) & bit != 0 {
            return Err(format!("Invalid or duplicate data channel: {label}"));
        }
        self.events
            .try_send(PeerEvent::Channel(control, dc.clone()))
            .map_err(|_| "Peer event queue full or closed")?;
        while let Some(event) = dc.poll().await {
            match event {
                DataChannelEvent::OnOpen => log::info!("Data channel open: {label}"),
                DataChannelEvent::OnClose => break,
                DataChannelEvent::OnError => return Err(format!("Channel error: {label}")),
                DataChannelEvent::OnBufferedAmountLow | DataChannelEvent::OnBufferedAmountHigh => {
                    let _ = self.events.try_send(PeerEvent::Progress);
                }
                DataChannelEvent::OnMessage(message) => {
                    let received_at = self.hub.now();
                    let data = message.data.freeze();
                    if !control {
                        if !message.is_string && data.len() == 5 && data[0] == 10 {
                            let id = u32::from_le_bytes(data[1..].try_into().unwrap());
                            let _ = self.events.try_send(PeerEvent::Clock(id, received_at));
                        }
                        continue;
                    }
                    if message.is_string
                        || data.len() > protocol::MAX_CLIENT_MESSAGE
                        || self.events.try_send(PeerEvent::Control(data)).is_err()
                    {
                        return Err("Invalid control message or peer event queue full".into());
                    }
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
        let message = if let Message::SubscribeBody(body) = message {
            Message::Subscribe(protocol::decode_subscription(&body, &state.capabilities)?)
        } else {
            message
        };
        if let Message::UpdateSchedule { schedule, .. } = &message {
            validate_schedule(schedule, self.hub.now() as u64)?;
        }
        if let Message::Subscribe(request) = &message {
            if let Err(reason) = validate_schedule(&request.schedule, self.hub.now() as u64) {
                return Ok(vec![Message::Rejected {
                    id: request.id,
                    reason: Some(reason),
                }]);
            }
            let sample = Group::from_index(request.group).and_then(|group| self.hub.latest(group));
            if let Some(sample) = sample {
                catalog.refresh_skeleton(&self.hub, &sample);
                let validation = state.capabilities.validate_request(request).and_then(|_| {
                    let timestamp = u64::try_from(sample.acquired_at)
                        .map_err(|_| "Invalid acquisition time")?;
                    catalog.publication(request, &sample, timestamp).map(|_| ())
                });
                if let Err(reason) = validation {
                    return Ok(vec![Message::Rejected {
                        id: request.id,
                        reason: Some(reason),
                    }]);
                }
            }
        }
        state.handle(message, self.hub.now())
    }
    async fn run(&self, mut incoming: mpsc::Receiver<PeerEvent>) -> Result<(), String> {
        let mut updates = self.hub.updates.subscribe();
        let mut control = None;
        let mut tracking: Option<Arc<dyn DataChannel>> = None;
        let mut session: Option<(Catalog, Session)> = None;
        let mut pending_offer = None;
        let mut sampling = SamplingSubscriptions::default();
        let deadline = tokio::time::sleep(Duration::from_secs(12));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline, if session.is_none() || control.is_none() || tracking.is_none() => return Err("Protocol setup timed out".into()),
                event = incoming.recv() => match event.ok_or("Peer event channel closed")? {
                    PeerEvent::Progress => {},
                    PeerEvent::Clock(id, received_at) => {
                        if let (Some((_, state)), Some(dc)) = (&session, &tracking)
                            && state.negotiated && self.message_limit >= 21 && tracking_fits(dc.outstanding_bytes().await.map_err(|e| e.to_string())?, 21) {
                            self.send(dc, protocol::clock_response(id, received_at as u64, 0), false).await?;
                        }
                    },
                    PeerEvent::Channel(reliable, dc) => { if reliable { control = Some(dc); } else { tracking = Some(dc); } },
                    PeerEvent::Control(bytes) => {
                        let message = protocol::decode_client(&bytes)?;
                        if let Some((catalog, state)) = session.as_mut() {
                            let updated = match &message { Message::UpdateSchedule { id, .. } => Some(*id), _ => None };
                            let replies = self.handle_control(catalog, state, message)?;
                            sampling.reconcile(&self.hub, state, &replies, updated);
                            for reply in replies {
                                self.send(control.as_ref().ok_or("Missing control channel")?, protocol::encode(&reply), true).await?;
                            }
                            } else {
                                if pending_offer.is_some() || !matches!(message, Message::Offer(_)) { return Err("Version offer must be first".into()); }
                                pending_offer = Some(message);
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
            if catalog.changed(&self.hub) {
                return Err("Device capabilities changed; reconnect".into());
            }
            if !self.hub.available.load(Ordering::SeqCst) {
                for id in session.active.keys().copied().collect::<Vec<_>>() {
                    sampling.0.remove(&id);
                    for reply in session.end(id, "Device acquisition stopped") {
                        self.send(control.as_ref().unwrap(), protocol::encode(&reply), true)
                            .await?;
                    }
                }
                continue;
            }
            let Some(dc) = tracking.as_ref() else {
                continue;
            };
            if dc.ready_state().await.map_err(|e| e.to_string())? != RTCDataChannelState::Open {
                continue;
            }
            let mut tracking_buffered = dc.outstanding_bytes().await.map_err(|e| e.to_string())?;
            let mut reliable_buffered = if session.active.values().any(|s| s.request.delivery == 2)
            {
                control
                    .as_ref()
                    .unwrap()
                    .outstanding_bytes()
                    .await
                    .map_err(|e| e.to_string())?
            } else {
                0
            };
            let mut ended = Vec::new();
            for subscription in session.active.values_mut() {
                let Some(sampling) = sampling.0.get_mut(&subscription.request.id) else {
                    continue;
                };
                let reliable = subscription.request.delivery == 2;
                let buffered = if reliable {
                    &mut reliable_buffered
                } else {
                    &mut tracking_buffered
                };
                let ready = if reliable {
                    buffered.saturating_add(sampling.packet_size) <= 1_048_576
                } else {
                    tracking_fits(*buffered, sampling.packet_size)
                };
                sampling.samples.set_ready(ready);
                if !ready {
                    continue;
                }
                let sender_at = self.hub.now() as u64;
                let Some(delivery) = sampling.samples.delivery_after(sampling.sent) else {
                    continue;
                };
                let sample = &delivery.sample;
                // Recenter keeps the selected space; wait for a capture in its new origin.
                if sample.reference_version != *self.hub.reference_version.lock().unwrap() {
                    continue;
                }
                let Some(timestamp) = subscription.timestamp(sample.acquired_at, self.hub.now())
                else {
                    continue;
                };
                catalog.refresh_skeleton(&self.hub, sample);
                if let Err(reason) = catalog.publication_into(
                    &subscription.request,
                    sample,
                    timestamp,
                    &mut sampling.values,
                    &mut sampling.packet,
                ) {
                    ended.push((subscription.request.id, reason));
                    continue;
                }
                if !subscription.should_publish(&sampling.packet) {
                    continue;
                }
                let channel = if reliable {
                    control.as_ref().unwrap()
                } else {
                    dc
                };
                let mut framed = bytes::BytesMut::with_capacity(sampling.packet_size);
                framed.extend_from_slice(&[9]);
                framed.extend_from_slice(&sampling.packet);
                let encoded_at = self.hub.now() as u64;
                // Recheck expiry/replacement immediately before handing off to WebRTC.
                if !sampling.samples.is_current(sample.number) {
                    sampling.samples.discarded(&delivery, self.hub.now() as u64);
                    continue;
                }
                timeout(Duration::from_secs(2), channel.send(framed))
                    .await
                    .map_err(|_| "Data channel send timed out")?
                    .map_err(|e| e.to_string())?;
                let submitted_at = self.hub.now() as u64;
                sampling
                    .samples
                    .submitted(&delivery, sender_at, encoded_at, submitted_at);
                *buffered = buffered.saturating_add(sampling.packet_size);
                subscription.published(&sampling.packet);
                sampling.sent = Some(sample.number);
            }
            for (id, reason) in ended {
                sampling.0.remove(&id);
                for reply in session.end(id, &reason) {
                    self.send(control.as_ref().unwrap(), protocol::encode(&reply), true)
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
    let (events, incoming) = mpsc::channel(32);
    let peer = Arc::new(Peer {
        channels: AtomicU8::new(0),
        hub: server.hub.clone(),
        close: Notify::new(),
        events,
        message_limit,
    });
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
    #[test]
    fn peer_sampling_lifetimes_isolate_equal_ids_and_reconcile_control_atomically() {
        use crate::{
            protocol::{Request, Schedule, Selection},
            tracking::Pose,
        };
        let hub = Hub::new("test");
        hub.initialized.store(true, Ordering::SeqCst);
        let request = Request {
            id: 7,
            group: 0,
            delivery: 1,
            schedule: Schedule::Periodic {
                interval: 1_000_000_000,
                phase: 500_000_000,
                consumption_delay: 30_000_000,
            },
            samples: vec![Selection {
                descriptor: 0,
                format: 10,
                space: 2,
            }],
        };
        let mut states = std::array::from_fn::<_, 2, _>(|_| {
            let mut state = Session::new(Catalog::snapshot(&hub).capabilities);
            state.handle(Message::Offer(vec![1]), hub.now()).unwrap();
            state
        });
        let mut peers = [
            SamplingSubscriptions::default(),
            SamplingSubscriptions::default(),
        ];
        for (state, peer) in states.iter_mut().zip(&mut peers) {
            let replies = state
                .handle(Message::Subscribe(request.clone()), hub.now())
                .unwrap();
            peer.reconcile(&hub, state, &replies, None);
        }
        let due = hub.next_acquisition().unwrap();
        let mut work = hub.acquisitions(due, false);
        assert_eq!(work.len(), 1);
        let capture = work.pop().unwrap();
        let sample = hub.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            None,
            due as i64,
            capture.target_at,
        );
        hub.complete(capture, sample.clone());
        assert_eq!(
            peers[0].0[&7].samples.latest().unwrap().number,
            sample.number
        );
        assert_eq!(
            peers[1].0[&7].samples.latest().unwrap().number,
            sample.number
        );
        let mut invalid = request.clone();
        invalid.samples[0].descriptor = u32::MAX;
        let replies = states[0]
            .handle(Message::Subscribe(invalid), hub.now())
            .unwrap();
        assert!(matches!(replies[0], Message::Rejected { .. }));
        peers[0].reconcile(&hub, &states[0], &replies, None);
        assert_eq!(
            peers[0].0[&7].samples.latest().unwrap().number,
            sample.number
        );
        let schedule = Schedule::Periodic {
            interval: 1_000_000_000,
            phase: 510_000_000,
            consumption_delay: 80_000_000,
        };
        let replies = states[0]
            .handle(Message::UpdateSchedule { id: 7, schedule }, hub.now())
            .unwrap();
        peers[0].reconcile(&hub, &states[0], &replies, Some(7));
        assert!(peers[0].0[&7].samples.latest().is_none());
        assert_eq!(
            peers[1].0[&7].samples.latest().unwrap().number,
            sample.number
        );
        let updated_due = hub.next_acquisition().unwrap();
        let old_work = hub.acquisitions(updated_due, false).pop().unwrap();
        let replies = states[0]
            .handle(Message::Subscribe(request), hub.now())
            .unwrap();
        peers[0].reconcile(&hub, &states[0], &replies, None);
        hub.complete(old_work, sample);
        assert!(
            peers[0].0[&7].samples.latest().is_none(),
            "Replacement invalidates in-flight capture"
        );
        let replies = states[0]
            .handle(Message::Unsubscribe { id: 7 }, hub.now())
            .unwrap();
        peers[0].reconcile(&hub, &states[0], &replies, None);
        assert!(peers[0].0.is_empty());
        assert!(
            hub.next_acquisition().is_some(),
            "The other peer remains subscribed"
        );
        drop(peers);
        assert_eq!(
            hub.next_acquisition(),
            None,
            "Dropping connection state releases all sampler demand"
        );
    }

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
            protocol::{Request, Schedule, Selection},
            tracking::Pose,
        };
        let hub = Hub::new("test");
        hub.initialized.store(true, Ordering::SeqCst);
        let (events, _) = mpsc::channel(4);
        let peer = Peer {
            channels: AtomicU8::new(0),
            hub: hub.clone(),
            close: Notify::new(),
            events,
            message_limit: protocol::MAX_SERVER_MESSAGE,
        };
        let mut catalog = Catalog::snapshot(&hub);
        let mut session = Session::new(catalog.capabilities.clone());
        session.handle(Message::Offer(vec![1]), 0).unwrap();
        let head = Request {
            id: 1,
            group: 0,
            delivery: 1,
            schedule: Schedule::OnChange,
            samples: vec![Selection {
                descriptor: 0,
                format: 10,
                space: 2,
            }],
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
            samples: vec![Selection {
                descriptor: active,
                format: 1,
                space: 0,
            }],
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
}
