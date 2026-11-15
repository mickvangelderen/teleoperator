use crate::body::{self, Body, Skeleton};
use crate::inputs::{self, Input};
use crate::protocol::Schedule;
use crate::timing::{CaptureTiming, Diagnostics, History, Preparation};
use std::collections::BTreeMap;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::{Notify, watch};

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

#[derive(Clone)]
pub(crate) struct PublicationSample {
    pub sample: Sample,
    generation: u64,
    finished: bool,
    // Requested consumption deadline, independent of the runtime's represented time.
    deadline: Option<i64>,
    timing: CaptureTiming,
}
impl PublicationSample {
    fn current(&self, now: u64) -> Option<&Sample> {
        if self.deadline.is_some_and(|deadline| deadline as u64 <= now) {
            return None;
        }
        Some(&self.sample)
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

// Periodic requests are owned by their connection, never by a client-supplied id.
// A lease contains one replaceable result; no acquisition or publication backlog is retained.
struct Demand {
    group: Group,
    generation: u64,
    schedule: Schedule,
    next_due: Option<u64>,
    latest: Option<PublicationSample>,
    ready: bool,
    preparation: Preparation,
    eligible_at: u64,
}
impl Demand {
    fn lead(&self) -> u64 {
        match self.schedule {
            Schedule::Periodic { interval, .. } => {
                self.preparation.lead().min(interval.saturating_sub(1))
            }
            Schedule::OnChange => 0,
        }
    }
    fn wake_at(&self) -> Option<u64> {
        self.ready
            .then_some(self.next_due?)
            .map(|due| due.saturating_sub(self.lead()).max(self.eligible_at))
    }
    fn observe(&mut self, intended_wake: u64, now: u64, completed: bool) {
        if matches!(self.schedule, Schedule::Periodic { .. }) {
            self.preparation
                .observe(now.saturating_sub(intended_wake), completed);
            // A new estimate cannot retroactively arm a deadline in the past.
            self.eligible_at = self.eligible_at.max(now);
        }
    }
    fn discard_pending(&mut self, now: u64) {
        if let Some(pending) = self.latest.take()
            && !pending.finished
        {
            self.observe(pending.timing.intended_wake_at, now, false);
        }
    }
    fn current(&self, now: u64) -> Option<&Sample> {
        // A delayed sender never sends a result belonging to an obsolete periodic slot.
        if self.next_due.is_some_and(|due| due <= now) {
            return None;
        }
        self.latest.as_ref()?.current(now)
    }
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
impl SubscriptionSamples {
    pub fn update(&self, schedule: Schedule) {
        let now = self.hub.now() as u64;
        let mut demands = self.hub.demands.lock().unwrap();
        let demand = demands.entries.get_mut(&self.id).unwrap();
        demand.generation = demand
            .generation
            .checked_add(1)
            .expect("Schedule generation exhausted");
        demand.next_due = schedule.next_at(now);
        demand.eligible_at = now;
        demand.schedule = schedule;
        demand.latest = None;
        // Schedule updates keep the group and payload, so their measured work
        // remains useful. Replacing the subscription creates a fresh history.
        drop(demands);
        self.hub.wake_sampler();
    }
    pub fn latest(&self) -> Option<Sample> {
        self.delivery_after(None).map(|delivery| delivery.sample)
    }
    pub(crate) fn delivery_after(&self, sent: Option<u64>) -> Option<PublicationSample> {
        let now = self.hub.now() as u64;
        let mut demands = self.hub.demands.lock().unwrap();
        let demand = demands.entries.get_mut(&self.id)?;
        if demand.current(now).is_none() {
            let before = demand.wake_at();
            demand.discard_pending(now);
            let after = demand.wake_at();
            drop(demands);
            if after < before {
                self.hub.wake_sampler();
            }
            return None;
        }
        let delivery = demand.latest.as_ref()?;
        (sent != Some(delivery.sample.number)).then(|| delivery.clone())
    }
    pub(crate) fn set_ready(&self, ready: bool) {
        let mut demands = self.hub.demands.lock().unwrap();
        let Some(demand) = demands.entries.get_mut(&self.id) else {
            return;
        };
        if demand.ready == ready {
            return;
        }
        demand.ready = ready;
        demand.eligible_at = self.hub.now() as u64;
        demand.generation = demand
            .generation
            .checked_add(1)
            .expect("Schedule generation exhausted");
        // Reacquire on recovery instead of sending a value held through congestion.
        demand.latest = None;
        drop(demands);
        self.hub.wake_sampler();
    }
    pub(crate) fn discarded(&self, delivery: &PublicationSample, now: u64) {
        self.feedback(delivery, now, false);
    }
    fn feedback(&self, delivery: &PublicationSample, now: u64, completed: bool) {
        let mut demands = self.hub.demands.lock().unwrap();
        let Some(demand) = demands.entries.get_mut(&self.id) else {
            return;
        };
        if demand.generation != delivery.generation || !demand.ready {
            return;
        }
        let before = demand.wake_at();
        demand.observe(delivery.timing.intended_wake_at, now, completed);
        if let Some(current) = demand.latest.as_mut()
            && current.sample.number == delivery.sample.number
        {
            // Finished attempts are not treated as missed when the next slot replaces them.
            current.finished = true;
        }
        let after = demand.wake_at();
        drop(demands);
        if after < before {
            self.hub.wake_sampler();
        }
    }
    pub(crate) fn submitted(
        &self,
        delivery: &PublicationSample,
        sender_at: u64,
        encoded_at: u64,
        submitted_at: u64,
    ) {
        // The capture may have been superseded during send(). Its elapsed work
        // still matters; feedback must not depend on it remaining the latest.
        self.feedback(delivery, submitted_at, true);
        let timing = &delivery.timing;
        let group = self
            .hub
            .demands
            .lock()
            .unwrap()
            .entries
            .get(&self.id)
            .map(|d| d.group);
        let Some(group) = group else {
            return;
        };
        let summary = self.hub.diagnostics.lock().unwrap()[group as usize].record(
            timing,
            sender_at,
            encoded_at,
            submitted_at,
            delivery.sample.acquired_at,
            delivery.sample.target_at,
        );
        if let Some(mut summary) = summary {
            summary["group"] = serde_json::json!(group as u32);
            summary["wakeup_lateness"] = self.hub.wakeup.lock().unwrap().summary();
            log::info!("publication_timing {summary}");
        }
    }
    pub fn is_current(&self, number: u64) -> bool {
        self.hub
            .demands
            .lock()
            .unwrap()
            .entries
            .get(&self.id)
            .and_then(|d| d.current(self.hub.now() as u64))
            .is_some_and(|s| s.number == number)
    }
}
impl Drop for SubscriptionSamples {
    fn drop(&mut self) {
        self.hub.demands.lock().unwrap().entries.remove(&self.id);
        self.hub.wake_sampler();
    }
}

pub(crate) struct Acquisition {
    pub group: Group,
    // The requested consumption deadline; never overwritten by a runtime return.
    pub target_at: Option<i64>,
    timing: CaptureTiming,
    recipients: Vec<(u64, u64, u64)>,
}
impl Acquisition {
    #[cfg(target_os = "android")]
    pub fn background(group: Group) -> Self {
        Self {
            group,
            target_at: None,
            timing: CaptureTiming {
                publication_at: None,
                target_at: None,
                intended_wake_at: 0,
                wake_at: 0,
                started_at: 0,
                completed_at: 0,
            },
            recipients: Vec::new(),
        }
    }
    pub(crate) fn start(&mut self, now: u64) {
        self.timing.started_at = now;
    }
    pub(crate) fn wanted(&self, hub: &Hub) -> bool {
        if self.recipients.is_empty() {
            return true;
        }
        let demands = hub.demands.lock().unwrap();
        self.recipients.iter().any(|(id, generation, _)| {
            demands
                .entries
                .get(id)
                .is_some_and(|d| d.ready && d.generation == *generation)
        })
    }
    pub fn expired(&self, now: i64) -> bool {
        self.target_at.is_some_and(|target| target <= now)
    }
}

pub(crate) fn validate_schedule(schedule: &Schedule, now: u64) -> Result<(), String> {
    if let Schedule::Periodic {
        consumption_delay, ..
    } = schedule
    {
        schedule
            .next_at(now)
            .and_then(|slot| slot.checked_add(*consumption_delay))
            .and_then(|target| i64::try_from(target).ok())
            .ok_or("Prediction target exceeds the tracking clock range")?;
    }
    Ok(())
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
    latest: Mutex<BTreeMap<Group, Sample>>,
    next_sample: AtomicU64,
    observed_inputs: Mutex<Vec<Input>>,
    pub updates: watch::Sender<()>,
    demands: Mutex<Demands>,
    sampler_wake: Notify,
    #[cfg(target_os = "android")]
    sampler_event: Mutex<Option<Arc<crate::deadline::Event>>>,
    wakeup: Mutex<History>,
    diagnostics: Mutex<[Diagnostics; 4]>,
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
            sampler_wake: Notify::new(),
            #[cfg(target_os = "android")]
            sampler_event: Mutex::new(None),
            wakeup: Mutex::new(History::default()),
            diagnostics: Mutex::new(std::array::from_fn(|_| Diagnostics::default())),
        })
    }
    pub fn subscribe(self: &Arc<Self>, group: Group, schedule: Schedule) -> SubscriptionSamples {
        let mut demands = self.demands.lock().unwrap();
        let id = demands.next_id;
        demands.next_id = id
            .checked_add(1)
            .expect("Acquisition subscription ids exhausted");
        demands.entries.insert(
            id,
            Demand {
                group,
                generation: 0,
                next_due: schedule.next_at(self.now() as u64),
                schedule,
                latest: None,
                ready: true,
                preparation: Preparation::default(),
                eligible_at: self.now() as u64,
            },
        );
        drop(demands);
        self.wake_sampler();
        SubscriptionSamples {
            hub: self.clone(),
            id,
        }
    }
    fn wake_sampler(&self) {
        self.sampler_wake.notify_one();
        #[cfg(target_os = "android")]
        if let Some(event) = self.sampler_event.lock().unwrap().as_ref()
            && let Err(error) = event.notify()
        {
            log::error!("Could not wake acquisition thread: {error}");
        }
    }
    #[cfg(target_os = "android")]
    pub(crate) fn attach_sampler(&self, event: Option<Arc<crate::deadline::Event>>) {
        *self.sampler_event.lock().unwrap() = event;
    }
    pub(crate) fn record_wakeup(&self, deadline: u64, woke_at: u64) {
        self.wakeup
            .lock()
            .unwrap()
            .record(woke_at.saturating_sub(deadline) as i64);
    }
    pub(crate) fn next_acquisition(&self) -> Option<u64> {
        self.demands
            .lock()
            .unwrap()
            .entries
            .values()
            .filter_map(|d| d.wake_at())
            .min()
    }
    pub(crate) fn acquisitions(&self, now: u64, observe: bool) -> Vec<Acquisition> {
        let mut demands = self.demands.lock().unwrap();
        let mut batches = BTreeMap::<(u64, Group, Option<i64>), Vec<(u64, u64, u64)>>::new();
        if observe {
            // Observe inputs even without subscribers, preserving edge counters.
            batches.insert((now, Group::Inputs, None), Vec::new());
        }
        for (&id, demand) in &mut demands.entries {
            if !demand.ready {
                continue;
            }
            let mut intended_wake = now;
            let key = match demand.schedule {
                Schedule::OnChange if observe => (now, demand.group, None),
                Schedule::Periodic {
                    interval,
                    consumption_delay,
                    ..
                } if demand.wake_at().is_some_and(|due| due <= now) => {
                    let due = demand.next_due.unwrap();
                    // Keep phase, skip missed slots, and never drain a catch-up queue.
                    let slot = due + now.saturating_sub(due) / interval * interval;
                    intended_wake = slot.saturating_sub(demand.lead()).max(demand.eligible_at);
                    demand.next_due = slot.checked_add(interval).filter(|t| *t <= i64::MAX as u64);
                    demand.discard_pending(now);
                    let Some(target) = slot
                        .checked_add(consumption_delay)
                        .and_then(|t| i64::try_from(t).ok())
                    else {
                        continue;
                    };
                    // An already expired consumption event cannot use a new acquisition.
                    if target as u64 <= now {
                        demand.observe(intended_wake, now, false);
                        continue;
                    }
                    (slot, demand.group, Some(target))
                }
                _ => continue,
            };
            batches
                .entry(key)
                .or_default()
                .push((id, demand.generation, intended_wake));
        }
        batches
            .into_iter()
            .map(|((slot, group, target_at), recipients)| Acquisition {
                group,
                target_at,
                timing: CaptureTiming {
                    publication_at: target_at.map(|_| slot),
                    target_at,
                    intended_wake_at: now, // Set per recipient when completing the shared capture.
                    wake_at: now,
                    started_at: now,
                    completed_at: now,
                },
                recipients,
            })
            .collect()
    }
    pub(crate) fn complete(&self, acquisition: Acquisition, sample: Sample) {
        self.complete_at(acquisition, sample, self.now());
    }
    pub(crate) fn missed(&self, acquisition: &Acquisition, now: i64) {
        let mut demands = self.demands.lock().unwrap();
        for &(id, generation, intended_wake) in &acquisition.recipients {
            if let Some(demand) = demands.entries.get_mut(&id)
                && demand.generation == generation
                && demand.ready
            {
                demand.observe(intended_wake, now.max(0) as u64, false);
            }
        }
    }
    fn complete_at(&self, mut acquisition: Acquisition, sample: Sample, now: i64) {
        // Learn the elapsed work even when the result can no longer be used.
        if acquisition.expired(sample.acquired_at.max(now)) {
            self.missed(&acquisition, sample.acquired_at.max(now));
            return;
        }
        acquisition.timing.completed_at = now.max(0) as u64;
        let mut demands = self.demands.lock().unwrap();
        for (id, generation, intended_wake) in acquisition.recipients {
            if let Some(demand) = demands.entries.get_mut(&id)
                && demand.generation == generation
                && demand.ready
            {
                let mut timing = acquisition.timing.clone();
                timing.intended_wake_at = intended_wake;
                demand.latest = Some(PublicationSample {
                    sample: sample.clone(),
                    generation,
                    finished: false,
                    deadline: acquisition.target_at,
                    timing,
                });
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
            for demand in self.demands.lock().unwrap().entries.values_mut() {
                demand.generation = demand
                    .generation
                    .checked_add(1)
                    .expect("Schedule generation exhausted");
                demand.latest = None;
            }
        }
        self.notify();
    }
    pub fn reset_reference(&self) {
        let mut version = self.reference_version.lock().unwrap();
        *version = version.checked_add(1).expect("Reference version exhausted");
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
        self.latest.lock().unwrap().get(&group).cloned()
    }
    pub fn acquire(
        &self,
        group: Group,
        poses: &[Pose; 5],
        inputs: &[Input],
        body: Option<&Body>,
        acquired_at: i64,
        target_at: Option<i64>,
    ) -> Sample {
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
        let sample = Sample {
            number,
            acquired_at,
            target_at,
            reference_version: version,
            poses: poses.to_vec(),
            inputs,
            body: body.cloned(),
        };
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
        let wait = next_observation
            .saturating_duration_since(Instant::now())
            .min(
                hub.next_acquisition()
                    .map_or(std::time::Duration::MAX, |due| {
                        std::time::Duration::from_nanos(due.saturating_sub(hub.now() as u64))
                    }),
            );
        let wake_deadline = hub.now() as u64 + wait.as_nanos() as u64;
        tokio::select! {
            _ = shutdown.wait_for(|stopped| *stopped) => break,
            _ = hub.sampler_wake.notified() => {},
            _ = tokio::time::sleep(wait) => hub.record_wakeup(wake_deadline, hub.now() as u64),
        }
        let observe = Instant::now() >= next_observation;
        if observe {
            next_observation = next_deadline(next_observation, period, Instant::now());
        }
        for mut acquisition in hub.acquisitions(hub.now() as u64, observe) {
            acquisition.start(hub.now() as u64);
            let at = hub.now();
            if !acquisition.wanted(&hub) {
                continue;
            }
            if acquisition.expired(at) {
                hub.missed(&acquisition, at);
                continue;
            }
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

    // Execute a scheduled attempt with a deterministic clock, including queue,
    // query and sender work. A missed deadline must never deliver its result.
    fn attempt(
        hub: &Arc<Hub>,
        lease: &SubscriptionSamples,
        late: u64,
        query: u64,
        sender: u64,
    ) -> Option<i64> {
        let wake = hub.next_acquisition().unwrap();
        let selected = wake + late;
        let mut work = hub.acquisitions(selected, false).pop()?;
        let publication = work.timing.publication_at.unwrap();
        let target = work.target_at.unwrap() as u64;
        work.start(selected);
        let sample = hub.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            None,
            selected as i64,
            work.target_at,
        );
        let completed = selected + query;
        hub.complete_at(work, sample, completed as i64);
        let delivery = lease.delivery_after(None)?;
        let encoded = completed + sender;
        if encoded >= target {
            lease.discarded(&delivery, encoded);
            return None;
        }
        lease.submitted(&delivery, completed, encoded, encoded);
        assert!(encoded < target, "Expired attempts cannot publish");
        Some(encoded as i64 - publication as i64)
    }
    #[test]
    fn cold_subscriptions_learn_even_when_the_first_attempts_expire() {
        for delay in [0, 100_000, 300_000, 5_000_000] {
            let hub = Hub::new("test");
            let lease = hub.subscribe(Group::Poses, periodic(20_000_000, 10_000_000, delay));
            let errors = (0..30)
                .filter_map(|_| attempt(&hub, &lease, 50_000, 400_000, 60_000))
                .collect::<Vec<_>>();
            assert!(
                errors.len() >= 27,
                "delay={delay}: only {} useful publications",
                errors.len()
            );
            assert!(
                errors[errors.len() - 10..].iter().all(|e| e.abs() <= 1),
                "delay={delay}: {errors:?}"
            );
        }
    }
    #[test]
    fn feedback_recovers_after_a_sustained_acquisition_cost_increase() {
        let hub = Hub::new("test");
        let lease = hub.subscribe(Group::Poses, periodic(20_000_000, 10_000_000, 5_000_000));
        for _ in 0..60 {
            assert!(attempt(&hub, &lease, 50_000, 500_000, 60_000).is_some());
        }
        assert!(attempt(&hub, &lease, 50_000, 8_000_000, 60_000).is_none());
        let errors = (0..20)
            .filter_map(|_| attempt(&hub, &lease, 50_000, 8_000_000, 60_000))
            .collect::<Vec<_>>();
        assert_eq!(
            errors.len(),
            20,
            "The expired query must teach the next attempt"
        );
        assert!(errors[1..].iter().all(|e| e.abs() <= 1), "{errors:?}");
    }
    #[test]
    fn feedback_includes_busy_time_before_acquisition_selection() {
        let hub = Hub::new("test");
        let lease = hub.subscribe(Group::Poses, periodic(20_000_000, 10_000_000, 3_000_000));
        // No record_wakeup call: the thread was doing other work, not sleeping.
        let errors = (0..100)
            .map(|_| attempt(&hub, &lease, 1_500_000, 100_000, 0).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(errors[0], 1_600_000);
        assert!(errors[1..].iter().all(|e| e.abs() <= 1), "{errors:?}");
    }
    #[test]
    fn expiry_in_the_sender_teaches_preparation_without_sending_stale_values() {
        let hub = Hub::new("test");
        let lease = hub.subscribe(Group::Poses, periodic(20_000_000, 10_000_000, 200_000));
        assert!(attempt(&hub, &lease, 50_000, 100_000, 500_000).is_none());
        for _ in 0..20 {
            assert!(attempt(&hub, &lease, 50_000, 100_000, 500_000).is_some());
        }
    }
    #[test]
    fn expiry_before_query_and_while_awaiting_the_sender_teaches_preparation() {
        let hub = Hub::new("test");
        let lease = hub.subscribe(Group::Poses, periodic(20_000_000, 10_000_000, 200_000));
        let due = hub.next_acquisition().unwrap();
        let work = hub.acquisitions(due, false).pop().unwrap();
        hub.missed(&work, due as i64 + 300_000);
        let advance = due + 20_000_000 - hub.next_acquisition().unwrap();
        assert!(advance >= 600_000);
        let wake = hub.next_acquisition().unwrap();
        let work = hub.acquisitions(wake, false).pop().unwrap();
        let sample = hub.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            None,
            wake as i64,
            work.target_at,
        );
        hub.complete_at(work, sample, wake as i64 + 100_000);
        // No sender progress: the next slot replaces a wholly unsent result.
        let next_wake = hub.next_acquisition().unwrap();
        hub.acquisitions(next_wake, false);
        assert!(
            hub.demands.lock().unwrap().entries[&lease.id]
                .preparation
                .lead()
                >= 20_000_000
        );
    }
    #[test]
    fn submission_feedback_survives_replacement_but_not_a_schedule_change() {
        let hub = Hub::new("test");
        let lease = hub.subscribe(Group::Poses, periodic(20_000_000, 10_000_000, 100_000_000));
        let due = hub.next_acquisition().unwrap();
        let work = hub.acquisitions(due, false).pop().unwrap();
        complete(&hub, work, due as i64);
        let old = lease.delivery_after(None).unwrap();
        let next = hub.acquisitions(due + 20_000_000, false).pop().unwrap();
        complete(&hub, next, due as i64 + 20_000_000);
        let latest = lease.latest().unwrap().number;
        lease.submitted(&old, due + 100_000, due + 200_000, due + 21_000_000);
        assert_eq!(lease.latest().unwrap().number, latest);
        assert!(
            hub.demands.lock().unwrap().entries[&lease.id]
                .preparation
                .lead()
                >= 21_000_000
        );
        lease.update(periodic(20_000_000, 15_000_000, 100_000_000));
        let estimate = hub.demands.lock().unwrap().entries[&lease.id]
            .preparation
            .lead();
        lease.submitted(&old, due + 100_000, due + 200_000, due + 50_000_000);
        assert_eq!(
            hub.demands.lock().unwrap().entries[&lease.id]
                .preparation
                .lead(),
            estimate
        );
    }

    #[test]
    fn feedback_advances_acquisition_without_moving_publication_or_sample_target() {
        let hub = Hub::new("test");
        let interval = 1_000_000_000;
        let a = hub.subscribe(Group::Poses, periodic(interval, 500_000_000, 25_000_000));
        let b = hub.subscribe(Group::Poses, periodic(interval, 500_000_000, 25_000_000));
        let publication = hub.next_acquisition().unwrap();
        let work = hub.acquisitions(publication, false).pop().unwrap();
        let sample = hub.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            None,
            publication as i64,
            work.target_at,
        );
        hub.complete_at(work, sample.clone(), publication as i64 + 100_000);
        a.submitted(
            &a.delivery_after(None).unwrap(),
            publication + 120_000,
            publication + 150_000,
            publication + 200_000,
        );
        b.submitted(
            &b.delivery_after(None).unwrap(),
            publication + 220_000,
            publication + 350_000,
            publication + 400_000,
        );
        hub.record_wakeup(100, 20_100);

        let next_publication = publication + interval;
        let wake = next_publication - 400_001;
        assert_eq!(hub.next_acquisition(), Some(wake));
        assert!(hub.acquisitions(wake - 1, false).is_empty());
        let work = hub.acquisitions(wake, false).pop().unwrap();
        assert_eq!(work.recipients, [(b.id, 0, wake)]);
        assert_eq!(work.timing.publication_at, Some(next_publication));
        assert_eq!(work.target_at, Some(next_publication as i64 + 25_000_000));
        let sample = hub.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            None,
            wake as i64,
            work.target_at,
        );
        hub.complete_at(work, sample, wake as i64 + 100_000);
        assert!(b.latest().is_some(), "No hold until the publication slot");
        assert_eq!(hub.next_acquisition(), Some(next_publication - 200_001));
        // The other subscription can wake late without being pushed to another slot.
        let work = hub
            .acquisitions(next_publication + 100_000, false)
            .pop()
            .unwrap();
        assert_eq!(work.recipients, [(a.id, 0, next_publication - 200_001)]);
        assert_eq!(work.target_at, Some(next_publication as i64 + 25_000_000));

        b.update(periodic(interval, 700_000_000, 80_000_000));
        assert_eq!(hub.next_acquisition(), Some(700_000_000 - 400_001));
        let work = hub
            .acquisitions(700_000_000 - 400_001, false)
            .pop()
            .unwrap();
        assert_eq!(work.target_at, Some(780_000_000));
    }

