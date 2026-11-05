use crate::protocol::{self, Connection, wire};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use bytes::Bytes;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{Notify, Semaphore, watch},
    time::timeout,
};
use webrtc::{
    api::APIBuilder,
    data_channel::RTCDataChannel,
    peer_connection::{
        configuration::RTCConfiguration, peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription,
    },
};

struct Server {
    session: wire::SessionId,
    started: Instant,
    slots: Arc<Semaphore>,
    shutdown: watch::Receiver<bool>,
}

struct Peer {
    protocol: Mutex<Connection>,
    started: Instant,
    channels: AtomicU8,
    negotiated: AtomicBool,
    close: Notify,
}

impl Peer {
    fn now(&self) -> i64 {
        self.started
            .elapsed()
            .as_nanos()
            .try_into()
            .expect("Monotonic clock exhausted")
    }

    fn attach(self: Arc<Self>, dc: Arc<RTCDataChannel>) {
        let label = dc.label().to_string();
        let control = label == "control";
        let bit = if control { 1 } else { 2 };
        let valid = matches!(label.as_str(), "control" | "tracking")
            && dc.protocol() == "xrop"
            && dc.ordered() == control
            && dc.max_retransmits() == if control { None } else { Some(0) }
            && dc.max_packet_lifetime().is_none();
        if !valid || self.channels.fetch_or(bit, Ordering::SeqCst) & bit != 0 {
            log::warn!("Invalid or duplicate data channel: {label}");
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
        let weak_dc = Arc::downgrade(&dc);
        dc.on_message(Box::new(move |message| {
            let peer = self.clone();
            let weak_dc = weak_dc.clone();
            Box::pin(async move {
                let Some(dc) = weak_dc.upgrade() else {
                    return;
                };
                let received_at = peer.now();
                let replies = if message.is_string {
                    if control {
                        Err("Expected binary control packet")
                    } else {
                        Ok(vec![])
                    }
                } else {
                    let mut protocol = peer.protocol.lock().unwrap();
                    if control {
                        protocol.control(&message.data)
                    } else {
                        Ok(protocol
                            .tracking(&message.data, received_at, || peer.now())
                            .into_iter()
                            .collect())
                    }
                };
                match replies {
                    Ok(replies) => {
                        for reply in replies {
                            if dc.buffered_amount().await > protocol::MAX_PACKET * 2
                                || dc.send(&Bytes::from(reply)).await.is_err()
                            {
                                peer.close.notify_one();
                                return;
                            }
                        }
                        let negotiated = peer.protocol.lock().unwrap().negotiated;
                        peer.negotiated.store(negotiated, Ordering::SeqCst);
                    }
                    Err(error) => {
                        log::warn!("Closing protocol connection: {error}");
                        peer.close.notify_one();
                    }
                }
            })
        }));
    }
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
    if serde_json::to_value(&offer).unwrap()["type"] != "offer" {
        return Err((StatusCode::BAD_REQUEST, "Expected an SDP offer".into()));
    }
    let permit = server.slots.clone().try_acquire_owned().map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "All four peer slots are in use".into(),
        )
    })?;
    let peer = Arc::new(Peer {
        protocol: Mutex::new(Connection::new(server.session)),
        started: server.started,
        channels: AtomicU8::new(0),
        negotiated: AtomicBool::new(false),
        close: Notify::new(),
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
            _ = shutdown.wait_for(|stopped| *stopped) => {},
            _ = async {
                tokio::time::sleep(Duration::from_secs(20)).await;
                if live_peer.negotiated.load(Ordering::SeqCst) && live_peer.channels.load(Ordering::SeqCst) == 3 {
                    std::future::pending::<()>().await;
                }
            } => log::warn!("Peer handshake timed out"),
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
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|e| format!("Session randomness: {e}"))?;
    let low = u64::from_le_bytes(random[..8].try_into().unwrap());
    let high = u64::from_le_bytes(random[8..].try_into().unwrap());
    if low == 0 && high == 0 {
        return Err("Invalid zero session ID".into());
    }
    let server = Arc::new(Server {
        session: wire::SessionId::new(low, high),
        started: Instant::now(),
        slots: Arc::new(Semaphore::new(4)),
        shutdown: shutdown.clone(),
    });
    let router = Router::new().route("/health", get(|| async { Json(serde_json::json!({"application": "XR Operator", "protocol_versions": [1], "tracking": false})) }))
        .route("/offer", post(offer)).layer(DefaultBodyLimit::max(protocol::MAX_PACKET))
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
