//! Phone source policies: Android BOOTTIME acquisition timestamps, no prediction.
#[cfg(test)]
#[path = "displacement_tests.rs"]
mod displacement_tests;
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
pub(crate) fn normalized(q: [f64; 4]) -> Option<[f64; 4]> {
    let n = q.iter().map(|v| v * v).sum::<f64>().sqrt();
    (n.is_finite() && n > 1e-12).then(|| q.map(|v| v / n))
}
/// Android world (east, north, up) -> tracking world (east, up, south).
/// Phone source axes stay X right, Y top, Z out of the screen (-Z rear camera).
pub fn android_to_tracking(q: [f64; 4]) -> Option<[f64; 4]> {
    let s = std::f64::consts::FRAC_1_SQRT_2;
    normalized(multiply([-s, 0., 0., s], normalized(q)?))
}
pub(crate) fn heading_inverse(q: [f64; 4]) -> Option<[f64; 4]> {
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
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TrackingMode {
    Orientation,
    Displacement,
    Spatial,
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
    spatial: Option<crate::spatial::SpatialState>,
    displacement: Option<crate::displacement::Estimator>,
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
            format!("{hand} phone grip"),
            0,
            10,
            vec![10, 11],
            "Local gravity-aligned grip (+X phone right, +Y out of screen, -Z phone top). Position is tracked with ARCore, estimated with IMU displacement, or unavailable with orientation alone. Read the component validity and tracking flags at the same acquisition time.",
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
        if let Some(d) = &mut self.displacement {
            d.end();
        }
    }
    fn values(&self, group: usize, at: u64) -> Vec<Value> {
        let mut values = Vec::new();
        for hand in 0..2 {
            if group == 0 {
                if let Some(d) = &self.displacement {
                    let estimate = d.estimate.filter(|e| {
                        self.held
                            && self.selected as usize == hand
                            && self.foreground
                            && self.focused
                            && self.good[0]
                            && self.good[1]
                            && e.at >= self.hold_started
                            && at.saturating_sub(e.at) <= STALE_NS
                    });
                    let pose = estimate.map_or(crate::spatial::Pose::IDENTITY, |e| e.pose);
                    let valid = estimate.is_some();
                    values.push(Value::Numbers(
                        [pose.position.to_vec(), pose.orientation.to_vec()].concat(),
                    ));
                    // Numerically usable dead reckoning is not physically tracked position.
                    values.extend([valid, valid, false, valid].map(Value::Bit));
                    continue;
                }
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
                if let Some(spatial) = &self.spatial {
                    let valid = valid && spatial.origin && spatial.pose.is_some();
                    let pose = if valid {
                        spatial.pose.unwrap()
                    } else {
                        crate::spatial::Pose::IDENTITY
                    };
                    values.push(Value::Numbers(
                        [pose.position.to_vec(), pose.orientation.to_vec()].concat(),
                    ));
                    values.extend([valid; 4].map(Value::Bit));
                } else {
                    values.push(Value::Numbers([vec![0.; 3], q.to_vec()].concat()));
                    values.extend([false, valid, false, valid].map(Value::Bit));
                }
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
        Self::with_mode(available, source, at, false, false)
    }
    pub fn spatial_at(mut available: [bool; 3], source: &'static str, at: u64) -> Arc<Self> {
        available[0] = true;
        Self::with_mode(available, source, at, true, false)
    }
    pub fn displacement_at(available: [bool; 3], source: &'static str, at: u64) -> Arc<Self> {
        Self::with_mode(available, source, at, false, true)
    }
    fn with_mode(
        available: [bool; 3],
        source: &'static str,
        at: u64,
        spatial: bool,
        displacement: bool,
    ) -> Arc<Self> {
        let c = Arc::new(catalog(available));
        let (updates, _) = watch::channel(0);
        let mut state = State {
            spatial: spatial.then(Default::default),
            displacement: displacement.then(Default::default),
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
    pub fn set_tracking_mode(&self, mode: TrackingMode, has_rotation_sensor: bool, at: u64) {
        let mut s = self.state.lock().unwrap();
        let spatial = mode == TrackingMode::Spatial;
        let displacement = mode == TrackingMode::Displacement;
        if spatial == s.spatial.is_some() && displacement == s.displacement.is_some() {
            return;
        }
        let at = s.transition_time(at);
        s.cancel();
        s.spatial = spatial.then(|| crate::spatial::SpatialState {
            generation: at,
            ..Default::default()
        });
        s.displacement = displacement.then(|| {
            let mut estimator = crate::displacement::Estimator::default();
            estimator.resume(at);
            estimator
        });
        s.available[0] = spatial || has_rotation_sensor;
        s.last = [None; 3];
        s.good = [false; 3];
        s.orientation = None;
        s.heading = IDENTITY;
        s.heading_set = false;
        s.publish_all(at, &self.capabilities);
        self.updates.send_replace(s.serial);
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
        if matches!(action, Action::Resume)
            && let Some(d) = &mut s.displacement
        {
            d.resume(at);
        }
        if let Some(spatial) = &mut s.spatial {
            match action {
                Action::Pause
                | Action::Shutdown
                | Action::Resume
                | Action::Focus(false)
                | Action::Recenter => {
                    spatial.invalidate("Origin cleared — recenter after tracking is ready");
                    spatial.recenter = matches!(action, Action::Recenter);
                    if matches!(action, Action::Resume) {
                        spatial.clock = Default::default();
                    }
                    s.heading_set = false;
                    s.good[0] = false;
                }
                _ => {}
            }
        }
        match action {
            Action::Select(hand) => {
                s.cancel();
                s.selected = hand;
            }
            Action::Hold => {
                if !s.held
                    && s.foreground
                    && s.focused
                    && s.fresh(0, at)
                    && s.heading_set
                    && s.displacement
                        .as_ref()
                        .is_none_or(|d| s.fresh(1, at) && d.ready(at))
                {
                    s.held = true;
                    s.hold_started = at;
                    let hand = s.selected as usize;
                    s.presses[hand] = s.presses[hand].wrapping_add(1);
                    let heading = s.heading;
                    if let Some(d) = &mut s.displacement {
                        d.begin(at, heading);
                    }
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
                if s.spatial.is_none()
                    && s.fresh(0, at)
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
        if s.displacement.is_some() {
            self.displacement_sensor(&mut s, kind, timestamp, values, received);
            return;
        }
        // The AR app never substitutes IMU orientation for a spatial pose.
        if kind == 0 && s.spatial.is_some() {
            return;
        }
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
    fn displacement_sensor(
        &self,
        s: &mut State,
        kind: usize,
        timestamp: u64,
        values: [f64; 4],
        received: u64,
    ) {
        if !s.foreground
            || !s.available[kind]
            || !s.displacement.as_ref().unwrap().in_epoch(timestamp)
        {
            return;
        }
        if s.last[kind] == Some(timestamp) {
            return;
        } // Duplicate: no new sample/freshness.
        let q = if kind == 0 {
            android_to_tracking(values)
        } else {
            None
        };
        let error = if timestamp > received {
            Some("Future IMU timestamp")
        } else if s.last[kind].is_some_and(|t| timestamp < t) {
            Some("Out-of-order IMU timestamp")
        } else if received - timestamp > STALE_NS {
            Some("Stale IMU source")
        } else if (kind == 0 && q.is_none())
            || (kind != 0
                && values[..3]
                    .iter()
                    .any(|v| !v.is_finite() || v.abs() > f32::MAX as f64))
        {
            Some("Invalid IMU source value")
        } else if kind < 2
            && s.held
            && s.last[kind].is_some_and(|t| timestamp - t > crate::displacement::MAX_GAP_NS)
        {
            Some("Required IMU source gap exceeds 50 ms")
        } else {
            None
        };
        if let Some(reason) = error {
            s.good[kind] = false;
            if kind < 2 {
                s.cancel();
                s.displacement.as_mut().unwrap().invalidate(reason);
                s.publish_all(received, &self.capabilities);
            } else {
                s.publish(2, s.transition_time(received), &self.capabilities);
            }
            self.updates.send_replace(s.serial);
            return;
        }
        s.last[kind] = Some(timestamp);
        s.good[kind] = true;
        let result = if kind == 0 {
            s.orientation = q;
            if !s.heading_set
                && let Some(h) = q.and_then(heading_inverse)
            {
                s.heading = h;
                s.heading_set = true;
            }
            s.displacement
                .as_mut()
                .unwrap()
                .orientation(timestamp, q.unwrap(), received)
        } else {
            s.raw[kind - 1].copy_from_slice(&values[..3]);
            if kind == 1 {
                s.displacement
                    .as_mut()
                    .unwrap()
                    .acceleration(timestamp, s.raw[0], received)
            } else {
                Ok(None)
            }
        };
        match result {
            Ok(estimate) => {
                // A late sensor still refreshes source availability. Only its
                // publication is skipped if a newer UI placeholder already won.
                if kind != 0 && timestamp >= s.snapshots[kind].timestamp {
                    s.publish(kind, timestamp, &self.capabilities);
                }
                if let Some(e) = estimate
                    && e.at >= s.snapshots[0].timestamp
                {
                    s.publish(0, e.at, &self.capabilities);
                }
            }
            Err(reason) => {
                s.cancel();
                s.displacement.as_mut().unwrap().invalidate(reason);
                s.publish_all(received, &self.capabilities);
            }
        }
        self.updates.send_replace(s.serial);
    }
    pub fn tick(&self, at: u64) {
        let mut s = self.state.lock().unwrap();
        let at = s.transition_time(at);
        if s.displacement.as_ref().is_some_and(|d| d.expired(at)) {
            s.cancel();
            s.displacement
                .as_mut()
                .unwrap()
                .invalidate("Aligned IMU source stalled; new hold required");
            s.publish_all(at, &self.capabilities);
            self.updates.send_replace(s.serial);
        }
        let stale: [bool; 3] = std::array::from_fn(|i| s.good[i] && !s.fresh(i, at));
        if stale.iter().any(|v| *v) {
            for (i, stale) in stale.iter().enumerate() {
                if *stale {
                    s.good[i] = false;
                }
            }
            if stale[0] || (stale[1] && s.displacement.is_some()) {
                if let Some(spatial) = &mut s.spatial {
                    spatial.invalidate("Camera frame stalled — recenter required");
                }
                s.cancel();
                if let Some(d) = &mut s.displacement {
                    d.invalidate("Required IMU source stale; new hold required");
                }
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
        if let Some(d) = &s.displacement {
            return format!(
                "{:?} hand · {}\nIMU displacement estimate — position NOT TRACKED\n{}\nPosition (m): {:?}\nVelocity estimate (m/s): {:?}\nEach hold starts at zero displacement/velocity on first aligned sample.\nGravity:9.80665m/s² · heading fixed during hold\nNo damping, deadband or drift correction. No prediction.\nAlignment: orientation brackets acceleration within25ms each side. Gaps>50ms cancel.\nAccelerometer/orientation loss cancels hold; press again after recovery.",
                s.selected,
                if s.held { "HELD" } else { "INACTIVE" },
                d.status,
                d.estimate.map(|e| e.pose.position),
                d.estimate.map(|e| e.velocity)
            );
        }
        if let Some(spatial) = &s.spatial {
            return format!(
                "{:?} hand · {}\n{}\nOrigin: {} · camera pose: {}\nSensor-origin position (m): {:?}\nGrip quaternion xyzw: {:?}\n{}\nNo prediction. Raw IMU available as advertised.\nKeep rear camera unobstructed. Recenter upright, then hold.\nExperimental local reference; not a fixed robot frame.",
                s.selected,
                if s.held { "HELD" } else { "INACTIVE" },
                spatial.status,
                if spatial.origin {
                    "established"
                } else {
                    "recenter required"
                },
                if s.fresh(0, at) {
                    "fresh"
                } else {
                    "unavailable / stale"
                },
                spatial.pose.map(|p| p.position),
                spatial.pose.map(|p| p.orientation),
                spatial.diagnostics
            );
        }
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
    /// Worker token rejects results crossing pause, focus loss or recenter.
    pub fn spatial_context(&self) -> (u64, bool, bool) {
        let s = self.state.lock().unwrap();
        let Some(a) = &s.spatial else {
            return (0, false, false);
        };
        (a.generation, s.foreground && s.focused, a.recenter)
    }
    pub fn spatial_failure(&self, generation: u64, reason: &str, at: u64) {
        let mut s = self.state.lock().unwrap();
        let Some(a) = &mut s.spatial else { return };
        if a.generation != generation {
            return;
        }
        a.invalidate(reason);
        s.good[0] = false;
        s.heading_set = false;
        s.cancel();
        s.publish_all(at, &self.capabilities);
        self.updates.send_replace(s.serial);
    }
    pub fn spatial_frame(&self, f: crate::spatial::Frame) {
        use crate::spatial::{Acquisition, relative_grip};
        let mut s = self.state.lock().unwrap();
        if !s.foreground || !s.focused {
            return;
        }
        let Some(a) = &mut s.spatial else { return };
        if f.generation != a.generation {
            return;
        }
        let capture_age = f
            .metadata_timestamp
            .and_then(|ns| u64::try_from(ns).ok())
            .and_then(|ns| f.query_finished.checked_sub(ns));
        a.diagnostics = format!(
            "ARCore frame ns: {} · camera capture ns: {:?}\nREALTIME: {} · query BOOTTIME: {}..{}\nCapture age at return ns: {:?} (not measured physical latency)",
            f.timestamp,
            f.metadata_timestamp,
            f.realtime,
            f.query_started,
            f.query_finished,
            capture_age
        );
        let result = if !f.tracking {
            Err("Camera PAUSED/STOPPED — recenter required")
        } else if a.origin && f.anchor.is_none() {
            Err("Origin anchor PAUSED/STOPPED — recenter required")
        } else {
            a.clock.observe(&f)
        };
        let result = result.and_then(|acquisition| {
            let Acquisition::New(capture_time) = acquisition else {
                return Ok(None);
            };
            if f.created_origin && a.recenter {
                a.origin = true;
                a.recenter = false;
            }
            if !a.origin {
                a.status = "Camera ready — press Recenter to establish origin".into();
                return Ok(None);
            }
            let pose = f
                .anchor
                .and_then(|anchor| relative_grip(f.sensor, anchor))
                .ok_or("Invalid sensor/origin pose — recenter required")?;
            Ok(Some((capture_time, pose)))
        });
        match result {
            Ok(Some((timestamp, pose))) => {
                let a = s.spatial.as_mut().unwrap();
                a.pose = Some(pose);
                a.status = "ARCore TRACKING · verified frame clock".into();
                s.last[0] = Some(timestamp);
                s.good[0] = true;
                s.heading_set = true;
                s.orientation = Some(IDENTITY);
                // Camera frames can arrive after newer UI placeholders. They
                // still establish source freshness, even though publishing
                // them would regress the group's timestamp. active() separately
                // requires a capture after the hold began. Never retime a frame.
                if timestamp < s.snapshots[0].timestamp {
                    return;
                }
                s.publish(0, timestamp, &self.capabilities);
                self.updates.send_replace(s.serial);
            }
            Ok(None) => {} // Cached frames never refresh acquisition/freshness.
            Err(reason) => {
                s.spatial.as_mut().unwrap().invalidate(reason);
                s.good[0] = false;
                s.heading_set = false;
                s.cancel();
                s.publish_all(f.query_finished, &self.capabilities);
                self.updates.send_replace(s.serial);
            }
        }
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

#[cfg(test)]
mod spatial_tests {
    use super::*;
    use crate::spatial::{Frame, Pose};
    fn frame(h: &Hub, t: u64) -> Frame {
        Frame {
            generation: h.spatial_context().0,
            timestamp: t as i64,
            metadata_timestamp: Some(t as i64),
            realtime: true,
            query_started: t,
            query_finished: t + 1,
            tracking: true,
            sensor: Pose {
                position: [1., 2., 3.],
                ..Pose::IDENTITY
            },
            anchor: Some(Pose::IDENTITY),
            created_origin: false,
        }
    }
    #[test]
    fn switching_sources_releases_hold_and_rejects_old_camera_frames() {
        let hub = ready();
        hub.action(Action::Hold, 20);
        assert!(hub.held());
        let old = frame(&hub, 21);
        hub.set_tracking_mode(TrackingMode::Orientation, true, 22);
        hub.spatial_frame(old);
        assert!(!hub.held());
        assert!(!position_valid(&hub, 0));

        hub.action(Action::Hold, 23);
        assert!(!hub.held());
        let upright = std::f64::consts::FRAC_1_SQRT_2;
        hub.sensor(0, 24, [upright, 0., 0., upright], 24);
        hub.action(Action::Hold, 25);
        assert!(hub.held());
        hub.set_tracking_mode(TrackingMode::Displacement, true, 26);
        assert!(!hub.held());
        hub.set_tracking_mode(TrackingMode::Spatial, true, 27);
        hub.spatial_frame(old);
        assert_ne!(old.generation, hub.spatial_context().0);
        assert!(!position_valid(&hub, 0));
    }

    fn ready() -> Arc<Hub> {
        let h = Hub::spatial_at([true; 3], "SYNTHETIC test", 0);
        h.action(Action::Resume, 1);
        h.action(Action::Focus(true), 2);
        h.action(Action::Recenter, 3);
        let mut f = frame(&h, 10);
        f.created_origin = true;
        h.spatial_frame(f);
        h.action(Action::Hold, 11);
        h.spatial_frame(frame(&h, 20));
        h
    }
    fn position_valid(h: &Hub, hand: usize) -> bool {
        matches!(
            h.state.lock().unwrap().snapshots[0].values[hand * 5 + 1],
            Value::Bit(true)
        )
    }
    #[test]
    fn delayed_pre_action_frames_refresh_source_without_backdating_publications() {
        const MS: u64 = 1_000_000;
        for delay in [110 * MS, 200 * MS] {
            for action in [
                Action::Hold,
                Action::Release,
                Action::Select(Hand::Right),
                Action::Cancel,
            ] {
                let h = Hub::spatial_at([true; 3], "delayed SYNTHETIC camera", 0);
                h.action(Action::Resume, 1);
                h.action(Action::Focus(true), 2);
                h.action(Action::Recenter, 3);
                let mut first = frame(&h, 1000 * MS);
                first.created_origin = true;
                first.query_started = 1000 * MS + delay - MS;
                first.query_finished = 1000 * MS + delay;
                h.spatial_frame(first);
                let expect_held = matches!(action, Action::Hold);
                if !expect_held {
                    h.action(Action::Hold, first.query_finished);
                }
                let action_at = first.query_finished + 1;
                h.action(action, action_at);
                let mut previous_publication = action_at;
                let mut latest_return = action_at;
                for k in 1..15 {
                    let mut f = frame(&h, 1000 * MS + 33 * MS * k);
                    f.query_started = f.timestamp as u64 + delay - MS;
                    f.query_finished = f.timestamp as u64 + delay;
                    h.spatial_frame(f);
                    h.tick(f.query_finished);
                    latest_return = f.query_finished;
                    assert_eq!(h.held(), expect_held, "Delay {delay}, action {action:?}");
                    let s = h.state.lock().unwrap();
                    assert!(
                        s.spatial.as_ref().unwrap().origin,
                        "Fresh delayed source keeps origin"
                    );
                    let published = s.snapshots[0].timestamp;
                    assert!(published >= previous_publication);
                    previous_publication = published;
                    assert_eq!(s.last[0], Some(f.timestamp as u64));
                    drop(s);
                    assert_eq!(
                        position_valid(&h, 0),
                        expect_held && f.timestamp as u64 >= action_at
                    );
                }
                if !expect_held {
                    h.action(Action::Hold, latest_return + 1);
                    assert!(
                        h.held(),
                        "Release/select/cancel must not require another origin"
                    );
                }
                h.tick(latest_return + STALE_NS + 1);
                assert!(!h.held(), "A real camera stall must still cancel");
            }
        }
    }
    #[test]
    fn spatial_hold_publishes_at_camera_capture_time_when_sdk_timestamps_differ() {
        let h = Hub::spatial_at([true; 3], "SYNTHETIC separate frame clock", 0);
        h.action(Action::Resume, 1);
        h.action(Action::Focus(true), 2);
        h.action(Action::Recenter, 3);
        let capture = 1_000_000_000;
        let mut f = frame(&h, capture);
        f.timestamp += 21_636_872;
        f.created_origin = true;
        h.spatial_frame(f);
        h.action(Action::Hold, capture + 10);
        assert!(h.held());
        let mut next = frame(&h, capture + 33_333_333);
        next.timestamp += 21_636_872;
        h.spatial_frame(next);
        assert!(position_valid(&h, 0));
        assert_eq!(
            h.state.lock().unwrap().snapshots[0].timestamp,
            capture + 33_333_333
        );
        h.action(Action::Release, next.query_finished + 1);
        assert!(!position_valid(&h, 0));
    }
    #[test]
    fn fresh_repeats_do_not_release_retime_or_create_acquisitions_but_stall_does() {
        let h = ready();
        assert!(h.held());
        assert!(position_valid(&h, 0));
        let serial = h.state.lock().unwrap().serial;
        for t in [30, 40, 100, 1000] {
            let mut f = frame(&h, 20);
            f.query_started = t;
            f.query_finished = t + 1;
            h.spatial_frame(f);
            h.tick(t);
            assert!(h.held());
            assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 20);
            assert_eq!(h.state.lock().unwrap().serial, serial);
        }
        h.spatial_frame(frame(&h, 2000));
        assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 2000);
        let mut f = frame(&h, 2000);
        f.query_started = 2000 + STALE_NS;
        f.query_finished = f.query_started + 1;
        h.spatial_frame(f);
        assert!(!h.held());
        assert!(!position_valid(&h, 0));
        h.spatial_frame(frame(&h, 3000 + STALE_NS));
        h.action(Action::Hold, 3002 + STALE_NS);
        assert!(!h.held()); // explicit recenter still required
    }
    #[test]
    fn camera_and_anchor_loss_require_recenter_and_new_press() {
        for anchor_loss in [false, true] {
            let h = ready();
            let mut f = frame(&h, 30);
            if anchor_loss {
                f.anchor = None;
            } else {
                f.tracking = false;
            }
            h.spatial_frame(f);
            assert!(!h.held());
            h.spatial_frame(frame(&h, 40));
            h.action(Action::Hold, 42);
            assert!(!h.held());
            h.action(Action::Recenter, 43);
            let mut f = frame(&h, 50);
            f.created_origin = true;
            h.spatial_frame(f);
            assert!(!h.held());
            h.action(Action::Hold, 52);
            h.spatial_frame(frame(&h, 60));
            assert!(h.held());
            assert!(position_valid(&h, 0));
            let s = h.state.lock().unwrap();
            assert_eq!(s.presses[0], 2);
            assert_eq!(s.releases[0], 1);
        }
    }
    #[test]
    fn late_worker_results_cannot_cross_lifecycle_or_recenter_generation() {
        for action in [
            Action::Pause,
            Action::Shutdown,
            Action::Focus(false),
            Action::Recenter,
            Action::Resume,
        ] {
            let h = ready();
            let pending = frame(&h, 100);
            h.action(action, 30);
            h.spatial_frame(pending);
            assert!(!h.held());
            assert!(!position_valid(&h, 0));
            h.spatial_failure(pending.generation, "obsolete worker error", 110);
            assert!(!h.status(110).contains("obsolete worker error"));
        }
    }
    #[test]
    fn hand_cancel_clock_failures_and_imu_cannot_substitute_spatial_source() {
        let h = ready();
        h.action(Action::Select(Hand::Right), 30);
        assert!(!h.held());
        h.spatial_frame(frame(&h, 40));
        h.action(Action::Hold, 42);
        h.spatial_frame(frame(&h, 50));
        assert!(!position_valid(&h, 0));
        assert!(position_valid(&h, 1));
        let mut f = frame(&h, 60);
        f.metadata_timestamp = None;
        h.spatial_frame(f);
        assert!(!h.held());
        h.sensor(0, 70, [0., 0., 0., 1.], 70);
        h.action(Action::Hold, 80);
        assert!(!h.held());
        assert!(!position_valid(&h, 1));
        let h = ready();
        h.action(Action::Cancel, 25);
        h.spatial_frame(frame(&h, 30));
        assert!(!h.held());
        let h = ready();
        h.tick(STALE_NS + 100);
        assert!(!h.held());
        assert!(!position_valid(&h, 0));
    }
    #[test]
    fn spatial_raw_groups_keep_real_acquisition_and_quality_together() {
        let h = ready();
        h.sensor(1, 25, [0., 9.81, 0., 0.], 25);
        let s = h.state.lock().unwrap();
        assert_eq!(s.snapshots[0].timestamp, 20);
        assert_eq!(s.snapshots[1].timestamp, 25);
        assert!(matches!(s.snapshots[1].values[3], Value::Bit(true)));
        assert!(matches!(&s.snapshots[0].values[0],Value::Numbers(v) if v[..3]==[1.,2.,3.]));
    }
}
