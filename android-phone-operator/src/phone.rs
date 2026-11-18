//! Phone-only source: Android BOOTTIME timestamps, no translation or prediction.
use crate::protocol::{
    self, Capabilities, Descriptor, EncodedAcquisition, PublicationState, Request, Value,
};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::watch;

pub const STALE_NS: u64 = 250_000_000;
pub const RATE: f32 = 100.;
const IDENTITY: [f64; 4] = [0., 0., 0., 1.];

pub fn now() -> u64 {
    // SensorEvent.timestamp and elapsedRealtimeNanos share Android CLOCK_BOOTTIME.
    // Including suspend avoids estimating an offset from CLOCK_MONOTONIC.
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    let result = unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts) };
    assert_eq!(result, 0, "CLOCK_BOOTTIME unavailable");
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

pub fn multiply(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let [x, y, z, w] = a;
    let [i, j, k, r] = b;
    [
        w * i + x * r + y * k - z * j,
        w * j - x * k + y * r + z * i,
        w * k + x * j - y * i + z * r,
        w * r - x * i - y * j - z * k,
    ]
}
fn normalized(q: [f64; 4]) -> Option<[f64; 4]> {
    let n = q.iter().map(|v| v * v).sum::<f64>().sqrt();
    (n.is_finite() && n > 1e-12).then(|| q.map(|v| v / n))
}
/// Android world (east, north, up) -> tracking world (east, up, south).
/// Phone source axes stay X right, Y top, Z out of the screen (-Z rear camera).
pub fn android_to_tracking(q: [f64; 4]) -> Option<[f64; 4]> {
    let s = std::f64::consts::FRAC_1_SQRT_2;
    normalized(multiply([-s, 0., 0., s], normalized(q)?))
}
fn heading_inverse(q: [f64; 4]) -> Option<[f64; 4]> {
    let [x, y, z, w] = q;
    let forward = [
        -2. * (x * z + w * y),
        2. * (w * x - y * z),
        2. * (x * x + y * y) - 1.,
    ];
    if forward[0].hypot(forward[2]) < 0.1 {
        return None;
    }
    let yaw = (-forward[0]).atan2(-forward[2]);
    Some([0., (-yaw / 2.).sin(), 0., (-yaw / 2.).cos()])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hand {
    Left = 0,
    Right = 1,
}
#[derive(Clone, Copy, Debug)]
pub enum Action {
    Select(Hand),
    Hold,
    Release,
    Cancel,
    Resume,
    Pause,
    Focus(bool),
    Recenter,
    Shutdown,
}
#[derive(Clone)]
struct Snapshot {
    number: u64,
    timestamp: u64,
    values: Vec<Value>,
}
struct Demand {
    request: Request,
    publication: Weak<Mutex<PublicationState>>,
}
struct State {
    selected: Hand,
    held: bool,
    foreground: bool,
    focused: bool,
    available: [bool; 3],
    last: [Option<u64>; 3],
    good: [bool; 3],
    orientation: Option<[f64; 4]>,
    raw: [[f64; 3]; 2],
    heading: [f64; 4],
    heading_set: bool,
    hold_started: u64,
    presses: [u64; 2],
    releases: [u64; 2],
    snapshots: [Snapshot; 4],
    demands: Vec<Demand>,
    serial: u64,
}
#[derive(Clone)]
pub struct Hub {
    pub capabilities: Arc<Capabilities>,
    state: Arc<Mutex<State>>,
    pub updates: watch::Sender<u64>,
    pub source: &'static str,
}

fn descriptor(
    c: &mut Capabilities,
    id: String,
    name: String,
    group: u32,
    kind: u8,
    formats: Vec<u8>,
    description: &str,
) -> usize {
    let index = c.descriptors.len();
    c.descriptors.push(Descriptor {
        id,
        name,
        description: description.into(),
        group,
        kind,
        formats,
        ..Default::default()
    });
    index
}
fn catalog(available: [bool; 3]) -> Capabilities {
    let mut c = Capabilities {
        groups: vec![RATE; 4],
        ..Default::default()
    };
    for hand in ["left", "right"] {
        let root = format!("/user/hand/{hand}/input/grip/pose");
        let p = descriptor(
            &mut c,
            root.clone(),
            format!("{hand} phone orientation"),
            0,
            10,
            vec![10, 11],
            "Orientation only: local gravity-aligned, yaw recentered; grip +X phone right, +Y out screen, -Z phone top (thumb). Position always invalid/zero. Active only while selected and held with fresh orientation; no prediction.",
        );
        c.descriptors[p].spaces = vec![2];
        for (suffix, kind) in [
            ("position_valid", 12),
            ("orientation_valid", 13),
            ("position_tracked", 14),
            ("orientation_tracked", 15),
        ] {
            descriptor(
                &mut c,
                format!("{root}/{suffix}"),
                format!("{hand} {suffix}"),
                0,
                kind,
                vec![1],
                "Component quality at the pose acquisition time; false means placeholder.",
            );
        }
        let d = &mut c.descriptors[p];
        d.position_valid_sample = Some((p + 1) as u32);
        d.orientation_valid_sample = Some((p + 2) as u32);
        d.position_tracked_sample = Some((p + 3) as u32);
        d.orientation_tracked_sample = Some((p + 4) as u32);
    }
    for (group, sensor, units) in [
        (1, "accelerometer", "m/s² including gravity"),
        (2, "gyroscope", "rad/s, calibrated Android sensor"),
    ] {
        // Missing hardware is not advertised as an implemented numeric source.
        if !available[group] {
            continue;
        }
        for hand in ["left", "right"] {
            for axis in ["x", "y", "z"] {
                let id = format!("/user/hand/{hand}/phone/{sensor}/{axis}");
                descriptor(
                    &mut c,
                    id.clone(),
                    format!("{hand} {sensor} {axis}"),
                    group as u32,
                    1,
                    vec![10, 11],
                    &format!(
                        "Raw {units}; phone axes X right, Y top, Z out of screen. Companion {id}/active must be true at the same acquisition time; otherwise zero placeholder. No acceleration integration."
                    ),
                );
                descriptor(
                    &mut c,
                    format!("{id}/active"),
                    format!("{hand} {sensor} {axis} active"),
                    group as u32,
                    1,
                    vec![1],
                    "True only for a fresh measurement while this hand is selected and held.",
                );
            }
        }
    }
    for hand in ["left", "right"] {
        let id = format!("/user/hand/{hand}/input/select/click");
        let p = descriptor(
            &mut c,
            id.clone(),
            format!("{hand} hold"),
            3,
            2,
            vec![1],
            "Press-and-hold clutch. False on release/cancel/pause/focus loss/hand switch/orientation loss. Requires a new touch after cancellation.",
        );
        descriptor(
            &mut c,
            format!("{id}/press_count"),
            format!("{hand} presses"),
            3,
            3,
            vec![5],
            "Observed clutch activation count.",
        );
        descriptor(
            &mut c,
            format!("{id}/release_count"),
            format!("{hand} releases"),
            3,
            4,
            vec![5],
            "Observed clutch deactivation count, including cancellation.",
        );
        descriptor(
            &mut c,
            format!("{id}/active"),
            format!("{hand} hold active"),
            3,
            1,
            vec![1],
            "UI control available only while foreground and focused; counters retain actual history.",
        );
        descriptor(
            &mut c,
            format!("/user/hand/{hand}/phone/selected"),
            format!("{hand} selected"),
            3,
            1,
            vec![1],
            "Hand assigned to this phone; selection alone does not activate tracking.",
        );
        c.descriptors[p].press_count_sample = Some((p + 1) as u32);
        c.descriptors[p].release_count_sample = Some((p + 2) as u32);
    }
    c.validate().expect("Valid phone catalog");
    c
}
impl State {
    // Callers can read BOOTTIME before contending for this lock. Serialize
    // transitions after every acquisition already observed, never backdate them.
    fn transition_time(&self, at: u64) -> u64 {
        self.snapshots
            .iter()
            .map(|s| s.timestamp)
            .chain(self.last.iter().flatten().copied())
            .fold(at, u64::max)
    }
    fn fresh(&self, sensor: usize, at: u64) -> bool {
        self.available[sensor]
            && self.good[sensor]
            && self.last[sensor].is_some_and(|t| at.saturating_sub(t) <= STALE_NS)
    }
    fn active(&self, hand: usize, sensor: usize, at: u64) -> bool {
        self.held
            && self.selected as usize == hand
            && self.foreground
            && self.focused
            && self.fresh(sensor, at)
            && self.last[sensor].is_some_and(|t| t >= self.hold_started)
    }
    fn cancel(&mut self) {
        if self.held {
            self.releases[self.selected as usize] =
                self.releases[self.selected as usize].wrapping_add(1);
        }
        self.held = false;
    }
    fn values(&self, group: usize, at: u64) -> Vec<Value> {
        let mut values = Vec::new();
        for hand in 0..2 {
            if group == 0 {
                let valid =
                    self.active(hand, 0, at) && self.orientation.is_some() && self.heading_set;
                let q = if valid {
                    normalized(multiply(
                        multiply(self.heading, self.orientation.unwrap()),
                        [
                            std::f64::consts::FRAC_1_SQRT_2,
                            0.,
                            0.,
                            std::f64::consts::FRAC_1_SQRT_2,
                        ],
                    ))
                    .unwrap()
                } else {
                    IDENTITY
                };
                values.push(Value::Numbers([vec![0.; 3], q.to_vec()].concat()));
                values.extend([false, valid, false, valid].map(Value::Bit));
            } else if group == 3 {
                values.extend([
                    Value::Bit(self.held && self.selected as usize == hand),
                    Value::Unsigned(self.presses[hand]),
                    Value::Unsigned(self.releases[hand]),
                    Value::Bit(self.foreground && self.focused),
                    Value::Bit(self.selected as usize == hand),
                ]);
            } else if self.available[group] {
                let active = self.active(hand, group, at);
                for n in self.raw[group - 1] {
                    values.push(Value::Numbers(vec![if active { n } else { 0. }]));
                    values.push(Value::Bit(active));
                }
            }
        }
        values
    }
    fn publish(&mut self, group: usize, at: u64, c: &Capabilities) {
        let at = at.max(self.snapshots[group].timestamp);
        self.serial += 1;
        let snapshot = Snapshot {
            number: self.serial,
            timestamp: at,
            values: self.values(group, at),
        };
        self.demands.retain(|d| {
            let Some(p) = d.publication.upgrade() else {
                return false;
            };
            if d.request.group as usize == group {
                let mut p = p.lock().unwrap();
                match encode(c, &d.request, &snapshot) {
                    Ok(a) => p.observe(a),
                    Err(e) => p.error = Some(e),
                }
            }
            true
        });
        self.snapshots[group] = snapshot;
    }
    fn publish_all(&mut self, at: u64, c: &Capabilities) {
        let at = self.transition_time(at);
        for group in 0..4 {
            self.publish(group, at, c);
        }
    }
}
fn encode(c: &Capabilities, r: &Request, s: &Snapshot) -> protocol::Result<EncodedAcquisition> {
    let indices: Vec<_> = c
        .descriptors
        .iter()
        .enumerate()
        .filter(|(_, d)| d.group == r.group)
        .map(|(i, _)| i as u32)
        .collect();
    let bundles = r
        .bundles
        .iter()
        .map(|b| {
            let values = b
                .iter()
                .map(|binding| {
                    indices
                        .iter()
                        .position(|i| *i == binding.descriptor)
                        .and_then(|i| s.values.get(i))
                        .cloned()
                        .ok_or_else(|| "Missing phone source".to_string())
                })
                .collect::<protocol::Result<Vec<_>>>()?;
            protocol::encode_bundle(c, b, &values)
        })
        .collect::<protocol::Result<Vec<_>>>()?;
    Ok(EncodedAcquisition {
        number: s.number,
        acquired_at: s.timestamp,
        predicted_for: None,
        bundles,
    })
}
impl Hub {
    pub fn new(available: [bool; 3], source: &'static str) -> Arc<Self> {
        Self::at(available, source, now())
    }
    pub fn at(available: [bool; 3], source: &'static str, at: u64) -> Arc<Self> {
        let c = Arc::new(catalog(available));
        let (updates, _) = watch::channel(0);
        let mut state = State {
            selected: Hand::Left,
            held: false,
            foreground: false,
            focused: false,
            available,
            last: [None; 3],
            good: [false; 3],
            orientation: None,
            raw: [[0.; 3]; 2],
            heading: IDENTITY,
            heading_set: false,
            hold_started: 0,
            presses: [0; 2],
            releases: [0; 2],
            snapshots: std::array::from_fn(|_| Snapshot {
                number: 0,
                timestamp: at,
                values: vec![],
            }),
            demands: vec![],
            serial: 0,
        };
        state.publish_all(at, &c);
        Arc::new(Self {
            capabilities: c,
            state: Arc::new(Mutex::new(state)),
            updates,
            source,
        })
    }
    pub fn now(&self) -> i64 {
        now() as i64
    }
    pub fn observe(&self, r: &Request, p: &Arc<Mutex<PublicationState>>) -> protocol::Result<()> {
        let mut s = self.state.lock().unwrap();
        p.lock().unwrap().observe(encode(
            &self.capabilities,
            r,
            &s.snapshots[r.group as usize],
        )?);
        s.demands.retain(|d| d.publication.strong_count() > 0);
        s.demands.push(Demand {
            request: r.clone(),
            publication: Arc::downgrade(p),
        });
        Ok(())
    }
    pub fn action(&self, action: Action, at: u64) {
        let mut s = self.state.lock().unwrap();
        let at = s.transition_time(at);
        match action {
            Action::Select(hand) => {
                s.cancel();
                s.selected = hand;
            }
            Action::Hold => {
                if !s.held && s.foreground && s.focused && s.fresh(0, at) && s.heading_set {
                    s.held = true;
                    s.hold_started = at;
                    let hand = s.selected as usize;
                    s.presses[hand] = s.presses[hand].wrapping_add(1);
                }
            }
            Action::Release | Action::Cancel => s.cancel(),
            Action::Pause | Action::Shutdown => {
                s.cancel();
                s.foreground = false;
                s.good = [false; 3];
            }
            Action::Resume => {
                s.cancel();
                s.foreground = true;
                s.good = [false; 3];
                // GRV yaw continuity is not guaranteed after sensor re-registration.
                s.heading_set = false;
                s.heading = IDENTITY;
                s.orientation = None;
            }
            Action::Focus(focused) => {
                s.focused = focused;
                if !focused {
                    s.cancel();
                }
            }
            Action::Recenter => {
                s.cancel();
                if s.fresh(0, at)
                    && let Some(q) = s.orientation.and_then(heading_inverse)
                {
                    s.heading = q;
                    s.heading_set = true;
                }
            }
        }
        // State transitions contain only invalid numeric placeholders. Never re-date a cached measurement.
        let good = s.good;
        s.good = [false; 3];
        s.publish_all(at, &self.capabilities);
        s.good = good;
        self.updates.send_replace(s.serial);
    }
    /// kind: 0 orientation quaternion xyzw, 1 accelerometer, 2 gyroscope.
    pub fn sensor(&self, kind: usize, timestamp: u64, values: [f64; 4], received: u64) {
        if kind > 2 {
            return;
        }
        let mut s = self.state.lock().unwrap();
        if !s.foreground || !s.available[kind] {
            return;
        }
        if timestamp > received
            || timestamp < s.snapshots[kind].timestamp
            || s.last[kind].is_some_and(|last| timestamp <= last)
        {
            return;
        }
        let quaternion = if kind == 0 {
            android_to_tracking(values)
        } else {
            None
        };
        let valid = received - timestamp <= STALE_NS
            && if kind == 0 {
                quaternion.is_some()
            } else {
                values[..3]
                    .iter()
                    .all(|v| v.is_finite() && v.abs() <= f32::MAX as f64)
            };
        s.last[kind] = Some(timestamp);
        s.good[kind] = valid;
        if !valid {
            s.cancel();
            s.publish_all(received, &self.capabilities);
        } else {
            if kind == 0 {
                s.orientation = quaternion;
                if !s.heading_set
                    && let Some(h) = quaternion.and_then(heading_inverse)
                {
                    s.heading = h;
                    s.heading_set = true;
                }
            } else {
                s.raw[kind - 1].copy_from_slice(&values[..3]);
            }
            s.publish(kind, timestamp, &self.capabilities);
        }
        self.updates.send_replace(s.serial);
    }
    pub fn tick(&self, at: u64) {
        let mut s = self.state.lock().unwrap();
        let at = s.transition_time(at);
        let stale: [bool; 3] = std::array::from_fn(|i| s.good[i] && !s.fresh(i, at));
        if stale.iter().any(|v| *v) {
            for (i, stale) in stale.iter().enumerate() {
                if *stale {
                    s.good[i] = false;
                }
            }
            if stale[0] {
                s.cancel();
                s.publish_all(at, &self.capabilities);
            } else {
                for (i, stale) in stale.iter().enumerate() {
                    if *stale {
                        s.publish(i, at, &self.capabilities);
                    }
                }
            }
            self.updates.send_replace(s.serial);
        }
    }
    pub fn status(&self, at: u64) -> String {
        let s = self.state.lock().unwrap();
        let sensor = |i: usize| {
            if !s.available[i] {
                "unavailable"
            } else if s.fresh(i, at) {
                "ready"
            } else {
                "waiting / stale"
            }
        };
        format!(
            "{} hand · {}\nOrientation: {}{}\nAccelerometer: {} · Gyroscope: {}\nPosition: UNAVAILABLE · Prediction: NONE\nGrip forward (-Z): phone top / thumb.\nRecenter upright, rear camera facing forward.\nResume resets local heading; yaw may drift.\nRelease, cancel, hand switch or leaving the app stops tracking.",
            if s.selected == Hand::Left {
                "LEFT"
            } else {
                "RIGHT"
            },
            if s.held {
                "HELD — tracking orientation"
            } else {
                "INACTIVE — hold to track"
            },
            sensor(0),
            if s.heading_set {
                ""
            } else {
                " — point rear camera forward"
            },
            sensor(1),
            sensor(2)
        )
    }
    pub fn held(&self) -> bool {
        self.state.lock().unwrap().held
    }
    pub fn selected(&self) -> Hand {
        self.state.lock().unwrap().selected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn upright() -> [f64; 4] {
        let s = std::f64::consts::FRAC_1_SQRT_2;
        [s, 0., 0., s]
    }
    fn hub() -> Arc<Hub> {
        let h = Hub::at([true; 3], "test", 0);
        h.action(Action::Resume, 1);
        h.action(Action::Focus(true), 1);
        h.sensor(0, 2, upright(), 2);
        h
    }
    fn bit(h: &Hub, group: usize, index: usize) -> bool {
        match h.state.lock().unwrap().snapshots[group].values[index] {
            Value::Bit(b) => b,
            _ => panic!("not a bit"),
        }
    }
    fn pose(h: &Hub, index: usize) -> Vec<f64> {
        match &h.state.lock().unwrap().snapshots[0].values[index] {
            Value::Numbers(v) => v.clone(),
            _ => panic!(),
        }
    }
    #[test]
    fn old_clock_read_cannot_cancel_a_fresh_source_or_backdate_transitions() {
        let h = hub();
        h.action(Action::Hold, 3);
        h.sensor(0, 4, upright(), 4);
        h.tick(3); // Timer read time, then a newer acquisition won the lock.
        assert!(h.held());
        assert!(bit(&h, 0, 2));
        assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 4);
        assert!(h.state.lock().unwrap().fresh(0, 3));
        h.sensor(1, 6, [1., 2., 3., 0.], 6);
        h.action(Action::Release, 3);
        assert!(!h.held());
        assert!(!bit(&h, 0, 2));
        assert!(
            h.state
                .lock()
                .unwrap()
                .snapshots
                .iter()
                .all(|s| s.timestamp == 6)
        );
        h.action(Action::Hold, 7);
        h.sensor(0, 10, upright(), 10);
        // An invalid sample from another acquisition group also cannot backdate release.
        h.sensor(1, 8, [f64::NAN, 0., 0., 0.], 8);
        assert!(!h.held());
        assert!(
            h.state
                .lock()
                .unwrap()
                .snapshots
                .iter()
                .all(|s| s.timestamp == 10)
        );
        h.tick(9);
        assert!(
            h.state
                .lock()
                .unwrap()
                .snapshots
                .iter()
                .all(|s| s.timestamp == 10)
        );
    }
    #[test]
    fn resume_requires_a_fresh_heading_without_grv_yaw_continuity() {
        let h = hub();
        h.action(Action::Pause, 3);
        h.action(Action::Resume, 4);
        assert!(!h.state.lock().unwrap().heading_set);
        h.action(Action::Hold, 5);
        assert!(!h.held());
        let restarted = multiply([0., 0., 0.5f64.sqrt(), 0.5f64.sqrt()], upright());
        h.sensor(0, 6, restarted, 6);
        h.action(Action::Hold, 7);
        h.sensor(0, 8, restarted, 8);
        let p = pose(&h, 0);
        for (actual, expected) in p[3..].iter().zip(upright()) {
            assert!((actual - expected).abs() < 1e-12);
        }
    }
    #[test]
    fn hold_release_hand_switch_and_cancel_are_exclusive() {
        let h = hub();
        assert!(!h.held());
        h.action(Action::Hold, 3);
        assert!(h.held());
        assert!(!bit(&h, 0, 2), "No stale measurement retimestamped on hold");
        h.sensor(0, 4, upright(), 4);
        assert!(bit(&h, 0, 2));
        assert!(!bit(&h, 0, 7));
        h.action(Action::Select(Hand::Right), 5);
        assert!(!h.held());
        assert!(!bit(&h, 0, 2));
        assert!(!bit(&h, 0, 7));
        h.action(Action::Hold, 6);
        h.sensor(0, 7, upright(), 7);
        assert!(bit(&h, 0, 7));
        assert!(!bit(&h, 0, 2));
        h.action(Action::Cancel, 8);
        assert!(!h.held());
        assert!(!bit(&h, 0, 7));
        h.action(Action::Hold, 9);
        h.sensor(0, 10, upright(), 10);
        h.action(Action::Release, 11);
        assert!(!h.held());
        assert_eq!(pose(&h, 5), [0., 0., 0., 0., 0., 0., 1.]);
        let s = h.state.lock().unwrap();
        assert_eq!(s.presses, [1, 2]);
        assert_eq!(s.releases, [1, 2]);
    }
    #[test]
    fn pause_focus_loss_shutdown_and_stale_cancel_without_reactivation() {
        for action in [Action::Pause, Action::Focus(false), Action::Shutdown] {
            let h = hub();
            h.action(Action::Hold, 3);
            h.sensor(0, 4, upright(), 4);
            h.action(action, 5);
            assert!(!h.held());
            assert!(!bit(&h, 0, 2));
            h.action(Action::Resume, 6);
            h.action(Action::Focus(true), 6);
            h.sensor(0, 7, upright(), 7);
            assert!(!h.held());
        }
        let h = hub();
        h.action(Action::Hold, 3);
        h.sensor(0, 4, upright(), 4);
        h.tick(STALE_NS + 5);
        assert!(!h.held());
        assert!(!bit(&h, 0, 2));
        h.sensor(0, STALE_NS + 6, upright(), STALE_NS + 6);
        assert!(!h.held());
    }
    #[test]
    fn coordinate_mapping_and_recenter_preserve_gravity_and_grip_axes() {
        let q = android_to_tracking(upright()).unwrap();
        assert!(q[..3].iter().all(|v| v.abs() < 1e-12));
        assert!((q[3] - 1.).abs() < 1e-12);
        let h = hub();
        h.action(Action::Hold, 3);
        h.sensor(0, 4, upright(), 4);
        let p = pose(&h, 0);
        assert_eq!(&p[..3], &[0.; 3]);
        let expected = upright();
        for i in 0..4 {
            assert!((p[i + 3] - expected[i]).abs() < 1e-12);
        }
        // Grip -Z maps to the portrait phone's +Y; no manufactured position.
        let v = multiply(
            multiply(expected, [0., 0., -1., 0.]),
            [-expected[0], 0., 0., expected[3]],
        );
        assert!((v[1] - 1.).abs() < 1e-12);
        assert!(!bit(&h, 0, 1));
        assert!(!bit(&h, 0, 3));
        assert!(bit(&h, 0, 4));
        h.action(Action::Release, 5);
        let yaw = multiply([0., 0., 0.5f64.sqrt(), 0.5f64.sqrt()], upright());
        h.sensor(0, 6, yaw, 6);
        h.action(Action::Recenter, 7);
        h.action(Action::Hold, 8);
        h.sensor(0, 9, yaw, 9);
        let p = pose(&h, 0);
        for i in 0..4 {
            assert!((p[i + 3] - expected[i]).abs() < 1e-12);
        }
    }
    #[test]
    fn timestamps_cached_repeats_invalid_samples_and_missing_sensors() {
        let h = hub();
        h.action(Action::Hold, 3);
        h.sensor(0, 4, upright(), 4);
        h.sensor(1, 5, [1., 2., 3., 0.], 6);
        h.sensor(2, 6, [4., 5., 6., 0.], 7);
        let s = h.state.lock().unwrap();
        assert_eq!(s.snapshots[0].timestamp, 4);
        assert_eq!(s.snapshots[1].timestamp, 5);
        assert_eq!(s.snapshots[2].timestamp, 6);
        drop(s);
        h.sensor(0, 3, upright(), 8);
        assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 4);
        h.sensor(0, 99, upright(), 8);
        assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 4);
        h.sensor(0, 9, [f64::NAN, 0., 0., 1.], 9);
        assert!(!h.held());
        assert!(!bit(&h, 0, 2));
        let missing = Hub::at([false, false, false], "missing", 0);
        missing.action(Action::Resume, 1);
        missing.action(Action::Focus(true), 1);
        missing.action(Action::Hold, 2);
        assert!(!missing.held());
        assert!(
            !missing
                .capabilities
                .descriptors
                .iter()
                .any(|d| d.id.contains("accelerometer"))
        );
        assert!(android_to_tracking([0.; 4]).is_none());
    }
    #[test]
    fn clutch_invalidation_observed_during_blocked_transport_and_exact_ack() {
        let h = hub();
        h.action(Action::Hold, 3);
        h.sensor(0, 4, upright(), 4);
        let r = Request {
            id: 1,
            group: 0,
            channel: 1,
            interval: 10_000_000,
            phase: 0,
            prediction_offset: 40_000_000,
            sequence_number_format: Some(protocol::SequenceNumberFormat::U32),
            bundles: vec![
                vec![],
                vec![protocol::SampleBinding {
                    descriptor: 2,
                    format: 1,
                    space: 0,
                }],
            ],
        };
        let p = Arc::new(Mutex::new(PublicationState::new(&r, 4)));
        h.observe(&r, &p).unwrap();
        let old = p.lock().unwrap().candidate().unwrap();
        assert_eq!(old.body[25], 1);
        p.lock().unwrap().submitted(old);
        h.action(Action::Release, 5);
        h.action(Action::Hold, 6);
        h.sensor(0, 7, upright(), 7);
        p.lock().unwrap().acknowledge(0);
        let pending = p.lock().unwrap().candidate().unwrap();
        assert_eq!(
            pending.body[25], 1,
            "ABA reactivation remains pending despite old ACK"
        );
        assert_eq!(
            u64::from_le_bytes(pending.body[12..20].try_into().unwrap()),
            u64::MAX,
            "Requested prediction offset is not a returned target"
        );
        h.action(Action::Pause, 8);
        let inactive = p.lock().unwrap().candidate().unwrap();
        assert_eq!(inactive.body[25], 0);
    }
}
