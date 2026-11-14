use crate::body::{self, Body, Skeleton};
use crate::inputs::{self, Input};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::watch;

pub const RATE: f32 = 200.0;
pub const PREDICTION_NS: i64 = 25_000_000;
pub fn prediction_target(acquired_at: i64) -> i64 {
    acquired_at
        .checked_add(PREDICTION_NS)
        .expect("Prediction time exhausted")
}
pub const SOURCES: [&str; 5] = ["head", "left/aim", "left/grip", "right/aim", "right/grip"];

#[cfg(any(target_os = "android", test))]
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
    started: Instant,
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
    pub latest: Mutex<Option<Sample>>,
    pub updates: watch::Sender<()>,
    pub trace: crate::diagnostics::Diagnostics,
}

impl Hub {
    pub fn new(source: &'static str) -> Arc<Self> {
        Arc::new(Self {
            started: Instant::now(),
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
            latest: Mutex::new(None),
            updates: watch::channel(()).0,
            trace: Default::default(),
        })
    }
    pub fn next_skeleton_version(&self) -> u64 {
        self.next_skeleton.fetch_add(1, Ordering::SeqCst)
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
    pub(crate) fn notify(&self) {
        self.updates.send_replace(());
    }
    pub fn acquire(
        &self,
        poses: &[Pose; 5],
        inputs: &[Input],
        body: Option<&Body>,
        acquired_at: i64,
        target_at: Option<i64>,
    ) {
        // Keep the advertised topology through temporary sample unavailability.
        // Publication values still come from this acquisition's body below.
        if let Some(body) = body {
            *self.skeleton.lock().unwrap() = Some(body.skeleton.clone());
        }
        let version = *self.reference_version.lock().unwrap();
        let mut latest = self.latest.lock().unwrap();
        let number = latest.as_ref().map_or(1, |s| {
            s.number.checked_add(1).expect("Sample counter exhausted")
        });
        let mut inputs = inputs.to_vec();
        if let Some(previous) = latest.as_ref() {
            for (input, old) in inputs.iter_mut().zip(&previous.inputs) {
                input.count_from(old);
            }
        }
        *latest = Some(Sample {
            number,
            acquired_at,
            target_at,
            reference_version: version,
            poses: poses.to_vec(),
            inputs,
            body: body.cloned(),
        });
        drop(latest);
        self.trace.record(
            self.now(),
            crate::diagnostics::Event::Acquisition {
                sample: number,
                acquired_ms: acquired_at as f64 / 1e6,
                target_ms: target_at.map(|t| t as f64 / 1e6),
                body_available: body.is_some(),
            },
        );
        self.notify();
    }
}

pub async fn synthetic(hub: Arc<Hub>, mut shutdown: watch::Receiver<bool>) {
    hub.body_supported.store(true, Ordering::SeqCst);
    hub.initialized.store(true, Ordering::SeqCst);
    hub.set_available(true);
    hub.body_fidelity.store(true, Ordering::SeqCst);
    hub.body_calibration.store(true, Ordering::SeqCst);
    let skeleton = body::synthetic_skeleton();
    let mut interval = tokio::time::interval(std::time::Duration::from_secs_f32(1.0 / RATE));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown.wait_for(|stopped| *stopped) => break,
            _ = interval.tick() => {
                let at = hub.now();
                let target = prediction_target(at);
                let phase = (target as f64 / 1e9) as f32;
                let poses = std::array::from_fn(|i| Pose { position: [if i == 0 { 0.0 } else if i < 3 { -0.3 } else { 0.3 }, if i == 0 { 1.6 } else { 1.1 + phase.sin() * 0.1 }, if i == 0 { 0.0 } else { -0.4 }], orientation: [0.0, 0.0, 0.0, 1.0], flags: 15, active: (i > 0).then_some(true) });
                let input_phase = (at as f64 / 1e9) as f32;
                let inputs = inputs::definitions().iter().map(|d| Input { active: true, changed_at: None, value: match d.kind {
                    inputs::InputType::Boolean => inputs::Value::Boolean { value: ((input_phase * 2.) as u32).is_multiple_of(2), presses: 0, releases: 0 },
                    inputs::InputType::Scalar => inputs::Value::Scalar((input_phase.sin() + 1.) / 2.),
                    inputs::InputType::Vector2 => inputs::Value::Vector2([input_phase.sin() * 0.5, input_phase.cos() * 0.5]),
                } }).collect::<Vec<_>>();
                let body = Body { skeleton: skeleton.clone(), active: true, confidence: Some(1.), returned_at: Some(target), fidelity: Some(body::Fidelity::High), calibration: Some(body::CalibrationStatus::Valid), joints: skeleton.joints.iter().map(|j| { let mut pose = j.rest.clone(); pose.position[2] += phase.sin() * 0.1; pose }).collect() };
                hub.acquire(&poses, &inputs, Some(&body), at, Some(target));
            }
        }
    }
    hub.set_available(false);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn synthetic_poses_use_the_prediction_target_while_inputs_remain_observed() {
        let hub = Hub::new("synthetic");
        let mut updates = hub.updates.subscribe();
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(synthetic(hub.clone(), shutdown));
        let sample = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Some(sample) = hub.latest.lock().unwrap().clone() {
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
        assert_eq!(target - sample.acquired_at, 25_000_000);
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
            hub.acquire(&poses, &[input], None, i, None);
        }
        let latest = hub.latest.lock().unwrap();
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
            hub.acquire(&poses, &[], None, i, Some(0));
        }
        let latest = hub.latest.lock().unwrap();
        let sample = latest.as_ref().unwrap();
        assert_eq!(sample.number, 12);
        assert_eq!(sample.acquired_at, 11);
        assert_eq!(sample.poses.len(), 5);
    }
}
