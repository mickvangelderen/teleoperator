use crate::{body, inputs};
use crate::{
    protocol::{Connection, MAX_PACKET, finish, wire},
    tracking::{HISTORY, Hub, Kind, RATE, SOURCES, StreamStats},
};
use flatbuffers::{FlatBufferBuilder as Builder, WIPOffset};
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

const DEFAULT_SEND_RATE: f32 = 100.0;
const DEFAULT_HISTORY: u32 = 2;

pub struct Publication {
    pub bytes: Vec<u8>,
    pub skeletons: Vec<Arc<body::Skeleton>>,
}

pub struct Stream {
    pub hub: Arc<Hub>,
    pub kind: Kind,
    pub sources: Vec<usize>,
    pub stats: Arc<StreamStats>,
    pub rate: f32,
    pub history: u32,
    pub next_send: Instant,
    pub last_sample: u64,
}

fn source<'a>(b: &mut Builder<'a>, index: usize) -> WIPOffset<wire::PoseSource<'a>> {
    let name = b.create_string(SOURCES[index]);
    let meaning = b.create_string(if index == 0 {
        "Head pose"
    } else if index % 2 == 1 {
        "Controller aim"
    } else {
        "Controller grip"
    });
    wire::PoseSource::create(
        b,
        &wire::PoseSourceArgs {
            source_id: Some(name),
            meaning: Some(meaning),
            supports_activity: index > 0,
        },
    )
}
fn settings<'a>(b: &mut Builder<'a>, indices: &[usize]) -> WIPOffset<wire::PoseSettings<'a>> {
    let selections: Vec<_> = indices
        .iter()
        .map(|&i| {
            let name = b.create_string(SOURCES[i]);
            wire::PoseSelection::create(
                b,
                &wire::PoseSelectionArgs {
                    source_id: Some(name),
                },
            )
        })
        .collect();
    let selections = b.create_vector(&selections);
    wire::PoseSettings::create(
        b,
        &wire::PoseSettingsArgs {
            sources: Some(selections),
        },
    )
}
fn publication<'a>(
    b: &mut Builder<'a>,
    rate: f32,
    history: u32,
) -> WIPOffset<wire::PublicationSettings<'a>> {
    wire::PublicationSettings::create(
        b,
        &wire::PublicationSettingsArgs {
            send_rate_hz: Some(rate),
            history_length: history,
        },
    )
}
pub fn capabilities(hub: &Hub) -> Vec<u8> {
    let mut b = Builder::new();
    let available = hub.available.load(Ordering::SeqCst);
    let pose = if available {
        let sources: Vec<_> = (0..SOURCES.len()).map(|i| source(&mut b, i)).collect();
        let sources = b.create_vector(&sources);
        Some(wire::PoseCapabilities::create(
            &mut b,
            &wire::PoseCapabilitiesArgs {
                sources: Some(sources),
            },
        ))
    } else {
        None
    };
    let space = wire::ReferenceSpace::create(
        &mut b,
        &wire::ReferenceSpaceArgs {
            id: 1,
            kind: hub.reference_kind(),
        },
    );
    let spaces = b.create_vector(if available {
        std::slice::from_ref(&space)
    } else {
        &[]
    });
    let defaults = publication(&mut b, DEFAULT_SEND_RATE, DEFAULT_HISTORY);
    let limits = wire::Limits::create(
        &mut b,
        &wire::LimitsArgs {
            min_send_rate_hz: 1.,
            max_send_rate_hz: RATE,
            max_history_length: HISTORY as u32,
            max_tracking_message_bytes: MAX_PACKET as u32,
            max_control_message_bytes: MAX_PACKET as u32,
            max_streams_per_client: 3,
        },
    );
    let controller = available.then(|| inputs::capabilities(&mut b));
    let body = (available && hub.skeleton.lock().unwrap().is_some()).then(|| {
        body::capabilities(
            &mut b,
            hub.body_fidelity.load(Ordering::SeqCst),
            hub.body_calibration.load(Ordering::SeqCst),
        )
    });
    let m = wire::Capabilities::create(
        &mut b,
        &wire::CapabilitiesArgs {
            pose,
            controller,
            body,
            reference_spaces: Some(spaces),
            publication_defaults: Some(defaults),
            limits: Some(limits),
            sample_rate_hz: RATE,
        },
    );
    finish(b, wire::Message::Capabilities, m.as_union_value())
}

