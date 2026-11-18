use crate::body::{self, Body, Skeleton};
use crate::inputs::{self, Input};
use std::collections::BTreeMap;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::watch;

pub const RATE: f32 = 200.0;

// Protocol indices follow the independent device acquisition operations.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Group {
    Poses = 0,
    Inputs = 1,
    Body = 2,
    Rest = 3,
}
impl Group {
    pub fn from_index(index: u32) -> Option<Self> {
        [Self::Poses, Self::Inputs, Self::Body, Self::Rest]
            .get(index as usize)
            .copied()
    }
}

pub const SOURCES: [&str; 5] = ["head", "left/aim", "left/grip", "right/aim", "right/grip"];

pub(crate) fn next_deadline(
    previous: Instant,
    period: std::time::Duration,
    now: Instant,
) -> Instant {
    let mut next = previous + period;
    while next <= now {
        next += period;
    }
    next
}

// A lease observes every acquisition, even while its connection is sending or
// backpressured. It retains encoded latest state, never a queue of source snapshots.
struct Demand {
    group: Group,
    request: crate::protocol::Request,
    catalog: crate::publication::Catalog,
    publication: Arc<Mutex<crate::protocol::PublicationState>>,
}
#[derive(Default)]
struct Demands {
    next_id: u64,
    entries: BTreeMap<u64, Demand>,
}
pub struct SubscriptionSamples {
    hub: Arc<Hub>,
    id: u64,
}
impl Drop for SubscriptionSamples {
    fn drop(&mut self) {
        self.hub.demands.lock().unwrap().entries.remove(&self.id);
    }
}
pub(crate) struct Acquisition {
    pub group: Group,
    pub target_at: Option<i64>,
    recipients: Vec<u64>,
}
impl Acquisition {
    #[cfg(target_os = "android")]
    pub fn background(group: Group) -> Self {
        Self {
            group,
            target_at: None,
            recipients: Vec::new(),
        }
    }
}

