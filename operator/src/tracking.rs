use crate::body::{self, Body, Skeleton};
use crate::inputs::{self, Input};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Pose,
    Controller,
    Body,
}

pub const RATE: f32 = 100.0;
pub const HISTORY: usize = 8;
pub const SOURCES: [&str; 5] = ["head", "left/aim", "left/grip", "right/aim", "right/grip"];

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

pub struct Subscription {
    pub kind: Kind,
    pub id: u64,
    pub sources: Vec<usize>,
    pub samples: Mutex<VecDeque<Sample>>,
    number: AtomicU64,
}

#[derive(Default)]
pub struct StreamStats {
    pub id: u64,
    pub sent: AtomicU64,
    pub skipped: AtomicU64,
    pub errors: AtomicU64,
    pub bytes: AtomicU64,
    pub peak_buffer: AtomicU64,
}

type SubscriptionKey = (Kind, Vec<usize>);

pub struct Hub {
    pub started: Instant,
    pub source: &'static str,
    pub available: AtomicBool,
    pub resumed_at: AtomicI64,
    pub skeleton: Mutex<Option<Arc<Skeleton>>>,
    pub body_fidelity: AtomicBool,
    pub body_calibration: AtomicBool,
    next_skeleton: AtomicU32,
    pub reference_version: Mutex<u32>,
    subscriptions: Mutex<HashMap<SubscriptionKey, Weak<Subscription>>>,
    next_subscription: AtomicU64,
    next_stream: AtomicU64,
    pub updates: watch::Sender<u64>,
    pub stats: Mutex<VecDeque<Arc<StreamStats>>>,
}

impl Hub {
    pub fn new(source: &'static str) -> Arc<Self> {
        Arc::new(Self {
            started: Instant::now(),
            source,
            available: AtomicBool::new(false),
            resumed_at: AtomicI64::new(0),
            skeleton: Mutex::new(None),
            body_fidelity: AtomicBool::new(false),
            body_calibration: AtomicBool::new(false),
            next_skeleton: AtomicU32::new(1),
            reference_version: Mutex::new(1),
            subscriptions: Mutex::new(HashMap::new()),
            next_subscription: AtomicU64::new(1),
            next_stream: AtomicU64::new(1),
            updates: watch::channel(0).0,
            stats: Mutex::new(VecDeque::new()),
        })
    }
    pub fn next_skeleton_version(&self) -> u32 {
        self.next_skeleton
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .expect("Skeleton version exhausted")
    }
    pub fn now(&self) -> i64 {
        self.started
            .elapsed()
            .as_nanos()
            .try_into()
            .expect("Clock exhausted")
    }
    pub fn set_available(&self, value: bool) {
        self.available.store(value, Ordering::SeqCst);
        self.notify();
    }
    pub fn reset_reference(&self) {
        let mut version = self.reference_version.lock().unwrap();
        *version = version.checked_add(1).expect("Reference version exhausted");
        self.notify();
    }
    fn notify(&self) {
        self.updates
            .send_modify(|n| *n = n.checked_add(1).expect("Update counter exhausted"));
    }
    fn id(counter: &AtomicU64) -> u64 {
        counter
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .expect("Session identity exhausted")
    }
    pub fn subscribe(&self, kind: Kind, sources: Vec<usize>) -> Arc<Subscription> {
        let mut subscriptions = self.subscriptions.lock().unwrap();
        subscriptions.retain(|_, weak| weak.strong_count() > 0);
        if let Some(existing) = subscriptions
            .get(&(kind, sources.clone()))
            .and_then(Weak::upgrade)
        {
            return existing;
        }
        let subscription = Arc::new(Subscription {
            kind,
            id: Self::id(&self.next_subscription),
            sources: sources.clone(),
            samples: Mutex::new(VecDeque::new()),
            number: AtomicU64::new(0),
        });
        subscriptions.insert((kind, sources), Arc::downgrade(&subscription));
        subscription
    }
    pub fn stream_stats(&self) -> Arc<StreamStats> {
        let result = Arc::new(StreamStats {
            id: Self::id(&self.next_stream),
            ..Default::default()
        });
        let mut stats = self.stats.lock().unwrap();
        stats.push_back(result.clone());
        // Retain completed-stream diagnostics for the most recent 64 streams.
        if stats.len() > 64 {
            stats.pop_front();
        }
        result
    }
    pub fn acquire(
        &self,
        poses: &[Pose; 5],
        inputs: &[Input],
        body: Option<&Body>,
        acquired_at: i64,
        target_at: Option<i64>,
    ) {
        *self.skeleton.lock().unwrap() = body.map(|b| b.skeleton.clone());
        let version = *self.reference_version.lock().unwrap();
        let mut subscriptions = self.subscriptions.lock().unwrap();
        subscriptions.retain(|_, weak| {
            let Some(subscription) = weak.upgrade() else {
                return false;
            };
            if subscription.kind == Kind::Body && body.is_none() {
                return true;
            }
            let number = Self::id(&subscription.number)
                .checked_add(1)
                .expect("Sample counter exhausted");
            let mut samples = subscription.samples.lock().unwrap();
            let selected_inputs = if subscription.kind == Kind::Controller {
                subscription
                    .sources
                    .iter()
                    .enumerate()
                    .map(|(slot, &i)| {
                        let mut value = inputs[i].clone();
                        if let Some(previous) = samples.back() {
                            value.count_from(&previous.inputs[slot]);
                        }
                        value
                    })
                    .collect()
            } else {
                Vec::new()
            };
            samples.push_back(Sample {
                number,
                acquired_at,
                target_at,
                reference_version: version,
                poses: if subscription.kind == Kind::Pose {
                    subscription
                        .sources
                        .iter()
                        .map(|&i| poses[i].clone())
                        .collect()
                } else {
                    Vec::new()
                },
                inputs: selected_inputs,
                body: (subscription.kind == Kind::Body).then(|| body.unwrap().clone()),
            });
            if samples.len() > HISTORY {
                samples.pop_front();
            }
            true
        });
        drop(subscriptions);
        self.notify();
    }
    pub fn diagnostics(&self) -> serde_json::Value {
        let stats = self.stats.lock().unwrap();
        serde_json::json!({"source": self.source, "tracking_available": self.available.load(Ordering::SeqCst), "streams": stats.iter().map(|s| serde_json::json!({"stream_id": s.id.to_string(), "accepted_messages": s.sent.load(Ordering::SeqCst).to_string(), "skipped_backpressure": s.skipped.load(Ordering::SeqCst).to_string(), "send_errors": s.errors.load(Ordering::SeqCst).to_string(), "bytes": s.bytes.load(Ordering::SeqCst).to_string(), "peak_buffered_bytes": s.peak_buffer.load(Ordering::SeqCst).to_string()})).collect::<Vec<_>>()})
    }
}

