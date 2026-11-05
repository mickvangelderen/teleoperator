use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::watch;

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
}

pub struct Subscription {
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

pub struct Hub {
    pub started: Instant,
    pub source: &'static str,
    pub available: AtomicBool,
    pub resumed_at: AtomicI64,
    pub reference_version: Mutex<u32>,
    subscriptions: Mutex<HashMap<Vec<usize>, Weak<Subscription>>>,
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
            reference_version: Mutex::new(1),
            subscriptions: Mutex::new(HashMap::new()),
            next_subscription: AtomicU64::new(1),
            next_stream: AtomicU64::new(1),
            updates: watch::channel(0).0,
            stats: Mutex::new(VecDeque::new()),
        })
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
    pub fn subscribe(&self, sources: Vec<usize>) -> Arc<Subscription> {
        let mut subscriptions = self.subscriptions.lock().unwrap();
        subscriptions.retain(|_, weak| weak.strong_count() > 0);
        if let Some(existing) = subscriptions.get(&sources).and_then(Weak::upgrade) {
            return existing;
        }
        let subscription = Arc::new(Subscription {
            id: Self::id(&self.next_subscription),
            sources: sources.clone(),
            samples: Mutex::new(VecDeque::new()),
            number: AtomicU64::new(0),
        });
        subscriptions.insert(sources, Arc::downgrade(&subscription));
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
    pub fn acquire(&self, poses: &[Pose; 5], acquired_at: i64, target_at: Option<i64>) {
        let version = *self.reference_version.lock().unwrap();
        let mut subscriptions = self.subscriptions.lock().unwrap();
        subscriptions.retain(|_, weak| {
            let Some(subscription) = weak.upgrade() else {
                return false;
            };
            let number = Self::id(&subscription.number)
                .checked_add(1)
                .expect("Sample counter exhausted");
            let mut samples = subscription.samples.lock().unwrap();
            samples.push_back(Sample {
                number,
                acquired_at,
                target_at,
                reference_version: version,
                poses: subscription
                    .sources
                    .iter()
                    .map(|&i| poses[i].clone())
                    .collect(),
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
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(10));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown.wait_for(|stopped| *stopped) => break,
            _ = interval.tick() => {
                let at = hub.now();
                let phase = (at as f64 / 1e9) as f32;
                let poses = std::array::from_fn(|i| Pose { position: [if i == 0 { 0.0 } else if i < 3 { -0.3 } else { 0.3 }, if i == 0 { 1.6 } else { 1.1 + phase.sin() * 0.1 }, if i == 0 { 0.0 } else { -0.4 }], orientation: [0.0, 0.0, 0.0, 1.0], flags: 15, active: (i > 0).then_some(true) });
                hub.acquire(&poses, at, Some(at));
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
        let a = hub.subscribe(vec![0, 2]);
        let b = hub.subscribe(vec![0, 2]);
        assert_eq!(a.id, b.id);
        let poses = std::array::from_fn(|_| Pose::default());
        for i in 0..12 {
            hub.acquire(&poses, i, Some(0));
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
        assert_ne!(hub.subscribe(vec![0, 2]).id, old);
    }
}