    #[test]
    fn congestion_defers_work_and_recovery_reacquires_instead_of_replaying() {
        let hub = Hub::new("test");
        let lease = hub.subscribe(Group::Body, periodic(10_000_000, 3_000_000, 25_000_000));
        let due = hub.next_acquisition().unwrap();
        let work = hub.acquisitions(due, false).pop().unwrap();
        lease.set_ready(false);
        assert!(!work.wanted(&hub));
        complete(&hub, work, due as i64 + 100);
        assert!(lease.latest().is_none());
        assert_eq!(hub.next_acquisition(), None);
        assert!(hub.acquisitions(due + 100_000_000, false).is_empty());
        lease.set_ready(true);
        let recovered = hub.acquisitions(due + 103_000_000, false).pop().unwrap();
        assert_eq!(recovered.target_at, Some(due as i64 + 125_000_000));
        assert!(hub.acquisitions(due + 103_000_001, false).is_empty());
    }

    #[test]
    fn an_advance_can_make_a_zero_delay_target_future_but_never_unexpires_it() {
        let hub = Hub::new("test");
        let lease = hub.subscribe(Group::Poses, periodic(1_000_000_000, 500_000_000, 0));
        let publication = hub.next_acquisition().unwrap();
        hub.demands
            .lock()
            .unwrap()
            .entries
            .get_mut(&lease.id)
            .unwrap()
            .preparation
            .observe(100_000, true);
        let wake = publication - 100_001;
        assert_eq!(hub.next_acquisition(), Some(wake));
        let work = hub.acquisitions(wake, false).pop().unwrap();
        assert_eq!(work.target_at, Some(publication as i64));
        let sample = hub.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            None,
            wake as i64,
            work.target_at,
        );
        hub.complete_at(work, sample, publication as i64);
        assert!(lease.latest().is_none());
    }
    fn periodic(interval: u64, phase: u64, consumption_delay: u64) -> Schedule {
        Schedule::Periodic {
            interval,
            phase,
            consumption_delay,
        }
    }
    fn complete(hub: &Hub, acquisition: Acquisition, at: i64) {
        let target = acquisition.target_at.unwrap_or(at);
        let sample = hub.acquire(
            acquisition.group,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            None,
            at,
            Some(target),
        );
        hub.complete(acquisition, sample);
    }
    #[test]
    fn periodic_captures_follow_phase_and_distinct_targets_without_overwriting_peers() {
        let hub = Hub::new("test");
        let interval = 1_000_000_000;
        let phase = 500_000_000;
        let a = hub.subscribe(Group::Poses, periodic(interval, phase, 5_000_000));
        let same = hub.subscribe(Group::Poses, periodic(interval, phase, 5_000_000));
        let b = hub.subscribe(Group::Poses, periodic(interval, phase, 25_000_000));
        let other_phase = hub.subscribe(
            Group::Poses,
            periodic(interval, phase + 10_000_000, 5_000_000),
        );
        let observed = hub.subscribe(Group::Poses, Schedule::OnChange);
        let due = hub.next_acquisition().unwrap();
        assert!(
            hub.acquisitions(due - 1, false).is_empty(),
            "No initial out-of-phase capture"
        );
        let batches = hub.acquisitions(due, false);
        assert_eq!(
            batches.len(),
            2,
            "Identical schedules share a coherent capture"
        );
        assert_eq!(batches[0].target_at, Some(due as i64 + 5_000_000));
        assert_eq!(batches[0].recipients.len(), 2);
        assert_eq!(batches[1].target_at, Some(due as i64 + 25_000_000));
        for batch in batches {
            complete(&hub, batch, due as i64 + 100);
        }
        assert_eq!(a.latest().unwrap().target_at, Some(due as i64 + 5_000_000));
        assert_eq!(same.latest().unwrap().number, a.latest().unwrap().number);
        assert_eq!(b.latest().unwrap().target_at, Some(due as i64 + 25_000_000));
        assert_ne!(a.latest().unwrap().number, b.latest().unwrap().number);
        assert!(other_phase.latest().is_none());
        assert!(
            observed.latest().is_none(),
            "Periodic predictions cannot drive OnChange"
        );
        assert!(
            hub.acquisitions(due, false).is_empty(),
            "Slots are consumed only once"
        );
        let batches = hub.acquisitions(due + 10_000_000, true);
        assert_eq!(
            batches.len(),
            3,
            "Input observations are a separate acquisition"
        );
        for batch in batches {
            complete(&hub, batch, due as i64 + 10_000_100);
        }
        assert_eq!(
            other_phase.latest().unwrap().target_at,
            Some(due as i64 + 15_000_000)
        );
        assert_eq!(
            observed.latest().unwrap().target_at,
            Some(due as i64 + 10_000_100)
        );
        assert_eq!(a.latest().unwrap().acquired_at, due as i64 + 100);
    }
    #[test]
    fn expired_consumption_events_are_dropped_without_catchup_or_phase_drift() {
        let hub = Hub::new("test");
        let lease = hub.subscribe(Group::Poses, periodic(10_000_000, 3_000_000, 5_000_000));
        let due = hub.next_acquisition().unwrap();
        // The old test expected target due+95ms at now=due+97ms.
        assert!(hub.acquisitions(due + 97_000_000, false).is_empty());
        assert!(lease.latest().is_none());
        // Advance preparation for the next future slot without replaying the
        // expired slots or changing the next slot's target.
        assert_eq!(hub.next_acquisition(), Some(due + 97_000_000));
        let next = hub.acquisitions(due + 97_000_000, false).pop().unwrap();
        assert_eq!(next.target_at, Some(due as i64 + 105_000_000));
        complete(&hub, next, due as i64 + 97_000_100);
        assert!(lease.latest().is_some());
        assert!(hub.acquisitions(due + 97_000_100, false).is_empty());
    }
    #[test]
    fn small_wakeup_lateness_keeps_the_intended_future_consumption_time() {
        let hub = Hub::new("test");
        let lease = hub.subscribe(
            Group::Poses,
            periodic(1_000_000_000, 500_000_000, 5_000_000),
        );
        let due = hub.next_acquisition().unwrap();
        let work = hub.acquisitions(due + 200_000, false).pop().unwrap();
        assert_eq!(work.target_at, Some(due as i64 + 5_000_000));
        complete(&hub, work, due as i64 + 250_000);
        assert_eq!(
            lease.latest().unwrap().target_at,
            Some(due as i64 + 5_000_000)
        );
        assert_eq!(hub.next_acquisition(), Some(due + 1_000_000_000));
    }
    #[test]
    fn expiry_is_checked_after_acquisition_and_while_waiting_to_send() {
        let hub = Hub::new("test");
        let lease = hub.subscribe(
            Group::Poses,
            periodic(1_000_000_000, 500_000_000, 5_000_000),
        );
        let due = hub.next_acquisition().unwrap();
        let work = hub.acquisitions(due, false).pop().unwrap();
        let deadline = work.target_at.unwrap();
        assert!(!work.expired(deadline - 1));
        assert!(work.expired(deadline));
        let sample = hub.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            None,
            due as i64,
            Some(deadline),
        );
        hub.complete_at(work, sample, deadline);
        assert!(lease.latest().is_none(), "Acquisition finished too late");

        let next_due = due + 1_000_000_000;
        let work = hub.acquisitions(next_due, false).pop().unwrap();
        let deadline = work.target_at.unwrap();
        // A runtime shortfall does not change the scheduled consumption deadline.
        let sample = hub.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            None,
            next_due as i64,
            Some(next_due as i64 - 1_000_000),
        );
        hub.complete_at(work, sample, next_due as i64 + 100_000);
        let demands = hub.demands.lock().unwrap();
        let demand = &demands.entries[&lease.id];
        assert!(demand.current(deadline as u64 - 1).is_some());
        assert!(
            demand.current(deadline as u64).is_none(),
            "Do not submit after the consumption deadline"
        );
    }
    #[test]
    fn zero_delay_periodic_slots_expire_but_on_change_observation_continues() {
        let hub = Hub::new("test");
        let _periodic = hub.subscribe(Group::Poses, periodic(10_000_000, 3_000_000, 0));
        let observed = hub.subscribe(Group::Poses, Schedule::OnChange);
        let due = hub.next_acquisition().unwrap();
        assert!(hub.acquisitions(due, false).is_empty());
        for work in hub.acquisitions(due, true) {
            assert_eq!(work.target_at, None);
            complete(&hub, work, due as i64);
        }
        assert!(observed.latest().is_some());
    }
    #[test]
    fn independent_groups_keep_their_acquisition_and_represented_times() {
        use crate::{
            protocol::{Request, Selection},
            publication::Catalog,
        };
        let hub = Hub::new("test");
        hub.initialized.store(true, Ordering::SeqCst);
        hub.body_supported.store(true, Ordering::SeqCst);
        let skeleton = body::synthetic_skeleton();
        *hub.skeleton.lock().unwrap() = Some(skeleton.clone());
        let catalog = Catalog::snapshot(&hub);
        let schedule = periodic(1_000_000_000, 500_000_000, 30_000_000);
        let head = hub.subscribe(Group::Poses, schedule.clone());
        let body = hub.subscribe(Group::Body, schedule);
        let due = hub.next_acquisition().unwrap();
        let batches = hub.acquisitions(due, false);
        assert_eq!(
            batches.len(),
            2,
            "Matching schedules cannot merge different acquisition groups"
        );
        let poses = std::array::from_fn(|_| Pose {
            flags: 15,
            orientation: [0., 0., 0., 1.],
            ..Pose::default()
        });
        let returned = due as i64 - 10_000_000;
        let mut body_value = Body::inactive(skeleton);
        body_value.active = true;
        body_value.returned_at = Some(returned);
        body_value.joints = vec![poses[0].clone(); body::JOINT_COUNT];
        for batch in batches {
            let at = due as i64
                + if batch.group == Group::Body {
                    500_000
                } else {
                    100_000
                };
            let sample = hub.acquire(
                batch.group,
                &poses,
                &[],
                Some(&body_value),
                at,
                batch.target_at,
            );
            hub.complete_at(batch, sample, at + 100_000);
        }
        let head_sample = head.latest().unwrap();
        let body_sample = body.latest().unwrap();
        assert_eq!(head_sample.target_at, Some(due as i64 + 30_000_000));
        assert_eq!(body_sample.target_at, Some(returned));
        assert_ne!(head_sample.acquired_at, body_sample.acquired_at);
        for (group, sample, descriptor, target) in [
            (Group::Poses, &head_sample, 0, due as i64 + 30_000_000),
            (
                Group::Body,
                &body_sample,
                catalog.capabilities.skeletons[0][0].pose_sample,
                returned,
            ),
        ] {
            let request = Request {
                id: group as u32 + 1,
                group: group as u32,
                delivery: 1,
                schedule: Schedule::OnChange,
                samples: vec![Selection {
                    descriptor,
                    format: 10,
                    space: 2,
                }],
            };
            catalog.capabilities.validate_request(&request).unwrap();
            let packet = catalog
                .publication(&request, sample, sample.acquired_at as u64)
                .unwrap();
            assert_eq!(
                u64::from_le_bytes(packet[4..12].try_into().unwrap()),
                sample.acquired_at as u64
            );
            assert_eq!(
                u64::from_le_bytes(packet[12..20].try_into().unwrap()),
                target as u64
            );
        }
        body.update(periodic(1_000_000_000, 510_000_000, 60_000_000));
        assert!(body.latest().is_none());
        assert_eq!(head.latest().unwrap().number, head_sample.number);
        let update = hub.acquisitions(due + 10_000_000, false).pop().unwrap();
        assert_eq!(update.group, Group::Body);
        assert_eq!(update.target_at, Some(due as i64 + 70_000_000));
        // Retained rest data keeps the time of the skeleton acquisition, not the readout.
        let rest = hub.acquire(
            Group::Rest,
            &poses,
            &[],
            Some(&body_value),
            due as i64,
            Some(due as i64),
        );
        assert_eq!(rest.acquired_at, body_value.skeleton.acquired_at);
        assert_eq!(rest.target_at, None);
        assert_eq!(hub.latest(Group::Poses).unwrap().number, head_sample.number);
    }
    #[test]
    fn updates_replacement_disconnect_and_stop_discard_in_flight_captures() {
        let hub = Hub::new("test");
        let schedule = periodic(1_000_000_000, 500_000_000, 5_000_000);
        let lease = hub.subscribe(Group::Poses, schedule.clone());
        let due = hub.next_acquisition().unwrap();
        let old = hub.acquisitions(due, false).pop().unwrap();
        lease.update(periodic(1_000_000_000, 510_000_000, 25_000_000));
        complete(&hub, old, due as i64);
        assert!(lease.latest().is_none());
        let updated_due = hub.next_acquisition().unwrap();
        let updated = hub.acquisitions(updated_due, false).pop().unwrap();
        assert_eq!(updated.target_at, Some(updated_due as i64 + 25_000_000));
        drop(lease);
        let replacement = hub.subscribe(Group::Poses, schedule);
        complete(&hub, updated, updated_due as i64);
        assert!(replacement.latest().is_none());
        let in_flight = hub.acquisitions(due, false).pop().unwrap();
        hub.set_available(false);
        complete(&hub, in_flight, due as i64);
        assert!(replacement.latest().is_none());
        drop(replacement);
        assert!(hub.demands.lock().unwrap().entries.is_empty());
        assert_eq!(hub.next_acquisition(), None);
    }
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
        assert!(validate_schedule(&periodic(10, 0, i64::MAX as u64), 1).is_err());
    }
    #[tokio::test]
    async fn synthetic_subscriptions_predict_different_values_and_apply_live_updates() {
        let hub = Hub::new("synthetic");
        let mut updates = hub.updates.subscribe();
        let a = hub.subscribe(Group::Poses, periodic(20_000_000, 3_000_000, 10_000_000));
        let b = hub.subscribe(Group::Poses, periodic(20_000_000, 3_000_000, 510_000_000));
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(synthetic(hub.clone(), shutdown));
        let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let (Some(a), Some(b)) = (a.latest(), b.latest()) {
                    break (a, b);
                }
                updates.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        for (sample, delay) in [(&first, 10_000_000), (&second, 510_000_000)] {
            let target = sample.target_at.unwrap();
            assert_eq!((target - delay) % 20_000_000, 3_000_000);
            assert!(sample.acquired_at >= target - delay);
            assert!(sample.acquired_at < target - delay + 20_000_000);
            assert_eq!(sample.body.as_ref().unwrap().returned_at, Some(target));
            let phase = (target as f64 / 1e9) as f32;
            assert!((sample.poses[1].position[1] - (1.1 + phase.sin() * 0.1)).abs() < 1e-6);
        }
        assert!((first.poses[1].position[1] - second.poses[1].position[1]).abs() > 0.01);
        a.update(periodic(30_000_000, 7_000_000, 70_000_000));
        assert!(a.latest().is_none());
        let updated = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Some(sample) = a.latest() {
                    break sample;
                }
                updates.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(
            (updated.target_at.unwrap() - 70_000_000) % 30_000_000,
            7_000_000
        );
        assert_ne!(updated.number, first.number);
        stop.send(true).unwrap();
        task.await.unwrap();
        assert!(a.latest().is_none());
        assert!(b.latest().is_none());
    }

    #[tokio::test]
    async fn synthetic_poses_use_the_prediction_target_while_inputs_remain_observed() {
        let hub = Hub::new("synthetic");
        let _lease = hub.subscribe(Group::Poses, Schedule::OnChange);
        let mut updates = hub.updates.subscribe();
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(synthetic(hub.clone(), shutdown));
        let sample = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Some(sample) = hub.latest(Group::Poses) {
                    break sample;
                }
                updates.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        stop.send(true).unwrap();
        task.await.unwrap();
        let target = sample.target_at.unwrap();
        assert_eq!(target, sample.acquired_at);
        assert_eq!(sample.body.as_ref().unwrap().returned_at, Some(target));
        let predicted = (target as f64 / 1e9) as f32;
        assert!((sample.poses[1].position[1] - (1.1 + predicted.sin() * 0.1)).abs() < 1e-6);
        let observed = (sample.acquired_at as f64 / 1e9) as f32;
        let scalar = sample
            .inputs
            .iter()
            .find_map(|input| match input.value {
                inputs::Value::Scalar(v) => Some(v),
                _ => None,
            })
            .unwrap();
        assert!((scalar - (observed.sin() + 1.) / 2.).abs() < 1e-6);
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
}
