use crate::diagnostics::Event;
use crate::tracking::Hub;
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
    api::{
        APIBuilder,
        setting_engine::{SctpMaxMessageSize, SettingEngine},
    },
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
                    || message.data.len() > protocol::MAX_CLIENT_MESSAGE
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
        let data = bytes::Bytes::from(message);
        self.hub.trace.record(
            self.hub.now(),
            Event::Packet {
                peer: self.id,
                channel: if control { "reliable" } else { "unreliable" },
                action: "send",
                data: data.clone(),
                buffered_bytes: buffered,
            },
        );
        timeout(Duration::from_secs(2), dc.send(&data))
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
        if let Message::Subscribe(request) = &message {
            let sample = self.hub.latest.lock().unwrap().clone();
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
        let mut tracking: Option<Arc<RTCDataChannel>> = None;
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
                        let message = protocol::decode_client(&bytes)?;
                        if let Some((catalog, state)) = session.as_mut() {
                            for reply in self.handle_control(catalog, state, message)? {
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
            let sample = self.hub.latest.lock().unwrap().clone();
            let Some(sample) = sample else {
                continue;
            };
            if !self.hub.available.load(Ordering::SeqCst) {
                for id in session.active.keys().copied().collect::<Vec<_>>() {
                    for reply in session.end(id, "Device acquisition stopped") {
                        self.send(control.as_ref().unwrap(), protocol::encode(&reply), true)
                            .await?;
                    }
                }
                continue;
            }
            // Recenter keeps the selected space; wait for an acquisition in its new origin.
            if sample.reference_version != *self.hub.reference_version.lock().unwrap() {
                continue;
            }
            // Acquisition can advance after due-slot bookkeeping; validate the copied sample now.
            let sampled_at = self.hub.now();
            catalog.refresh_skeleton(&self.hub, &sample);
            let mut ended = Vec::new();
            for subscription in session.active.values_mut() {
                if !due.contains(&subscription.request.id) {
                    continue;
                }
                let Some(timestamp) = subscription.timestamp(sample.acquired_at, sampled_at) else {
                    continue;
                };
                // Skip superseded acquisitions under congestion; never retain a tracking backlog.
                let packet = match catalog.publication(&subscription.request, &sample, timestamp) {
                    Ok(packet) => packet,
                    Err(reason) => {
                        ended.push((subscription.request.id, reason));
                        continue;
                    }
                };
                if !subscription.should_publish(&packet) {
                    continue;
                }
                let reliable = subscription.request.delivery == 2;
                let channel = if reliable {
                    control.as_ref().unwrap()
                } else {
                    dc
                };
                let framed = protocol::encode(&Message::Publication(packet.clone()));
                if !reliable && !tracking_fits(channel.buffered_amount().await, framed.len()) {
                    continue;
                }
                self.send(channel, framed, reliable).await?;
                subscription.published(&packet);
            }
            for (id, reason) in ended {
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
    let message_limit = if remote_limit == 0 {
        protocol::MAX_SERVER_MESSAGE
    } else {
        (remote_limit as usize).min(protocol::MAX_SERVER_MESSAGE)
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
    let mut settings = SettingEngine::default();
    settings.set_sctp_max_message_size_can_send(SctpMaxMessageSize::Bounded(
        protocol::MAX_SERVER_MESSAGE as u32,
    ));
    // 0.17 retains remote DCEP reliability settings and avoids the 0.21 negotiated-channel race.
    let pc = Arc::new(
        APIBuilder::new()
            .with_setting_engine(settings)
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
    #[tokio::test]
    async fn capabilities_above_64k_arrive_as_one_webrtc_message() {
        use webrtc::data_channel::data_channel_init::RTCDataChannelInit;

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
            next_peer: AtomicU64::new(1),
            slots: Arc::new(Semaphore::new(4)),
            shutdown,
            hub,
        });
        // This test peer supplies a larger receive buffer, like the browser.
        let mut settings = SettingEngine::default();
        settings.detach_data_channels();
        let client = APIBuilder::new()
            .with_setting_engine(settings)
            .build()
            .new_peer_connection(RTCConfiguration::default())
            .await
            .unwrap();
        let (opened, mut channels) = mpsc::channel(2);
        for control in [true, false] {
            let dc = client
                .create_data_channel(
                    if control { "reliable" } else { "unreliable" },
                    Some(RTCDataChannelInit {
                        protocol: Some("xrop".into()),
                        ordered: Some(control),
                        max_retransmits: if control { None } else { Some(0) },
                        ..Default::default()
                    }),
                )
                .await
                .unwrap();
            let channel = dc.clone();
            let opened = opened.clone();
            dc.on_open(Box::new(move || {
                Box::pin(async move {
                    opened
                        .send((control, channel.detach().await.unwrap()))
                        .await
                        .unwrap();
                })
            }));
        }
        let exchange = async {
            let mut gathered = client.gathering_complete_promise().await;
            client
                .set_local_description(client.create_offer(None).await.unwrap())
                .await
                .unwrap();
            gathered.recv().await;
            let sdp = client.local_description().await.unwrap().sdp;
            let description =
                RTCSessionDescription::offer(format!("{sdp}a=max-message-size:262144\r\n"))
                    .unwrap();
            let Json(answer) = offer(State(server.clone()), HeaderMap::new(), Json(description))
                .await
                .unwrap();
            client.set_remote_description(answer).await.unwrap();
            let first = channels.recv().await.unwrap();
            let second = channels.recv().await.unwrap();
            let (reliable, unreliable) = if first.0 {
                (first.1, second.1)
            } else {
                (second.1, first.1)
            };
            reliable
                .write_data_channel(&protocol::encode(&Message::Offer(vec![1])).into(), false)
                .await
                .unwrap();
            let mut buffer = vec![0; protocol::MAX_SERVER_MESSAGE];
            let (size, text) = reliable.read_data_channel(&mut buffer).await.unwrap();
            assert!(!text);
            assert_eq!(&buffer[..size], &[2, 1, 0]);
            let (size, text) = reliable.read_data_channel(&mut buffer).await.unwrap();
            assert!(!text);
            assert_eq!(&buffer[..size], expected);
            unreliable
                .write_data_channel(&bytes::Bytes::from_static(&[10, 1, 0, 0, 0]), false)
                .await
                .unwrap();
            let (size, _) = unreliable.read_data_channel(&mut buffer).await.unwrap();
            assert_eq!(size, 21);
            assert_eq!(&buffer[..5], &[11, 1, 0, 0, 0]);
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
            id: 1,
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
        hub.acquire(&poses, &inputs, None, 100, None);
        let active = catalog
            .capabilities
            .descriptors
            .iter()
            .position(|d| d.id == "/user/hand/left/input/x/click/active")
            .unwrap() as u32;
        let status = Request {
            id: 2,
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
        hub.acquire(&poses, &inputs, None, 101, None);
        let replacement = Request {
            id: 1,
            ..status.clone()
        };
        assert!(matches!(
            submit(&peer, &mut catalog, &mut session, replacement)[0],
            Message::Rejected { .. }
        ));
        assert_eq!(session.active[&1].request, head);
        let sample = hub.latest.lock().unwrap().clone().unwrap();
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
        hub.latest.lock().unwrap().as_mut().unwrap().inputs.clear();
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