// Both clocks count nanoseconds, but their origins differ. Keep conversions signed
// and checked: XR may return a different time from the requested prediction target.
#[cfg(any(target_os = "android", test))]
pub(crate) struct ClockMapping {
    pub server_at: i64,
    pub runtime_at: i64,
}
#[cfg(any(target_os = "android", test))]
impl ClockMapping {
    pub fn to_runtime(&self, server: i64) -> Option<i64> {
        i64::try_from(self.runtime_at as i128 + server as i128 - self.server_at as i128)
            .ok()
            .filter(|t| *t > 0)
    }
    pub fn to_server(&self, runtime: i64) -> Option<i64> {
        i64::try_from(self.server_at as i128 + runtime as i128 - self.runtime_at as i128)
            .ok()
            .filter(|t| *t >= 0)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Pose {
    pub position: [f32; 3],
    pub orientation: [f32; 4],
    pub flags: u16,
    pub active: Option<bool>,
}

#[derive(Clone, Debug)]
pub struct Sample {
    pub number: u64,
    pub acquired_at: i64,
    pub target_at: Option<i64>,
    pub reference_version: u32,
    pub poses: Vec<Pose>,
    pub inputs: Vec<Input>,
    pub body: Option<Body>,
}

pub struct Hub {
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    started: Instant,
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub(crate) clock_origin: u64,
    pub source: &'static str,
    pub available: AtomicBool,
    pub initialized: AtomicBool,
    pub body_supported: AtomicBool,
    pub resumed_at: AtomicI64,
    pub skeleton: Mutex<Option<Arc<Skeleton>>>,
    pub body_fidelity: AtomicBool,
    pub body_calibration: AtomicBool,
    // Selected before tracking becomes available; immutable for this server session.
    pub local_floor: AtomicBool,
    next_skeleton: AtomicU64,
    pub reference_version: Mutex<u32>,
    latest: Mutex<BTreeMap<Group, Arc<Sample>>>,
    next_sample: AtomicU64,
    observed_inputs: Mutex<Vec<Input>>,
    pub updates: watch::Sender<()>,
    demands: Mutex<Demands>,
}

impl Hub {
    pub fn new(source: &'static str) -> Arc<Self> {
        Arc::new(Self {
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            started: Instant::now(),
            #[cfg(any(target_os = "linux", target_os = "android"))]
            clock_origin: crate::deadline::now(),
            source,
            available: AtomicBool::new(false),
            initialized: AtomicBool::new(source == "none"),
            body_supported: AtomicBool::new(false),
            resumed_at: AtomicI64::new(0),
            skeleton: Mutex::new(None),
            body_fidelity: AtomicBool::new(false),
            body_calibration: AtomicBool::new(false),
            local_floor: AtomicBool::new(false),
            next_skeleton: AtomicU64::new(1),
            reference_version: Mutex::new(1),
            latest: Mutex::new(BTreeMap::new()),
            next_sample: AtomicU64::new(1),
            observed_inputs: Mutex::new(Vec::new()),
            updates: watch::channel(()).0,
            demands: Mutex::new(Demands::default()),
        })
    }
    pub fn subscribe(
        self: &Arc<Self>,
        subscription: &crate::protocol::Subscription,
        catalog: &crate::publication::Catalog,
    ) -> SubscriptionSamples {
        self.subscribe_at(subscription, catalog, self.now())
    }
    fn subscribe_at(
        self: &Arc<Self>,
        subscription: &crate::protocol::Subscription,
        catalog: &crate::publication::Catalog,
        now: i64,
    ) -> SubscriptionSamples {
        let group = Group::from_index(subscription.request.group).expect("Advertised group");
        let mut demands = self.demands.lock().unwrap();
        let id = demands.next_id;
        demands.next_id = id
            .checked_add(1)
            .expect("Acquisition subscription ids exhausted");
        let mut demand = Demand {
            group,
            request: subscription.request.clone(),
            catalog: catalog.clone(),
            publication: subscription.publication.clone(),
        };
        if let Some(sample) = self.initial_sample_at(group, now) {
            self.observe(&mut demand, &sample);
        }
        demands.entries.insert(id, demand);
        SubscriptionSamples {
            hub: self.clone(),
            id,
        }
    }
    /// Device-rate observations and publication timing are independent. Timing
    /// requests select prediction targets but never increase acquisition frequency.
    pub(crate) fn acquisitions(&self, now: u64, observe: bool) -> Vec<Acquisition> {
        if !observe {
            return Vec::new();
        }
        let demands = self.demands.lock().unwrap();
        let mut batches = BTreeMap::<(Group, Option<i64>), Vec<u64>>::new();
        for (&id, demand) in &demands.entries {
            let target = demand
                .publication
                .lock()
                .unwrap()
                .requested_target(now)
                .and_then(|t| i64::try_from(t).ok());
            batches.entry((demand.group, target)).or_default().push(id);
        }
        // Observe action edges continuously, even without subscriptions. Inputs
        // have no prediction target, so all leases share one acquisition.
        let inputs: Vec<_> = batches
            .keys()
            .copied()
            .filter(|(group, _)| *group == Group::Inputs)
            .collect();
        let mut recipients = Vec::new();
        for key in inputs {
            recipients.extend(batches.remove(&key).unwrap());
        }
        batches.insert((Group::Inputs, None), recipients);
        batches
            .into_iter()
            .map(|((group, target_at), recipients)| Acquisition {
                group,
                target_at,
                recipients,
            })
            .collect()
    }
    fn observe(&self, demand: &mut Demand, sample: &Sample) {
        if demand.group != Group::Rest
            && sample.reference_version != *self.reference_version.lock().unwrap()
        {
            return;
        }
        demand.catalog.refresh_skeleton(self, sample);
        let acquisition = demand.catalog.encode_acquisition(&demand.request, sample);
        let mut publication = demand.publication.lock().unwrap();
        match acquisition {
            Ok(acquisition) => publication.observe(acquisition),
            Err(error) => publication.error = Some(error),
        }
    }
    pub(crate) fn complete(&self, acquisition: Acquisition, sample: Arc<Sample>) {
        let mut demands = self.demands.lock().unwrap();
        for id in acquisition.recipients {
            if let Some(demand) = demands.entries.get_mut(&id) {
                self.observe(demand, &sample);
            }
        }
        drop(demands);
        self.notify();
    }
    pub fn next_skeleton_version(&self) -> u64 {
        self.next_skeleton.fetch_add(1, Ordering::SeqCst)
    }
    pub fn now(&self) -> i64 {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let elapsed = (crate::deadline::now() - self.clock_origin) as u128;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let elapsed = self.started.elapsed().as_nanos();
        elapsed.try_into().expect("Clock exhausted")
    }
    pub fn set_available(&self, value: bool) {
        self.available.store(value, Ordering::SeqCst);
        if !value {
            self.latest
                .lock()
                .unwrap()
                .retain(|group, _| *group == Group::Rest);
            for demand in self.demands.lock().unwrap().entries.values() {
                demand.publication.lock().unwrap().invalidate_acquisition();
            }
        }
        self.notify();
    }
    pub fn reset_reference(&self) {
        let mut version = self.reference_version.lock().unwrap();
        *version = version.checked_add(1).expect("Reference version exhausted");
        drop(version);
        for demand in self.demands.lock().unwrap().entries.values() {
            demand.publication.lock().unwrap().invalidate_acquisition();
        }
        self.notify();
    }
    pub(crate) fn notify(&self) {
        self.updates.send_replace(());
    }
    pub(crate) fn observe_inputs(&self, inputs: &[Input]) -> Vec<Input> {
        let mut previous = self.observed_inputs.lock().unwrap();
        let mut inputs = inputs.to_vec();
        for (input, old) in inputs.iter_mut().zip(previous.iter()) {
            input.count_from(old);
        }
        *previous = inputs.clone();
        inputs
    }
    pub fn latest(&self, group: Group) -> Option<Sample> {
        self.latest
            .lock()
            .unwrap()
            .get(&group)
            .map(|sample| (**sample).clone())
    }
    /// Dynamic observations can initialize a new lease only within two nominal
    /// acquisition periods. This is an admission/startup cache policy, not expiry
    /// of an active subscription or its requested prediction target. Retained rest
    /// definitions remain usable regardless of age, with their original timestamp.
    pub fn initial_sample(&self, group: Group) -> Option<Sample> {
        self.initial_sample_at(group, self.now())
    }
    fn initial_sample_at(&self, group: Group, now: i64) -> Option<Sample> {
        let sample = self.latest(group)?;
        if group == Group::Rest {
            return Some(sample);
        }
        let freshness = (2e9 / RATE as f64).ceil() as i64;
        (self.available.load(Ordering::SeqCst)
            && sample.reference_version == *self.reference_version.lock().unwrap()
            && now
                .checked_sub(sample.acquired_at)
                .is_some_and(|age| (0..=freshness).contains(&age)))
        .then_some(sample)
    }
    pub fn acquire(
        &self,
        group: Group,
        poses: &[Pose; 5],
        inputs: &[Input],
        body: Option<&Body>,
        acquired_at: i64,
        target_at: Option<i64>,
    ) -> Arc<Sample> {
        // Keep the advertised topology through temporary sample unavailability.
        // Publication values still come from this acquisition's body below.
        if let Some(body) = body {
            *self.skeleton.lock().unwrap() = Some(body.skeleton.clone());
        }
        let (acquired_at, target_at) = match group {
            Group::Poses => (acquired_at, target_at),
            Group::Body => (
                acquired_at,
                body.filter(|b| b.active).and_then(|b| b.returned_at),
            ),
            Group::Inputs => (acquired_at, None),
            Group::Rest => (body.map_or(acquired_at, |b| b.skeleton.acquired_at), None),
        };
        let version = *self.reference_version.lock().unwrap();
        let number = self
            .next_sample
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .expect("Sample counter exhausted");
        let inputs = if group == Group::Inputs {
            self.observe_inputs(inputs)
        } else {
            inputs.to_vec()
        };
        let sample = Arc::new(Sample {
            number,
            acquired_at,
            target_at,
            reference_version: version,
            poses: poses.to_vec(),
            inputs,
            body: body.cloned(),
        });
        self.latest.lock().unwrap().insert(group, sample.clone());
        sample
    }
}

pub async fn synthetic(hub: Arc<Hub>, mut shutdown: watch::Receiver<bool>) {
    hub.body_supported.store(true, Ordering::SeqCst);
    hub.initialized.store(true, Ordering::SeqCst);
    hub.set_available(true);
    hub.body_fidelity.store(true, Ordering::SeqCst);
    hub.body_calibration.store(true, Ordering::SeqCst);
    let mut skeleton = body::synthetic_skeleton();
    Arc::make_mut(&mut skeleton).acquired_at = hub.now();
    *hub.skeleton.lock().unwrap() = Some(skeleton.clone());
    let period = std::time::Duration::from_secs_f32(1.0 / RATE);
    let mut next_observation = Instant::now();
    loop {
        let wait = next_observation.saturating_duration_since(Instant::now());
        tokio::select! {
            _ = shutdown.wait_for(|stopped| *stopped) => break,
            _ = tokio::time::sleep(wait) => {},
        }
        let observe = Instant::now() >= next_observation;
        if observe {
            next_observation = next_deadline(next_observation, period, Instant::now());
        }
        for acquisition in hub.acquisitions(hub.now() as u64, observe) {
            let at = hub.now();
            let target = acquisition.target_at.unwrap_or(at);
            let phase = (target as f64 / 1e9) as f32;
            let poses = std::array::from_fn(|i| Pose {
                position: [
                    if i == 0 {
                        0.0
                    } else if i < 3 {
                        -0.3
                    } else {
                        0.3
                    },
                    if i == 0 { 1.6 } else { 1.1 + phase.sin() * 0.1 },
                    if i == 0 { 0.0 } else { -0.4 },
                ],
                orientation: [0.0, 0.0, 0.0, 1.0],
                flags: 15,
                active: (i > 0).then_some(true),
            });
            let input_phase = (at as f64 / 1e9) as f32;
            let inputs = inputs::definitions()
                .iter()
                .map(|d| Input {
                    active: true,
                    changed_at: None,
                    value: match d.kind {
                        inputs::InputType::Boolean => inputs::Value::Boolean {
                            value: ((input_phase * 2.) as u32).is_multiple_of(2),
                            presses: 0,
                            releases: 0,
                        },
                        inputs::InputType::Scalar => {
                            inputs::Value::Scalar((input_phase.sin() + 1.) / 2.)
                        }
                        inputs::InputType::Vector2 => inputs::Value::Vector2([
                            input_phase.sin() * 0.5,
                            input_phase.cos() * 0.5,
                        ]),
                    },
                })
                .collect::<Vec<_>>();
            let body = Body {
                skeleton: skeleton.clone(),
                active: true,
                confidence: Some(1.),
                returned_at: Some(target),
                fidelity: Some(body::Fidelity::High),
                calibration: Some(body::CalibrationStatus::Valid),
                joints: skeleton
                    .joints
                    .iter()
                    .map(|j| {
                        let mut pose = j.rest.clone();
                        pose.position[2] += phase.sin() * 0.1;
                        pose
                    })
                    .collect(),
            };
            let (at, represented) = match acquisition.group {
                Group::Poses | Group::Body => (at, Some(target)),
                Group::Inputs => (at, None),
                Group::Rest => (skeleton.acquired_at, None),
            };
            let sample = hub.acquire(
                acquisition.group,
                &poses,
                &inputs,
                Some(&body),
                at,
                represented,
            );
            hub.complete(acquisition, sample);
        }
    }
    hub.set_available(false);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clock_conversion_preserves_actual_returned_time_and_checks_signed_limits() {
        let clock = ClockMapping {
            server_at: 50_000_000,
            runtime_at: 9_000_000_000,
        };
        let requested = 80_000_000;
        assert_eq!(clock.to_runtime(requested), Some(9_030_000_000));
        assert_eq!(clock.to_server(9_030_000_000), Some(requested));
        assert_eq!(
            clock.to_server(8_990_000_000),
            Some(40_000_000),
            "A runtime shortfall is not relabelled as the requested target"
        );
        assert_eq!(clock.to_server(8_949_999_999), None);
        assert_eq!(clock.to_runtime(i64::MAX), None);
        assert_eq!(
            ClockMapping {
                server_at: 20,
                runtime_at: 10
            }
            .to_runtime(0),
            None
        );
    }
    #[test]
    fn skeleton_revision_wraps_independently_of_subscriptions() {
        let hub = Hub::new("test");
        hub.next_skeleton.store(u64::MAX, Ordering::SeqCst);
        assert_eq!(hub.next_skeleton_version(), u64::MAX);
        assert_eq!(hub.next_skeleton_version(), 0);
        assert_eq!(hub.next_skeleton_version(), 1);
    }
    #[test]
    fn hub_accumulates_observed_edges_without_any_subscribers() {
        let hub = Hub::new("test");
        let poses = std::array::from_fn(|_| Pose::default());
        for i in 0..12 {
            let input = Input {
                active: true,
                changed_at: None,
                value: inputs::Value::Boolean {
                    value: i % 2 == 1,
                    presses: 0,
                    releases: 0,
                },
            };
            if i == 0 || i == 11 {
                hub.acquire(Group::Inputs, &poses, &[input], None, i, None);
            } else {
                hub.observe_inputs(&[input]);
            }
        }
        let latest = hub.latest(Group::Inputs);
        assert!(matches!(
            latest.as_ref().unwrap().inputs[0].value,
            inputs::Value::Boolean {
                presses: 6,
                releases: 5,
                ..
            }
        ));
    }
    #[test]
    fn deadlines_keep_their_phase_and_skip_missed_slots() {
        use std::time::Duration;
        let start = Instant::now();
        let period = Duration::from_millis(5);
        for (elapsed, expected) in [(1, 5), (5, 10), (16, 20), (1001, 1005)] {
            assert_eq!(
                next_deadline(start, period, start + Duration::from_millis(elapsed)),
                start + Duration::from_millis(expected)
            );
        }
    }

    #[test]
    fn acquisition_retains_the_latest_sample_without_subscribers() {
        let hub = Hub::new("test");
        let poses = std::array::from_fn(|_| Pose::default());
        for i in 0..12 {
            hub.acquire(Group::Poses, &poses, &[], None, i, Some(0));
        }
        let latest = hub.latest(Group::Poses);
        let sample = latest.as_ref().unwrap();
        assert_eq!(sample.number, 12);
        assert_eq!(sample.acquired_at, 11);
        assert_eq!(sample.poses.len(), 5);
    }
    fn subscription_fixture() -> (
        Arc<Hub>,
        crate::publication::Catalog,
        crate::protocol::Session,
    ) {
        use crate::protocol::*;
        let hub = Hub::new("test");
        hub.initialized.store(true, Ordering::SeqCst);
        hub.set_available(true);
        let catalog = crate::publication::Catalog::snapshot(&hub);
        let mut session = Session::new(catalog.capabilities.clone());
        session.handle(Message::Offer(vec![1]), 0).unwrap();
        session
            .handle(
                Message::Subscribe(Request {
                    id: 7,
                    group: 0,
                    channel: 1,
                    interval: 20_000_000,
                    phase: 5_000_000,
                    prediction_offset: 0,
                    sequence_number_format: Some(SequenceNumberFormat::U16),
                    bundles: vec![
                        vec![],
                        vec![SampleBinding {
                            descriptor: 1,
                            format: 1,
                            space: 0,
                        }],
                    ],
                }),
                0,
            )
            .unwrap();
        (hub, catalog, session)
    }
    fn capture(hub: &Hub, at: u64, valid: bool) {
        for work in hub.acquisitions(at, true) {
            if work.group != Group::Poses {
                continue;
            }
            let sample = hub.acquire(
                Group::Poses,
                &std::array::from_fn(|_| Pose {
                    flags: if valid { 2 } else { 0 },
                    ..Default::default()
                }),
                &[],
                None,
                at as i64,
                work.target_at,
            );
            hub.complete(work, sample);
        }
    }
    #[test]
    fn leases_observe_aba_before_ack_without_sender_polling() {
        let (hub, catalog, session) = subscription_fixture();
        let lease = hub.subscribe(&session.active[&7], &catalog);
        let state = session.active[&7].publication.clone();
        assert!(state.lock().unwrap().candidate().is_none());
        capture(&hub, 100, false);
        let first = state.lock().unwrap().candidate().unwrap();
        assert_eq!(first.sequence, Some(0));
        state.lock().unwrap().submitted(first);
        capture(&hub, 101, true);
        capture(&hub, 102, false);
        session.acknowledge(&[13, 7, 0, 0, 0, 0, 0]);
        let retry = state
            .lock()
            .unwrap()
            .candidate()
            .expect("A→B→A remains pending after exact old ACK");
        assert_eq!(retry.sequence, Some(1));
        assert_eq!(&retry.body[4..12], &102u64.to_le_bytes());
        state.lock().unwrap().submitted(retry);
        session.acknowledge(&[13, 7, 0, 0, 0, 1, 0]);
        assert!(state.lock().unwrap().candidate().is_none());
        capture(&hub, 103, false);
        assert!(state.lock().unwrap().candidate().is_none());
        assert!(
            hub.acquisitions(104, false).is_empty(),
            "Publication wakeups do not increase device acquisition rate"
        );
        drop(lease);
        assert!(hub.demands.lock().unwrap().entries.is_empty());
    }
    #[test]
    fn timing_updates_preserve_leases_and_in_flight_observations_replacement_isolated() {
        use crate::protocol::*;
        let (hub, catalog, mut session) = subscription_fixture();
        let mut lease = hub.subscribe(&session.active[&7], &catalog);
        capture(&hub, 100, false);
        let original = session.active[&7].publication.clone();
        assert!(original.lock().unwrap().opportunity(100));
        let candidate = original.lock().unwrap().candidate().unwrap();
        original.lock().unwrap().submitted(candidate);
        let in_flight = hub
            .acquisitions(200, true)
            .into_iter()
            .find(|a| a.group == Group::Poses)
            .unwrap();
        session
            .handle(
                Message::UpdateSchedule {
                    id: 7,
                    timing: Timing {
                        interval: 30_000_000,
                        phase: 3_000_000,
                        prediction_offset: 9_000_000,
                    },
                },
                201,
            )
            .unwrap();
        assert!(Arc::ptr_eq(&original, &session.active[&7].publication));
        assert!(!original.lock().unwrap().opportunity(201));
        assert_eq!(
            original.lock().unwrap().candidate().unwrap().sequence,
            Some(1)
        );
        let sample = hub.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose {
                flags: 2,
                ..Default::default()
            }),
            &[],
            None,
            202,
            None,
        );
        hub.complete(in_flight, sample);
        session.acknowledge(&[13, 7, 0, 0, 0, 0, 0]);
        assert!(
            original.lock().unwrap().candidate().is_some(),
            "Update keeps in-flight acquisitions and supersession"
        );
        let next = hub
            .acquisitions(203, true)
            .into_iter()
            .find(|a| a.group == Group::Poses)
            .unwrap();
        assert_eq!(next.target_at, Some(12_000_000));
        let request = session.active[&7].request.clone();
        assert_eq!(
            session.handle(Message::Subscribe(request), 204).unwrap(),
            vec![Message::Accepted { id: 7 }]
        );
        drop(lease);
        lease = hub.subscribe(&session.active[&7], &catalog);
        let replacement = session.active[&7].publication.clone();
        let before = replacement.lock().unwrap().candidate().unwrap().body;
        let sample = hub.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            None,
            205,
            None,
        );
        hub.complete(next, sample);
        assert_eq!(
            replacement.lock().unwrap().candidate().unwrap().body,
            before,
            "Retired lease work cannot overwrite replacement"
        );
        assert_eq!(
            replacement.lock().unwrap().candidate().unwrap().sequence,
            Some(0)
        );
        hub.reset_reference();
        assert!(replacement.lock().unwrap().candidate().is_none());
        capture(&hub, 206, false);
        assert!(replacement.lock().unwrap().candidate().is_some());
        drop(lease);
    }
    #[tokio::test]
    async fn synthetic_acquires_with_zero_offset_and_cached_initial_timestamp() {
        let hub = Hub::new("synthetic");
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(synthetic(hub.clone(), shutdown));
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !hub.initialized.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
            let catalog = crate::publication::Catalog::snapshot(&hub);
            let mut session = crate::protocol::Session::new(catalog.capabilities.clone());
            session
                .handle(crate::protocol::Message::Offer(vec![1]), hub.now())
                .unwrap();
            session
                .handle(
                    crate::protocol::Message::Subscribe(crate::protocol::Request {
                        id: 1,
                        group: 0,
                        channel: 1,
                        interval: 5_000_000,
                        phase: 0,
                        prediction_offset: 0,
                        sequence_number_format: None,
                        bundles: vec![vec![crate::protocol::SampleBinding {
                            descriptor: 0,
                            format: 10,
                            space: 2,
                        }]],
                    }),
                    hub.now(),
                )
                .unwrap();
            let _lease = hub.subscribe(&session.active[&1], &catalog);
            let mut updates = hub.updates.subscribe();
            while session.active[&1]
                .publication
                .lock()
                .unwrap()
                .candidate()
                .is_none()
            {
                updates.changed().await.unwrap();
            }
            let candidate = session.active[&1]
                .publication
                .lock()
                .unwrap()
                .candidate()
                .unwrap();
            let acquired = u64::from_le_bytes(candidate.body[4..12].try_into().unwrap());
            let target = u64::from_le_bytes(candidate.body[12..20].try_into().unwrap());
            assert!(acquired <= hub.now() as u64);
            assert_ne!(target, u64::MAX);
            let request = crate::protocol::Request {
                id: 2,
                ..session.active[&1].request.clone()
            };
            session
                .handle(crate::protocol::Message::Subscribe(request), hub.now())
                .unwrap();
            let _cached = hub.subscribe(&session.active[&2], &catalog);
            assert!(
                session.active[&2]
                    .publication
                    .lock()
                    .unwrap()
                    .candidate()
                    .is_some(),
                "Existing acquisition can initialize immediately"
            );
        })
        .await;
        stop.send(true).unwrap();
        task.await.unwrap();
        result.unwrap();
    }
    #[test]
    fn reconnect_reacquires_stale_dynamic_state_but_retains_rest_definitions() {
        use crate::protocol::*;
        let (hub, catalog, mut session) = subscription_fixture();
        let lease = hub.subscribe_at(&session.active[&7], &catalog, 100);
        capture(&hub, 100, false);
        assert_eq!(
            hub.initial_sample_at(Group::Poses, 100)
                .unwrap()
                .acquired_at,
            100
        );
        drop(lease);
        assert!(
            hub.acquisitions(600_000_000_100, true)
                .iter()
                .all(|a| a.group != Group::Poses)
        );
        let request = session.active[&7].request.clone();
        session
            .handle(Message::Subscribe(request), 600_000_000_100)
            .unwrap();
        let _reconnected = hub.subscribe_at(&session.active[&7], &catalog, 600_000_000_100);
        assert!(
            session.active[&7]
                .publication
                .lock()
                .unwrap()
                .candidate()
                .is_none(),
            "Ten-minute-old dynamic data cannot initialize a new lease"
        );
        capture(&hub, 600_000_000_101, true);
        let candidate = session.active[&7]
            .publication
            .lock()
            .unwrap()
            .candidate()
            .unwrap();
        assert_eq!(&candidate.body[4..12], &600_000_000_101u64.to_le_bytes());
        let now = 600_000_000_101;
        assert!(
            hub.initial_sample_at(Group::Poses, now + 10_000_000)
                .is_some()
        );
        assert!(
            hub.initial_sample_at(Group::Poses, now + 10_000_001)
                .is_none()
        );
        assert!(hub.initial_sample_at(Group::Poses, now - 1).is_none());
        hub.set_available(false);
        assert!(hub.initial_sample_at(Group::Poses, now).is_none());
        hub.set_available(true);
        assert!(
            hub.initial_sample_at(Group::Poses, now).is_none(),
            "Resume must not revive pre-pause observations"
        );

        hub.body_supported.store(true, Ordering::SeqCst);
        let mut skeleton = crate::body::synthetic_skeleton();
        Arc::make_mut(&mut skeleton).acquired_at = 100;
        let body = crate::body::Body::inactive(skeleton);
        hub.acquire(
            Group::Rest,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            Some(&body),
            100,
            None,
        );
        hub.set_available(false);
        hub.reset_reference();
        hub.set_available(true);
        let rest_catalog = crate::publication::Catalog::snapshot(&hub);
        let mut rest_session = Session::new(rest_catalog.capabilities.clone());
        rest_session.handle(Message::Offer(vec![1]), now).unwrap();
        rest_session
            .handle(
                Message::Subscribe(Request {
                    id: 8,
                    group: 3,
                    channel: 2,
                    interval: 20_000_000,
                    phase: 0,
                    prediction_offset: 0,
                    sequence_number_format: None,
                    bundles: vec![vec![SampleBinding {
                        descriptor: rest_catalog.capabilities.skeletons[0][0].rest_pose_sample,
                        format: 10,
                        space: 5,
                    }]],
                }),
                now,
            )
            .unwrap();
        let _rest = hub.subscribe_at(&rest_session.active[&8], &rest_catalog, now);
        let candidate = rest_session.active[&8]
            .publication
            .lock()
            .unwrap()
            .candidate()
            .unwrap();
        assert_eq!(
            &candidate.body[4..12],
            &100u64.to_le_bytes(),
            "Rest definitions retain their acquisition time without age expiry"
        );
    }
    #[test]
    fn leases_share_immutable_catalog_tables() {
        let (hub, catalog, session) = subscription_fixture();
        let a = hub.subscribe(&session.active[&7], &catalog);
        let b = hub.subscribe(&session.active[&7], &catalog);
        let demands = hub.demands.lock().unwrap();
        let first = &demands.entries[&a.id].catalog;
        let second = &demands.entries[&b.id].catalog;
        assert!(Arc::ptr_eq(&first.capabilities, &second.capabilities));
        assert!(Arc::ptr_eq(&first.sources, &second.sources));
        assert!(Arc::ptr_eq(&first.capabilities, &session.capabilities));
    }
}