type Rejection = (wire::RejectionCode, &'static str);
pub(crate) fn rejected(id: u64, (code, reason): Rejection) -> Vec<u8> {
    let mut b = Builder::new();
    let reason = b.create_string(reason);
    let m = wire::RequestRejected::create(
        &mut b,
        &wire::RequestRejectedArgs {
            request_id: id,
            code,
            reason: Some(reason),
        },
    );
    finish(b, wire::Message::RequestRejected, m.as_union_value())
}
fn closed(request: u64, stream: u64, reason: wire::CloseReason) -> Vec<u8> {
    let mut b = Builder::new();
    let m = wire::StreamClosed::create(
        &mut b,
        &wire::StreamClosedArgs {
            request_id: request,
            stream_id: stream,
            reason,
            detail: None,
        },
    );
    finish(b, wire::Message::StreamClosed, m.as_union_value())
}
fn resolve_publication(p: Option<wire::PublicationSettings<'_>>) -> Result<(f32, u32), Rejection> {
    let rate = p
        .and_then(|p| p.send_rate_hz())
        .unwrap_or(DEFAULT_SEND_RATE);
    let history = p.map_or(DEFAULT_HISTORY, |p| p.history_length());
    if !rate.is_finite()
        || !(1.0..=RATE).contains(&rate)
        || history == 0
        || history > HISTORY as u32
    {
        return Err((
            wire::RejectionCode::UnsupportedSetting,
            "Publication requires 1–200 Hz and history length 1–8",
        ));
    }
    Ok((rate, history))
}

impl Connection {
    pub fn refresh(&mut self) -> Vec<Vec<u8>> {
        if !self.negotiated {
            return vec![];
        }
        let available = self.hub.available.load(Ordering::SeqCst);
        let resumed = self.hub.resumed_at.load(Ordering::SeqCst);
        let mut messages = vec![];
        if resumed != self.resumed_at {
            self.resumed_at = resumed;
            let mut b = Builder::new();
            let m = wire::ServerResumed::create(
                &mut b,
                &wire::ServerResumedArgs {
                    resumed_at: resumed,
                },
            );
            messages.push(finish(b, wire::Message::ServerResumed, m.as_union_value()));
        }
        let body_available = self.hub.skeleton.lock().unwrap().is_some();
        if self.advertised == available && self.advertised_body == body_available {
            return messages;
        }
        self.advertised = available;
        self.advertised_body = body_available;
        messages.push(capabilities(&self.hub));
        self.streams.retain(|stream| {
            let keep = available && (stream.kind != Kind::Body || body_available);
            if !keep {
                messages.push(closed(
                    0,
                    stream.stats.id,
                    wire::CloseReason::CapabilityLost,
                ));
            }
            keep
        });
        messages
    }
    pub fn request_stream(&mut self, packet: wire::Packet<'_>, id: u64) -> Vec<Vec<u8>> {
        match self.change_stream(packet, id) {
            Ok(messages) => messages,
            Err(error) => vec![rejected(id, error)],
        }
    }
    fn change_stream(
        &mut self,
        packet: wire::Packet<'_>,
        id: u64,
    ) -> Result<Vec<Vec<u8>>, Rejection> {
        let unknown = (wire::RejectionCode::UnknownStream, "No such stream");
        let skeleton = self.hub.skeleton.lock().unwrap().clone();
        let requested_id = if packet.message_as_subscribe().is_some() {
            0
        } else if let Some(r) = packet.message_as_update_publication() {
            r.stream_id()
        } else {
            packet.message_as_unsubscribe().ok_or(unknown)?.stream_id()
        };
        let existing = self.streams.iter().position(|s| s.stats.id == requested_id);
        if requested_id != 0 && existing.is_none() {
            return Err(unknown);
        }
        if packet.message_as_unsubscribe().is_some() {
            let stream = self.streams.remove(existing.ok_or(unknown)?);
            return Ok(vec![closed(
                id,
                stream.stats.id,
                wire::CloseReason::Unsubscribed,
            )]);
        }
        let index;
        if let Some(request) = packet.message_as_subscribe() {
            if self.streams.len() >= 3 {
                return Err((
                    wire::RejectionCode::ResourceLimit,
                    "At most three streams per peer",
                ));
            }
            if !self.hub.available.load(Ordering::SeqCst) {
                return Err((
                    wire::RejectionCode::UnsupportedCapability,
                    "Tracking source unavailable",
                ));
            }
            let mut sources = Vec::new();
            let kind;
            if let Some(settings) = request.acquisition_as_pose_settings() {
                kind = Kind::Pose;
                let requested = settings.sources();
                if requested.is_empty() || requested.len() > 64 {
                    return Err((
                        wire::RejectionCode::InvalidRequest,
                        "Invalid pose selection count",
                    ));
                }
                let mut names = std::collections::HashSet::new();
                for s in requested {
                    if s.source_id().len() > 256 || !names.insert(s.source_id()) {
                        return Err((
                            wire::RejectionCode::InvalidRequest,
                            "Invalid or duplicate pose selection",
                        ));
                    }
                    let index = SOURCES
                        .iter()
                        .position(|name| *name == s.source_id())
                        .ok_or((
                            wire::RejectionCode::UnsupportedCapability,
                            "Unknown pose source",
                        ))?;
                    sources.push(index);
                }
            } else if let Some(settings) = request.acquisition_as_controller_settings() {
                kind = Kind::Controller;
                let selections = settings.inputs();
                if selections.is_empty() || selections.len() > 128 {
                    return Err((
                        wire::RejectionCode::InvalidRequest,
                        "Invalid controller selection count",
                    ));
                }
                let definitions = inputs::definitions();
                let mut seen = std::collections::HashSet::new();
                for s in selections {
                    if s.source_id().len() > 256
                        || s.input_id().len() > 256
                        || !seen.insert((s.source_id(), s.input_id()))
                    {
                        return Err((
                            wire::RejectionCode::InvalidRequest,
                            "Invalid or duplicate controller selection",
                        ));
                    }
                    let found = definitions
                        .iter()
                        .position(|d| d.source == s.source_id() && d.id == s.input_id());
                    sources.push(found.ok_or((
                        wire::RejectionCode::UnsupportedCapability,
                        "Unknown controller input",
                    ))?);
                }
            } else if let Some(settings) = request.acquisition_as_body_settings() {
                kind = Kind::Body;
                if skeleton.is_none() || settings.source_id() != body::SOURCE {
                    return Err((
                        wire::RejectionCode::UnsupportedCapability,
                        "Body tracker unavailable",
                    ));
                }
                if settings.joint_set() != body::JOINT_SET {
                    return Err((
                        wire::RejectionCode::UnsupportedSetting,
                        "Unsupported body joint set",
                    ));
                }
            } else {
                return Err((
                    wire::RejectionCode::UnsupportedCapability,
                    "Unsupported acquisition kind",
                ));
            }
            if sources.is_empty() && kind != Kind::Body {
                return Err((
                    wire::RejectionCode::UnsupportedCapability,
                    "No selected pose sources available",
                ));
            }
            sources.sort_unstable();
            let (rate, history) = resolve_publication(request.publication())?;
            let stats = self.hub.stream_stats();
            let stream = Stream {
                hub: self.hub.clone(),
                kind,
                sources,
                stats,
                rate,
                history,
                next_send: Instant::now(),
                last_sample: 0,
            };
            index = self.streams.len();
            self.streams.push(stream);
        } else if let Some(request) = packet.message_as_update_publication() {
            index = existing.ok_or(unknown)?;
            let stream = &mut self.streams[index];
            let (rate, history) = resolve_publication(Some(request.publication()))?;
            stream.rate = rate;
            stream.history = history;
            stream.next_send = Instant::now();
        } else {
            return Err(unknown);
        }
        let stream = &self.streams[index];
        let version = *self.hub.reference_version.lock().unwrap();
        let mut replies = Vec::new();
        if stream.kind == Kind::Body {
            replies.push(body::definition(skeleton.as_ref().ok_or((
                wire::RejectionCode::UnsupportedCapability,
                "Body tracker unavailable",
            ))?));
        }
        replies.push(stream.accepted(id, version, skeleton.as_deref()));
        Ok(replies)
    }
}

impl Stream {
    fn accepted(&self, request: u64, version: u32, skeleton: Option<&body::Skeleton>) -> Vec<u8> {
        let mut b = Builder::new();
        let (acquisition_type, acquisition, sources, inputs) = match self.kind {
            Kind::Body => (
                wire::Acquisition::BodySettings,
                body::settings(&mut b).as_union_value(),
                None,
                None,
            ),
            Kind::Pose => {
                let acquisition = settings(&mut b, &self.sources).as_union_value();
                let sources: Vec<_> = self.sources.iter().map(|&i| source(&mut b, i)).collect();
                (
                    wire::Acquisition::PoseSettings,
                    acquisition,
                    Some(b.create_vector(&sources)),
                    None,
                )
            }
            Kind::Controller => {
                let acquisition = inputs::settings(&mut b, &self.sources).as_union_value();
                let definitions = inputs::definitions();
                let inputs: Vec<_> = self
                    .sources
                    .iter()
                    .map(|&i| inputs::definition(&mut b, &definitions[i]))
                    .collect();
                (
                    wire::Acquisition::ControllerSettings,
                    acquisition,
                    None,
                    Some(b.create_vector(&inputs)),
                )
            }
        };
        let descriptor = wire::StreamDescriptor::create(
            &mut b,
            &wire::StreamDescriptorArgs {
                acquisition_type,
                acquisition: Some(acquisition),
                pose_sources: sources,
                inputs,
                initial_reference_space: (self.kind != Kind::Controller)
                    .then_some(&wire::MetadataRef::new(1, version)),
                initial_skeleton: (self.kind == Kind::Body)
                    .then(|| wire::MetadataRef::new(2, skeleton.unwrap().version))
                    .as_ref(),
            },
        );
        let publication = publication(&mut b, self.rate, self.history);
        let m = wire::StreamAccepted::create(
            &mut b,
            &wire::StreamAcceptedArgs {
                request_id: request,
                stream_id: self.stats.id,
                descriptor: Some(descriptor),
                publication: Some(publication),
            },
        );
        finish(b, wire::Message::StreamAccepted, m.as_union_value())
    }
    pub fn due(&mut self) -> bool {
        let now = Instant::now();
        if now < self.next_send {
            return false;
        }
        // Acquisition may finish just after this tick; keep this slot until a new sample exists.
        if self.hub.samples.lock().unwrap().back().is_none_or(|s| {
            s.number == self.last_sample || self.kind == Kind::Body && s.body.is_none()
        }) {
            return false;
        }
        let period = Duration::from_secs_f32(1.0 / self.rate);
        self.next_send += period;
        if self.next_send <= now {
            self.next_send = now + period;
        }
        true
    }
    pub fn packet(&mut self) -> Option<Publication> {
        let samples = self.hub.samples.lock().unwrap();
        let latest = samples.back()?;
        if latest.number == self.last_sample || self.kind == Kind::Body && latest.body.is_none() {
            return None;
        }
        self.last_sample = latest.number;
        let mut b = Builder::new();
        let count = samples
            .iter()
            .rev()
            .take(self.history as usize)
            .take_while(|s| self.kind != Kind::Body || s.body.is_some())
            .count();
        let samples: Vec<_> = samples.iter().skip(samples.len() - count).collect();
        let mut skeletons = Vec::new();
        let (history_type, history) = if self.kind == Kind::Controller {
            let history: Vec<_> = samples
                .iter()
                .map(|s| {
                    let values: Vec<_> = self
                        .sources
                        .iter()
                        .map(|&i| inputs::value(&mut b, &s.inputs[i]))
                        .collect();
                    let values = b.create_vector(&values);
                    wire::ControllerSample::create(
                        &mut b,
                        &wire::ControllerSampleArgs {
                            sample_number: s.number,
                            acquired_at: s.acquired_at,
                            values: Some(values),
                        },
                    )
                })
                .collect();
            let history = b.create_vector(&history);
            (
                wire::Samples::ControllerSamples,
                wire::ControllerSamples::create(
                    &mut b,
                    &wire::ControllerSamplesArgs {
                        samples: Some(history),
                    },
                )
                .as_union_value(),
            )
        } else if self.kind == Kind::Body {
            let history: Vec<_> = samples
                .iter()
                .map(|s| {
                    let body = s.body.as_ref().unwrap();
                    if !skeletons
                        .iter()
                        .any(|old: &Arc<body::Skeleton>| old.version == body.skeleton.version)
                    {
                        skeletons.push(body.skeleton.clone());
                    }
                    let joints: Vec<_> = body
                        .joints
                        .iter()
                        .map(|p| {
                            wire::JointPose::new(
                                &body::transform(p),
                                wire::LocationFlags::from_bits_retain(p.flags),
                            )
                        })
                        .collect();
                    let joints = b.create_vector(&joints);
                    wire::BodySample::create(
                        &mut b,
                        &wire::BodySampleArgs {
                            sample_number: s.number,
                            acquired_at: s.acquired_at,
                            target_at: s.target_at,
                            returned_at: body.returned_at,
                            reference_space_version: s.reference_version,
                            skeleton_version: body.skeleton.version,
                            is_active: body.active,
                            confidence: body.confidence,
                            actual_fidelity: body.fidelity,
                            calibration_status: body.calibration,
                            joints: Some(joints),
                        },
                    )
                })
                .collect();
            let history = b.create_vector(&history);
            (
                wire::Samples::BodySamples,
                wire::BodySamples::create(
                    &mut b,
                    &wire::BodySamplesArgs {
                        samples: Some(history),
                    },
                )
                .as_union_value(),
            )
        } else {
            let history: Vec<_> = samples
                .iter()
                .map(|s| {
                    let poses: Vec<_> = self
                        .sources
                        .iter()
                        .map(|&i| {
                            let p = &s.poses[i];
                            let location = wire::JointPose::new(
                                &body::transform(p),
                                wire::LocationFlags::from_bits_retain(p.flags),
                            );
                            wire::PoseValue::create(
                                &mut b,
                                &wire::PoseValueArgs {
                                    location: Some(&location),
                                    is_active: p.active,
                                },
                            )
                        })
                        .collect();
                    let poses = b.create_vector(&poses);
                    wire::PoseSample::create(
                        &mut b,
                        &wire::PoseSampleArgs {
                            sample_number: s.number,
                            acquired_at: s.acquired_at,
                            target_at: s.target_at,
                            reference_space_version: s.reference_version,
                            poses: Some(poses),
                        },
                    )
                })
                .collect();
            let history = b.create_vector(&history);
            let history = wire::PoseSamples::create(
                &mut b,
                &wire::PoseSamplesArgs {
                    samples: Some(history),
                },
            );
            (wire::Samples::PoseSamples, history.as_union_value())
        };
        let m = wire::Tracking::create(
            &mut b,
            &wire::TrackingArgs {
                stream_id: self.stats.id,
                message_number: self
                    .stats
                    .sent
                    .load(Ordering::SeqCst)
                    .checked_add(1)
                    .expect("Message counter exhausted"),
                history_type,
                history: Some(history),
            },
        );
        Some(Publication {
            bytes: finish(b, wire::Message::Tracking, m.as_union_value()),
            skeletons,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{protocol::packet, tracking::Pose};
    #[test]
    fn reference_metadata_identifies_runtime_floor_or_local_fallback() {
        for (floor, kind) in [
            (true, wire::ReferenceSpaceKind::LocalFloor),
            (false, wire::ReferenceSpaceKind::Local),
        ] {
            let hub = Hub::new("test");
            hub.local_floor.store(floor, Ordering::SeqCst);
            hub.set_available(true);
            let bytes = capabilities(&hub);
            let p = packet(&bytes).unwrap();
            let space = p
                .message_as_capabilities()
                .unwrap()
                .reference_spaces()
                .get(0);
            assert_eq!(space.kind(), kind);
            assert_eq!(space.id(), 1);
        }
    }

    fn request(id: u64, sources: &[&str], rate: Option<f32>, history: u32) -> Vec<u8> {
        let mut b = Builder::new();
        let sources: Vec<_> = sources
            .iter()
            .map(|name| {
                let name = b.create_string(name);
                wire::PoseSelection::create(
                    &mut b,
                    &wire::PoseSelectionArgs {
                        source_id: Some(name),
                    },
                )
            })
            .collect();
        let sources = b.create_vector(&sources);
        let acquisition = wire::PoseSettings::create(
            &mut b,
            &wire::PoseSettingsArgs {
                sources: Some(sources),
            },
        );
        let publication = rate.map(|r| publication(&mut b, r, history));
        let request = wire::Subscribe::create(
            &mut b,
            &wire::SubscribeArgs {
                request_id: id,
                acquisition_type: wire::Acquisition::PoseSettings,
                acquisition: Some(acquisition.as_union_value()),
                publication,
            },
        );
        finish(b, wire::Message::Subscribe, request.as_union_value())
    }
    #[test]
    fn defaults_use_200_hz_acquisition_and_100_hz_two_sample_publication() {
        let hub = Hub::new("test");
        hub.set_available(true);
        let bytes = capabilities(&hub);
        let advertised = packet(&bytes).unwrap().message_as_capabilities().unwrap();
        assert_eq!(advertised.sample_rate_hz(), 200.);
        assert_eq!(advertised.limits().max_send_rate_hz(), 200.);
        assert_eq!(advertised.publication_defaults().send_rate_hz(), Some(100.));
        assert_eq!(advertised.publication_defaults().history_length(), 2);

        let mut c = Connection::with_hub(wire::SessionId::new(1, 2), hub.clone());
        c.negotiated = true;
        c.control(&request(1, &["head"], None, 1)).unwrap();
        assert_eq!((c.streams[0].rate, c.streams[0].history), (100., 2));
        let poses = std::array::from_fn(|_| Pose::default());
        for at in [0, 5_000_000, 10_000_000] {
            hub.acquire(&poses, &[], None, at, None);
        }
        let bytes = c.streams[0].packet().unwrap().bytes;
        let tracking = packet(&bytes).unwrap().message_as_tracking().unwrap();
        let samples = tracking.history_as_pose_samples().unwrap().samples();
        assert_eq!(samples.len(), 2);
        assert_eq!(samples.get(0).sample_number(), 2);
        assert_eq!(samples.get(1).sample_number(), 3);

        c.control(&request(2, &["head"], Some(200.), 2)).unwrap();
        assert_eq!(c.streams[1].rate, 200.);
        let rejected = c.control(&request(3, &["head"], Some(201.), 2)).unwrap();
        assert!(
            packet(&rejected[0])
                .unwrap()
                .message_as_request_rejected()
                .is_some()
        );
        assert_eq!(c.streams[1].rate, 200.);
    }

    #[test]
    fn selection_validation_preserves_previous_stream() {
        let hub = Hub::new("test");
        hub.set_available(true);
        let mut a = Connection::with_hub(wire::SessionId::new(1, 2), hub.clone());
        a.negotiated = true;
        let mut b = Connection::with_hub(wire::SessionId::new(1, 2), hub);
        b.negotiated = true;
        let responses = a
            .control(&request(1, &["right/grip", "head"], Some(30.), 4))
            .unwrap();
        let accepted = packet(responses.last().unwrap())
            .unwrap()
            .message_as_stream_accepted()
            .unwrap();
        assert_eq!(
            accepted
                .descriptor()
                .pose_sources()
                .unwrap()
                .get(0)
                .source_id(),
            "head"
        );
        b.control(&request(1, &["head", "right/grip"], None, 1))
            .unwrap();
        assert_eq!(
            a.streams.first().unwrap().sources,
            b.streams.first().unwrap().sources
        );
        for (sources, rate, history) in [
            (vec!["head", "head"], 100., 1),
            (vec!["missing"], 100., 1),
            (vec!["head"], f32::NAN, 1),
            (vec!["head"], 0., 1),
            (vec!["head"], 100., 9),
        ] {
            let response = a.request_stream(
                packet(&request(2, &sources, Some(rate), history)).unwrap(),
                2,
            );
            assert!(
                packet(&response[0])
                    .unwrap()
                    .message_as_request_rejected()
                    .is_some()
            );
            assert_eq!(a.streams.first().unwrap().rate, 30.);
        }
    }
    #[test]
    fn subscribe_creates_another_stream_and_publication_replacement_uses_defaults() {
        let hub = Hub::new("test");
        hub.set_available(true);
        let mut c = Connection::with_hub(wire::SessionId::new(1, 2), hub);
        c.negotiated = true;
        c.control(&request(1, &["head"], Some(30.), 4)).unwrap();
        let original = c.streams[0].stats.id;
        c.control(&request(2, &["left/aim"], None, 1)).unwrap();
        assert_ne!(original, c.streams[1].stats.id);
        assert_eq!(c.streams[0].sources, [0]);
        let mut b = Builder::new();
        let p = wire::PublicationSettings::create(&mut b, &Default::default());
        let update = wire::UpdatePublication::create(
            &mut b,
            &wire::UpdatePublicationArgs {
                request_id: 3,
                stream_id: original,
                publication: Some(p),
            },
        );
        c.control(&finish(
            b,
            wire::Message::UpdatePublication,
            update.as_union_value(),
        ))
        .unwrap();
        assert_eq!(
            (c.streams[0].rate, c.streams[0].history),
            (DEFAULT_SEND_RATE, 1)
        );
    }

    #[test]
    fn publication_waits_for_fresh_acquisition_but_never_for_full_history() {
        let hub = Hub::new("test");
        hub.set_available(true);
        let mut c = Connection::with_hub(wire::SessionId::new(1, 2), hub.clone());
        c.negotiated = true;
        c.control(&request(1, &["head"], Some(100.), 8)).unwrap();
        let stream = &mut c.streams[0];
        let deadline = Instant::now() - Duration::from_millis(10);
        stream.next_send = deadline;
        assert!(!stream.due());
        assert_eq!(stream.next_send, deadline);
        let poses = std::array::from_fn(|_| Pose::default());
        hub.acquire(&poses, &[], None, 1, None);
        assert!(stream.due());
        let bytes = stream.packet().unwrap().bytes;
        assert_eq!(
            packet(&bytes)
                .unwrap()
                .message_as_tracking()
                .unwrap()
                .history_as_pose_samples()
                .unwrap()
                .samples()
                .len(),
            1
        );
        stream.next_send = deadline;
        assert!(!stream.due());
        assert_eq!(stream.next_send, deadline);
        hub.acquire(&poses, &[], None, 2, None);
        assert!(stream.due());
        let bytes = stream.packet().unwrap().bytes;
        assert_eq!(
            packet(&bytes)
                .unwrap()
                .message_as_tracking()
                .unwrap()
                .history_as_pose_samples()
                .unwrap()
                .samples()
                .len(),
            2
        );
    }

    #[test]
    fn skipped_publications_do_not_consume_message_numbers_and_history_is_consecutive() {
        let hub = Hub::new("test");
        hub.set_available(true);
        let mut c = Connection::with_hub(wire::SessionId::new(1, 2), hub.clone());
        c.negotiated = true;
        c.control(&request(1, &["head"], Some(100.), 4)).unwrap();
        let poses = std::array::from_fn(|_| Pose::default());
        for n in 0..10 {
            hub.acquire(&poses, &[], None, n, None);
        }
        let stream = c.streams.first_mut().unwrap();
        let bytes = stream.packet().unwrap().bytes;
        let p = packet(&bytes).unwrap().message_as_tracking().unwrap();
        assert_eq!(p.message_number(), 1);
        let samples = p.history_as_pose_samples().unwrap().samples();
        assert_eq!(
            samples
                .iter()
                .map(|s| s.sample_number())
                .collect::<Vec<_>>(),
            [7, 8, 9, 10]
        );
        // A packet prepared but not accepted by transport does not advance the counter.
        hub.acquire(&poses, &[], None, 10, None);
        let bytes = stream.packet().unwrap().bytes;
        assert_eq!(
            packet(&bytes)
                .unwrap()
                .message_as_tracking()
                .unwrap()
                .message_number(),
            1
        );
        stream.stats.sent.fetch_add(1, Ordering::SeqCst);
        hub.acquire(&poses, &[], None, 11, None);
        let bytes = stream.packet().unwrap().bytes;
        assert_eq!(
            packet(&bytes)
                .unwrap()
                .message_as_tracking()
                .unwrap()
                .message_number(),
            2
        );
        assert!(stream.packet().is_none());
        hub.set_available(false);
        c.advertised = true;
        assert_eq!(c.refresh().len(), 2);
        assert!(c.streams.is_empty());
    }

    #[test]
    fn simultaneous_pose_and_controller_streams_preserve_shared_transition_counts() {
        let hub = Hub::new("test");
        hub.set_available(true);
        let mut a = Connection::with_hub(wire::SessionId::new(1, 2), hub.clone());
        a.negotiated = true;
        let mut b = Connection::with_hub(wire::SessionId::new(1, 2), hub.clone());
        b.negotiated = true;
        let definitions = inputs::definitions();
        let index = definitions
            .iter()
            .position(|d| d.source == "left" && d.id == "primary/click")
            .unwrap();
        let mut builder = Builder::new();
        let settings = inputs::settings(&mut builder, &[index]);
        let message = wire::Subscribe::create(
            &mut builder,
            &wire::SubscribeArgs {
                request_id: 2,
                acquisition_type: wire::Acquisition::ControllerSettings,
                acquisition: Some(settings.as_union_value()),
                ..Default::default()
            },
        );
        let subscribe = finish(builder, wire::Message::Subscribe, message.as_union_value());
        a.control(&request(1, &["head"], None, 1)).unwrap();
        a.control(&subscribe).unwrap();
        b.control(&subscribe).unwrap();
        assert_eq!(a.streams.len(), 2);
        assert!(Arc::ptr_eq(&a.streams[1].hub, &b.streams[0].hub));
        let mut values: Vec<_> = definitions
            .iter()
            .map(|d| inputs::Input::inactive(d.kind))
            .collect();
        let poses = std::array::from_fn(|_| Pose::default());
        for (n, value) in [false, true, false, true, false].into_iter().enumerate() {
            values[index] = inputs::Input {
                active: true,
                changed_at: Some(0),
                value: inputs::Value::Boolean {
                    value,
                    presses: 0,
                    releases: 0,
                },
            };
            hub.acquire(&poses, &values, None, n as i64, None);
        }
        for stream in [&mut a.streams[1], &mut b.streams[0]] {
            let bytes = stream.packet().unwrap().bytes;
            let p = packet(&bytes).unwrap().message_as_tracking().unwrap();
            let samples = p.history_as_controller_samples().unwrap().samples();
            assert_eq!(samples.len(), 2);
            let sample = samples.get(samples.len() - 1);
            let input = sample.values().get(0);
            let value = input.value_as_boolean_value().unwrap();
            assert_eq!((value.press_count(), value.release_count()), (2, 2));
            assert!(!value.value());
            assert_eq!(input.last_change_at(), Some(0));
            assert_eq!(sample.sample_number(), 5);
        }
    }

    #[test]
    fn late_joining_selections_share_tick_and_physical_counters() {
        let hub = Hub::new("test");
        let definitions = inputs::definitions();
        let index = definitions
            .iter()
            .position(|d| d.id == "primary/click")
            .unwrap();
        let poses = std::array::from_fn(|i| Pose {
            position: [i as f32, 0., 0.],
            ..Default::default()
        });
        let mut values: Vec<_> = definitions
            .iter()
            .map(|d| inputs::Input::inactive(d.kind))
            .collect();
        for (n, value) in [false, true, false, true].into_iter().enumerate() {
            values[index] = inputs::Input {
                active: true,
                changed_at: None,
                value: inputs::Value::Boolean {
                    value,
                    presses: 0,
                    releases: 0,
                },
            };
            hub.acquire(&poses, &values, None, n as i64, None);
        }
        let stream = |kind, sources| Stream {
            hub: hub.clone(),
            kind,
            sources,
            stats: hub.stream_stats(),
            rate: RATE,
            history: 1,
            next_send: Instant::now(),
            last_sample: 0,
        };
        for sources in [vec![index], vec![index, index + 1]] {
            let bytes = stream(Kind::Controller, sources).packet().unwrap().bytes;
            let packet = packet(&bytes).unwrap().message_as_tracking().unwrap();
            let sample = packet
                .history_as_controller_samples()
                .unwrap()
                .samples()
                .get(0);
            let value = sample.values().get(0).value_as_boolean_value().unwrap();
            assert_eq!((sample.sample_number(), sample.acquired_at()), (4, 3));
            assert_eq!((value.press_count(), value.release_count()), (2, 1));
        }
        let bytes = stream(Kind::Pose, vec![4]).packet().unwrap().bytes;
        let packet = packet(&bytes).unwrap().message_as_tracking().unwrap();
        let pose = packet.history_as_pose_samples().unwrap().samples().get(0);
        assert_eq!(pose.sample_number(), 4);
        assert_eq!(
            pose.poses().get(0).location().transform().position().x(),
            4.
        );
    }

    #[test]
    fn body_history_stops_at_capability_gaps() {
        let hub = Hub::new("test");
        let poses = std::array::from_fn(|_| Pose::default());
        let body = body::Body::inactive(body::synthetic_skeleton());
        for (n, sample) in [Some(&body), None, Some(&body), Some(&body)]
            .into_iter()
            .enumerate()
        {
            hub.acquire(&poses, &[], sample, n as i64, None);
        }
        let mut stream = Stream {
            hub: hub.clone(),
            kind: Kind::Body,
            sources: vec![],
            stats: hub.stream_stats(),
            rate: RATE,
            history: 8,
            next_send: Instant::now(),
            last_sample: 0,
        };
        let bytes = stream.packet().unwrap().bytes;
        let packet = packet(&bytes).unwrap().message_as_tracking().unwrap();
        let samples = packet.history_as_body_samples().unwrap().samples();
        assert_eq!(
            samples
                .iter()
                .map(|s| s.sample_number())
                .collect::<Vec<_>>(),
            [3, 4]
        );
        hub.acquire(&poses, &[], None, 4, None);
        assert!(!stream.due());
        assert!(stream.packet().is_none());
    }

    #[test]
    fn body_history_keeps_exact_skeleton_versions_and_loss_only_closes_body() {
        let hub = Hub::new("test");
        hub.set_available(true);
        let skeleton = body::synthetic_skeleton();
        let mut body = body::Body::inactive(skeleton.clone());
        let poses = std::array::from_fn(|_| Pose::default());
        hub.acquire(&poses, &[], Some(&body), 0, None);
        let mut c = Connection::with_hub(wire::SessionId::new(1, 2), hub.clone());
        c.negotiated = true;
        c.control(&request(1, &["head"], None, 1)).unwrap();
        let mut b = Builder::new();
        let settings = body::settings(&mut b);
        let p = publication(&mut b, 100., 8);
        let message = wire::Subscribe::create(
            &mut b,
            &wire::SubscribeArgs {
                request_id: 2,
                acquisition_type: wire::Acquisition::BodySettings,
                acquisition: Some(settings.as_union_value()),
                publication: Some(p),
            },
        );
        let responses = c
            .control(&finish(
                b,
                wire::Message::Subscribe,
                message.as_union_value(),
            ))
            .unwrap();
        assert!(responses.iter().any(|r| {
            packet(r)
                .unwrap()
                .message_as_skeleton_definition()
                .is_some()
        }));
        hub.acquire(&poses, &[], Some(&body), 1, Some(0));
        let mut replacement = (*skeleton).clone();
        replacement.version = 2;
        body.skeleton = Arc::new(replacement);
        hub.acquire(&poses, &[], Some(&body), 2, None);
        let publication = c.streams[1].packet().unwrap();
        assert_eq!(
            publication
                .skeletons
                .iter()
                .map(|s| s.version)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        let p = packet(&publication.bytes)
            .unwrap()
            .message_as_tracking()
            .unwrap();
        let samples = p.history_as_body_samples().unwrap().samples();
        assert_eq!(samples.len(), 3);
        assert_eq!(samples.get(1).target_at(), Some(0));
        assert_eq!(samples.get(2).skeleton_version(), 2);
        assert_eq!(samples.get(1).joints().len(), 70);
        c.advertised = true;
        c.advertised_body = true;
        hub.acquire(&poses, &[], None, 3, None);
        assert_eq!(c.refresh().len(), 2);
        assert_eq!(c.streams.len(), 1);
        assert_eq!(c.streams[0].kind, Kind::Pose);
        assert!(c.refresh().is_empty());
    }
}