pub async fn synthetic(hub: Arc<Hub>, mut shutdown: watch::Receiver<bool>) {
    hub.set_available(true);
    hub.body_fidelity.store(true, Ordering::SeqCst);
    hub.body_calibration.store(true, Ordering::SeqCst);
    let skeleton = body::synthetic_skeleton();
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(10));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown.wait_for(|stopped| *stopped) => break,
            _ = interval.tick() => {
                let at = hub.now();
                let phase = (at as f64 / 1e9) as f32;
                let poses = std::array::from_fn(|i| Pose { position: [if i == 0 { 0.0 } else if i < 3 { -0.3 } else { 0.3 }, if i == 0 { 1.6 } else { 1.1 + phase.sin() * 0.1 }, if i == 0 { 0.0 } else { -0.4 }], orientation: [0.0, 0.0, 0.0, 1.0], flags: 15, active: (i > 0).then_some(true) });
                let inputs = inputs::definitions().iter().map(|d| Input { active: true, changed_at: None, value: match d.kind {
                    inputs::InputType::Boolean => inputs::Value::Boolean { value: ((phase * 2.) as u32).is_multiple_of(2), presses: 0, releases: 0 },
                    inputs::InputType::Scalar => inputs::Value::Scalar((phase.sin() + 1.) / 2.),
                    inputs::InputType::Vector2 => inputs::Value::Vector2([phase.sin() * 0.5, phase.cos() * 0.5]),
                } }).collect::<Vec<_>>();
                let body = Body { skeleton: skeleton.clone(), active: true, confidence: Some(1.), returned_at: Some(at), fidelity: Some(crate::protocol::wire::Fidelity::High), calibration: Some(crate::protocol::wire::CalibrationStatus::Valid), joints: skeleton.joints.iter().map(|j| { let mut pose = j.rest.clone(); pose.position[2] += phase.sin() * 0.1; pose }).collect() };
                hub.acquire(&poses, &inputs, Some(&body), at, Some(at));
            }
        }
    }
    hub.set_available(false);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_acquisition_retains_history_and_retires_identity() {
        let hub = Hub::new("test");
        let a = hub.subscribe(Kind::Pose, vec![0, 2]);
        let b = hub.subscribe(Kind::Pose, vec![0, 2]);
        assert_eq!(a.id, b.id);
        let poses = std::array::from_fn(|_| Pose::default());
        for i in 0..12 {
            hub.acquire(&poses, &[], None, i, Some(0));
        }
        let samples = a.samples.lock().unwrap();
        assert_eq!(samples.len(), 8);
        assert_eq!(
            (
                samples.front().unwrap().number,
                samples.back().unwrap().number
            ),
            (5, 12)
        );
        assert_eq!(samples.back().unwrap().poses.len(), 2);
        drop(samples);
        let old = a.id;
        drop(a);
        drop(b);
        assert_ne!(hub.subscribe(Kind::Pose, vec![0, 2]).id, old);
    }
}
