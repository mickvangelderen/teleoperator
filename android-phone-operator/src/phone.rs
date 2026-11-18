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
pub(crate) fn heading_inverse(q: [f64; 4]) -> [f64; 4] {
    let [x, y, z, w] = q;
    let forward = [
        -2. * (x * z + w * y),
        2. * (w * x - y * z),
        2. * (x * x + y * y) - 1.,
    ];
    // With the rear camera pointing straight up or down, the phone's right
    // axis still defines yaw. Use this basis only when acquiring a heading.
    let yaw = if forward[0].hypot(forward[2]) < 0.1 {
        let right = crate::spatial::rotate(q, [1., 0., 0.]);
        (-right[2]).atan2(right[0])
    } else {
        (-forward[0]).atan2(-forward[2])
    };
    [0., (-yaw / 2.).sin(), 0., (-yaw / 2.).cos()]
}

#[derive(Clone, Copy, Debug)]
pub enum Action {
    SetInput(i32),
    SetTrigger(f64),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
    OrientationOnly,
    Ready,
    Waiting,
    Unavailable,
    Calibrating,
    Recovering,
    Tracking,
}

#[derive(Clone, Copy, PartialEq)]
pub struct HandsetStatus {
    pub input: i32,
    pub trigger: f64,
    pub presses: u64,
    pub releases: u64,
    pub position_valid: bool,
    pub held: bool,
    pub mode: TrackingMode,
    pub motion: Motion,
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
    input: i32,
    trigger: f64,
    epoch: u64,
    reference_since: u64,
    // Sensor rotations around each camera capture for matching AR and IMU headings.
    rotations: std::collections::VecDeque<(u64, [f64; 4])>,
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
    presses: u64,
    releases: u64,
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
    {
        let root = "/phone/input/grip/pose".to_string();
        let p = descriptor(
            &mut c,
            root.clone(),
            "Phone grip".into(),
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
                format!("Phone {suffix}"),
                0,
                kind,
                vec![1],
                "Component quality at the pose acquisition time; validity identifies measured or estimated components; tracking identifies currently tracked components.",
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
        for axis in ["x", "y", "z"] {
            let id = format!("/phone/{sensor}/{axis}");
            descriptor(
                &mut c,
                id.clone(),
                format!("Phone {sensor} {axis}"),
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
                format!("Phone {sensor} {axis} active"),
                group as u32,
                1,
                vec![1],
                "True only for a fresh measurement in the active sensor session.",
            );
        }
    }
    let id = "/phone/input/deadman/click";
    let p = descriptor(
        &mut c,
        id.into(),
        "Deadman pressed".into(),
        3,
        2,
        vec![1],
        "True while the deadman pad is deliberately held.",
    );
    descriptor(
        &mut c,
        format!("{id}/press_count"),
        "Deadman presses".into(),
        3,
        3,
        vec![5],
        "Cumulative deliberate presses.",
    );
    descriptor(
        &mut c,
        format!("{id}/release_count"),
        "Deadman releases".into(),
        3,
        4,
        vec![5],
        "Cumulative releases, including cancellation or loss of focus.",
    );
    c.descriptors[p].press_count_sample = Some((p + 1) as u32);
    c.descriptors[p].release_count_sample = Some((p + 2) as u32);
    descriptor(
        &mut c,
        "/phone/input/integer".into(),
        "Integer input".into(),
        3,
        1,
        vec![8],
        "User-selected signed 32-bit integer.",
    );
    descriptor(
        &mut c,
        "/phone/input/trigger/value".into(),
        "Gripper trigger".into(),
        3,
        8,
        vec![10, 11],
        "Slider position from zero to one.",
    );
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
    fn cancel(&mut self) {
        if self.held {
            self.held = false;
            self.releases = self.releases.wrapping_add(1);
        }
    }
    fn controls(&self) -> Vec<Value> {
        vec![
            Value::Bit(self.held),
            Value::Unsigned(self.presses),
            Value::Unsigned(self.releases),
            Value::Signed(self.input.into()),
            Value::Numbers(vec![self.trigger]),
        ]
    }
    fn raw_values(&self, group: usize) -> Vec<Value> {
        if !self.available[group] {
            return vec![];
        }
        self.raw[group - 1]
            .iter()
            .flat_map(|&n| {
                [
                    Value::Numbers(vec![if self.good[group] { n } else { 0. }]),
                    Value::Bit(self.good[group]),
                ]
            })
            .collect()
    }
    fn pose_values(pose: crate::spatial::Pose, quality: [bool; 4]) -> Vec<Value> {
        let mut values = vec![Value::Numbers(
            [pose.position.to_vec(), pose.orientation.to_vec()].concat(),
        )];
        values.extend(quality.map(Value::Bit));
        values
    }
    fn refresh_pose(&mut self, at: u64, c: &Capabilities) {
        use crate::spatial::Pose;
        let recent = |t| at.saturating_sub(t) <= STALE_NS;
        let camera = self
            .spatial
            .as_ref()
            .and_then(|a| Some((a.camera_ready_at?, a.pose?, [true; 4])));
        let estimated = self
            .displacement
            .as_ref()
            .and_then(|d| d.estimate)
            .map(|e| (e.at, e.pose, [true, true, false, true]));
        let imu = self.last[0]
            .zip(self.orientation)
            .filter(|_| self.good[0] && self.heading_set)
            .map(|(t, q)| {
                let h = std::f64::consts::FRAC_1_SQRT_2;
                let q = multiply(multiply(self.heading, q), [h, 0., 0., h]);
                (
                    t,
                    Pose {
                        orientation: q,
                        ..Pose::IDENTITY
                    },
                    [false, true, false, true],
                )
            });
        let candidate = [camera, estimated, imu]
            .into_iter()
            .flatten()
            .find(|(t, _, _)| recent(*t));
        if let Some((t, pose, quality)) = candidate {
            if t >= self.snapshots[0].timestamp {
                self.publish(0, t, Self::pose_values(pose, quality), c);
                return;
            }
            // A delayed camera can take over once its capture catches the last
            // published rotation. Keep the newer rotation visible in the meantime.
            if quality[0]
                && recent(self.snapshots[0].timestamp)
                && matches!(self.snapshots[0].values.get(1), Some(Value::Bit(false)))
            {
                return;
            }
        }
        if !matches!(self.snapshots[0].values.get(2), Some(Value::Bit(false))) {
            self.publish(0, at, Self::pose_values(Pose::IDENTITY, [false; 4]), c);
        }
    }
    fn publish(&mut self, group: usize, at: u64, values: Vec<Value>, c: &Capabilities) {
        let old = &self.snapshots[group];
        if at < old.timestamp || (old.timestamp == at && old.values == values) {
            return;
        }
        self.serial += 1;
        let snapshot = Snapshot {
            number: self.serial,
            timestamp: at,
            values,
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
    pub fn spatial_at(available: [bool; 3], source: &'static str, at: u64) -> Arc<Self> {
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
            input: 0,
            trigger: 0.,
            epoch: at,
            reference_since: at,
            rotations: Default::default(),
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
            presses: 0,
            releases: 0,
            snapshots: std::array::from_fn(|_| Snapshot {
                number: 0,
                timestamp: at,
                values: vec![],
            }),
            demands: vec![],
            serial: 0,
        };
        state.refresh_pose(at, &c);
        for group in 1..3 {
            state.publish(group, at, state.raw_values(group), &c);
        }
        state.publish(3, at, state.controls(), &c);
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
        // An automatic source transition retains the actual touch. Explicit
        // source selection and activity lifecycle events cancel it in the UI.
        s.spatial = spatial.then(|| crate::spatial::SpatialState {
            generation: at,
            ..Default::default()
        });
        s.displacement = displacement.then(|| {
            let mut estimator = crate::displacement::Estimator::default();
            estimator.resume(at);
            estimator
        });
        s.available[0] = has_rotation_sensor;
        s.refresh_pose(at, &self.capabilities);
        self.notify_subscribers(s.serial);
    }
    fn notify_subscribers(&self, serial: u64) {
        self.updates.send_if_modified(|previous| {
            let changed = *previous != serial;
            *previous = serial;
            changed
        });
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
        let controls_before = s.controls();
        match action {
            Action::SetInput(input) => s.input = input,
            Action::SetTrigger(value) if value.is_finite() => s.trigger = value.clamp(0., 1.),
            Action::SetTrigger(_) => return,
            Action::Hold if !s.held && s.foreground && s.focused => {
                s.held = true;
                s.presses = s.presses.wrapping_add(1);
            }
            Action::Hold => {}
            Action::Release | Action::Cancel => s.cancel(),
            Action::Recenter => {
                s.reference_since = at;
                s.heading_set = false;
                s.rotations.clear();
                if let Some(a) = &mut s.spatial {
                    a.invalidate("Waiting for a new camera origin");
                    a.recenter_since = Some(at);
                }
                if let Some(d) = &mut s.displacement {
                    d.recenter(at);
                }
                s.refresh_pose(at, &self.capabilities);
            }
            Action::Focus(focus) if s.focused == focus => return,
            Action::Focus(_) | Action::Resume | Action::Pause | Action::Shutdown => {
                if let Action::Focus(focus) = action {
                    s.focused = focus;
                } else {
                    s.foreground = matches!(action, Action::Resume);
                }
                s.cancel();
                s.epoch = at;
                s.good = [false; 3];
                s.orientation = None;
                s.heading_set = false;
                s.rotations.clear();
                if let Some(a) = &mut s.spatial {
                    a.invalidate("Waiting for camera tracking");
                    a.recenter_since = Some(at);
                    if matches!(action, Action::Resume) {
                        a.clock = Default::default();
                    }
                }
                if let Some(d) = &mut s.displacement {
                    d.resume(at);
                }
                s.refresh_pose(at, &self.capabilities);
                for group in 1..3 {
                    let values = s.raw_values(group);
                    if s.snapshots[group].values != values {
                        s.publish(group, at, values, &self.capabilities);
                    }
                }
            }
        }
        let controls = s.controls();
        if controls != controls_before {
            s.publish(3, at, controls, &self.capabilities);
        }
        self.notify_subscribers(s.serial);
    }
    /// Android rotation vector, accelerometer and gyroscope are groups 0, 1 and 2.
    pub fn sensor(&self, kind: usize, timestamp: u64, values: [f64; 4], received: u64) {
        let mut s = self.state.lock().unwrap();
        if kind > 2
            || !s.foreground
            || !s.focused
            || !s.available[kind]
            || timestamp < s.epoch
            || timestamp > received
            || s.last[kind].is_some_and(|t| timestamp <= t)
        {
            return;
        }
        let previous = s.last[kind].replace(timestamp);
        let q = (kind == 0).then(|| android_to_tracking(values)).flatten();
        let valid = received - timestamp <= STALE_NS
            && if kind == 0 {
                q.is_some()
            } else {
                values[..3]
                    .iter()
                    .all(|v| v.is_finite() && v.abs() <= f32::MAX as f64)
            };
        s.good[kind] = valid;
        if kind != 0 {
            s.raw[kind - 1].copy_from_slice(&values[..3]);
            let raw = s.raw_values(kind);
            s.publish(
                kind,
                if valid { timestamp } else { received },
                raw,
                &self.capabilities,
            );
        } else if let Some(q) = q.filter(|_| valid) {
            s.orientation = Some(q);
            if !s.heading_set && timestamp >= s.reference_since {
                s.heading = heading_inverse(q);
                s.heading_set = true;
            }
            s.rotations.push_back((timestamp, q));
            while s
                .rotations
                .front()
                .is_some_and(|(t, _)| timestamp - t > STALE_NS)
            {
                s.rotations.pop_front();
            }
        }
        let heading = s.heading;
        if kind < 2
            && let Some(d) = &mut s.displacement
        {
            if !valid || previous.is_some_and(|t| timestamp - t > crate::displacement::MAX_GAP_NS) {
                d.invalidate("Interrupted IMU acquisition");
            }
            if valid {
                if kind == 0 {
                    let _ = d.orientation(timestamp, q.unwrap(), received);
                } else {
                    let _ = d.acceleration(timestamp, [values[0], values[1], values[2]], received);
                }
                if !d.has_reference() && d.ready(timestamp) {
                    d.begin_continuous(timestamp, heading);
                }
            }
        }
        if kind == 0 || (kind == 1 && s.displacement.is_some()) {
            s.refresh_pose(received, &self.capabilities);
        }
        self.notify_subscribers(s.serial);
    }
    pub fn tick(&self, at: u64) {
        let mut s = self.state.lock().unwrap();
        let at = s.transition_time(at);
        for kind in 0..3 {
            if s.good[kind] && !s.fresh(kind, at) {
                s.good[kind] = false;
                if kind != 0 {
                    let values = s.raw_values(kind);
                    s.publish(kind, at, values, &self.capabilities);
                }
            }
        }
        if let Some(d) = &mut s.displacement
            && d.expired(at)
        {
            d.invalidate("Waiting for aligned IMU measurements");
        }
        s.refresh_pose(at, &self.capabilities);
        self.notify_subscribers(s.serial);
    }
    pub fn handset_status(&self, at: u64) -> HandsetStatus {
        let s = self.state.lock().unwrap();
        let pose = &s.snapshots[0];
        let valid = |index| {
            at.saturating_sub(pose.timestamp) <= STALE_NS
                && matches!(pose.values.get(index), Some(Value::Bit(true)))
        };
        let mode = if s.spatial.is_some() {
            TrackingMode::Spatial
        } else if s.displacement.is_some() {
            TrackingMode::Displacement
        } else {
            TrackingMode::Orientation
        };
        let motion = if valid(1) || (valid(2) && mode == TrackingMode::Orientation) {
            Motion::Tracking
        } else if valid(2) {
            Motion::OrientationOnly
        } else if mode != TrackingMode::Spatial && !s.available[0] {
            Motion::Unavailable
        } else if let Some(a) = &s.spatial {
            if a.origin {
                Motion::Recovering
            } else {
                Motion::Calibrating
            }
        } else {
            Motion::Waiting
        };
        HandsetStatus {
            input: s.input,
            trigger: s.trigger,
            held: s.held,
            presses: s.presses,
            releases: s.releases,
            position_valid: valid(1),
            mode,
            motion,
        }
    }
    pub fn status(&self, at: u64) -> String {
        let state = self.state.lock().unwrap();
        let sensor = |i| {
            if state.fresh(i, at) {
                "fresh"
            } else {
                "unavailable"
            }
        };
        let source = if let Some(a) = &state.spatial {
            format!(
                "{} · origin {}\n{}",
                a.status,
                if a.origin { "established" } else { "pending" },
                a.diagnostics
            )
        } else if let Some(d) = &state.displacement {
            format!(
                "IMU displacement estimate · {}\nPosition (m): {:?} · velocity (m/s): {:?}",
                d.status,
                d.estimate.map(|e| e.pose.position),
                d.estimate.map(|e| e.velocity)
            )
        } else {
            "Rotation sensor · orientation only".into()
        };
        format!(
            "{source}\nAccelerometer: {} · gyroscope: {}",
            sensor(1),
            sensor(2)
        )
    }
    /// Worker token rejects results crossing pause, focus loss or recenter.
    pub fn spatial_context(&self) -> (u64, bool, Option<u64>) {
        let s = self.state.lock().unwrap();
        let Some(a) = &s.spatial else {
            return (0, false, None);
        };
        (
            a.generation,
            s.foreground && s.focused,
            a.recenter_since.or(Some(s.epoch)),
        )
    }
    pub fn spatial_frame(&self, f: crate::spatial::Frame) {
        use crate::spatial::{Acquisition, FrameAnchor, relative_grip};
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
        a.origin = !matches!(f.anchor, FrameAnchor::Missing);
        let result = if !f.tracking {
            Err("Waiting for ARCore camera tracking")
        } else {
            a.clock.observe(&f)
        };
        let result = result.and_then(|acquisition| {
            if let Acquisition::New(capture_time) = acquisition {
                a.camera_ready_at = Some(capture_time);
            }
            let anchor = match f.anchor {
                FrameAnchor::Missing => return Err("Waiting for an origin anchor"),
                FrameAnchor::Paused => {
                    return Err("Waiting for the origin anchor to resume tracking");
                }
                FrameAnchor::Tracking(pose) => pose,
            };
            let Acquisition::New(capture_time) = acquisition else {
                return Ok(None);
            };
            let pose = relative_grip(f.sensor, anchor)
                .ok_or("Waiting for a valid sensor and anchor pose")?;
            a.recenter_since = None;
            Ok(Some((capture_time, pose)))
        });
        match result {
            Ok(Some((timestamp, pose))) => {
                let a = s.spatial.as_mut().unwrap();
                a.pose = Some(pose);
                a.status = "ARCore TRACKING · verified frame clock".into();
                // Match yaw at capture time, not at camera callback time. Both
                // sources use gravity-up and the same phone-to-grip rotation.
                if let Some((_, imu)) = s
                    .rotations
                    .iter()
                    .min_by_key(|(t, _)| t.abs_diff(timestamp))
                    .filter(|(t, _)| t.abs_diff(timestamp) <= crate::displacement::ALIGN_NS)
                {
                    let sensor = f.sensor.orientation;
                    if let FrameAnchor::Tracking(anchor) = f.anchor {
                        let local = multiply(heading_inverse(anchor.orientation), sensor);
                        let inv_local = heading_inverse(local);
                        s.heading =
                            multiply([0., -inv_local[1], 0., inv_local[3]], heading_inverse(*imu));
                        s.heading_set = true;
                    }
                }
                s.refresh_pose(f.query_finished, &self.capabilities);
                self.notify_subscribers(s.serial);
            }
            Ok(None) => {} // Cached frames never refresh acquisition/freshness.
            Err(reason) => {
                let a = s.spatial.as_mut().unwrap();
                a.status = reason.into();
                a.pose = None;
                if !f.tracking {
                    a.camera_ready_at = None;
                }
                s.refresh_pose(f.query_finished, &self.capabilities);
                self.notify_subscribers(s.serial);
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
    fn controls_do_not_reacquire_or_invalidate_pose_or_raw_samples() {
        let h = hub();
        h.sensor(1, 4, [1., 2., 3., 0.], 6);
        h.sensor(2, 5, [4., 5., 6., 0.], 7);
        let stamps = || {
            h.state
                .lock()
                .unwrap()
                .snapshots
                .each_ref()
                .map(|s| (s.number, s.timestamp))
        };
        let before = stamps();
        for (i, action) in [
            Action::SetInput(i32::MIN),
            Action::Hold,
            Action::Hold,
            Action::SetTrigger(0.72),
            Action::SetInput(i32::MAX),
            Action::Release,
            Action::Cancel,
        ]
        .into_iter()
        .enumerate()
        {
            h.action(action, 20 + i as u64);
            assert_eq!(&stamps()[..3], &before[..3]);
            assert_eq!(h.handset_status(30).motion, Motion::Tracking);
        }
        let status = h.handset_status(30);
        assert_eq!(
            (
                status.input,
                status.trigger,
                status.presses,
                status.releases,
                status.held
            ),
            (i32::MAX, 0.72, 1, 1, false)
        );
        let group = h.state.lock().unwrap().snapshots[3].clone();
        assert_eq!(
            group.values,
            [
                Value::Bit(false),
                Value::Unsigned(1),
                Value::Unsigned(1),
                Value::Signed(i32::MAX.into()),
                Value::Numbers(vec![0.72])
            ]
        );
        h.action(Action::SetTrigger(f64::NAN), 31);
        h.action(Action::Release, 32);
        h.tick(33);
        assert_eq!(group.number, stamps()[3].0);
    }

    #[test]
    fn resume_requires_a_fresh_heading_without_grv_yaw_continuity() {
        let h = hub();
        h.action(Action::Pause, 3);
        h.action(Action::Resume, 4);
        assert!(!h.state.lock().unwrap().heading_set);
        h.action(Action::Hold, 5);
        assert!(h.handset_status(0).held);
        assert!(!bit(&h, 0, 2));
        let restarted = multiply([0., 0., 0.5f64.sqrt(), 0.5f64.sqrt()], upright());
        h.sensor(0, 6, restarted, 6);
        assert!(bit(&h, 0, 2));
        h.sensor(0, 8, restarted, 8);
        let p = pose(&h, 0);
        for (actual, expected) in p[3..].iter().zip(upright()) {
            assert!((actual - expected).abs() < 1e-12);
        }
    }

    #[test]
    fn lifecycle_cancels_touch_while_sensor_stall_only_invalidates_rotation() {
        for action in [Action::Pause, Action::Focus(false), Action::Shutdown] {
            let h = hub();
            h.action(Action::Hold, 3);
            h.sensor(0, 4, upright(), 4);
            h.action(action, 5);
            assert!(!h.handset_status(0).held);
            assert!(!bit(&h, 0, 2));
            h.action(Action::Resume, 6);
            h.action(Action::Focus(true), 6);
            h.sensor(0, 7, upright(), 7);
            assert!(!h.handset_status(0).held);
        }
        let h = hub();
        h.action(Action::Hold, 3);
        h.sensor(0, 4, upright(), 4);
        h.tick(STALE_NS + 5);
        assert!(h.handset_status(0).held);
        assert!(!bit(&h, 0, 2));
        h.sensor(0, STALE_NS + 6, upright(), STALE_NS + 6);
        assert!(bit(&h, 0, 2));
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
        assert!(h.handset_status(0).held);
        assert!(!bit(&h, 0, 2));
        let missing = Hub::at([false, false, false], "missing", 0);
        missing.action(Action::Resume, 1);
        missing.action(Action::Focus(true), 1);
        missing.action(Action::Hold, 2);
        assert_eq!(missing.handset_status(2).motion, Motion::Unavailable);
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
    fn deadman_edges_observed_during_blocked_transport_and_exact_ack() {
        let h = hub();
        h.action(Action::Hold, 3);
        h.sensor(0, 4, upright(), 4);
        let r = Request {
            id: 1,
            group: 3,
            channel: 1,
            interval: 10_000_000,
            phase: 0,
            prediction_offset: 40_000_000,
            sequence_number_format: Some(protocol::SequenceNumberFormat::U32),
            bundles: vec![
                vec![],
                vec![protocol::SampleBinding {
                    descriptor: h
                        .capabilities
                        .descriptors
                        .iter()
                        .position(|d| d.kind == 2)
                        .unwrap() as u32,
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
            anchor: crate::spatial::FrameAnchor::Tracking(Pose::IDENTITY),
        }
    }
    #[test]
    fn automatic_source_changes_preserve_contact_and_reject_old_camera_frames() {
        let hub = ready();
        hub.action(Action::Hold, 20);
        assert!(hub.handset_status(0).held);
        let old = frame(&hub, 21);
        hub.set_tracking_mode(TrackingMode::Orientation, true, 22);
        hub.spatial_frame(old);
        assert!(hub.handset_status(0).held);
        assert!(!position_valid(&hub));

        let upright = std::f64::consts::FRAC_1_SQRT_2;
        hub.sensor(0, 24, [upright, 0., 0., upright], 24);
        assert!(matches!(
            hub.state.lock().unwrap().snapshots[0].values[2],
            Value::Bit(true)
        ));
        assert!(hub.handset_status(0).held);
        hub.action(Action::Cancel, 25); // explicit source picker
        hub.set_tracking_mode(TrackingMode::Displacement, true, 26);
        assert!(!hub.handset_status(0).held);
        hub.set_tracking_mode(TrackingMode::Spatial, true, 27);
        hub.spatial_frame(old);
        assert_ne!(old.generation, hub.spatial_context().0);
        assert!(!position_valid(&hub));
    }

    fn ready() -> Arc<Hub> {
        let h = Hub::spatial_at([true; 3], "SYNTHETIC test", 0);
        h.action(Action::Resume, 1);
        h.action(Action::Focus(true), 2);
        assert!(h.spatial_context().2.is_some());
        h.spatial_frame(frame(&h, 10));
        h.action(Action::Hold, 11);
        h.spatial_frame(frame(&h, 20));
        h
    }
    fn position_valid(h: &Hub) -> bool {
        matches!(
            h.state.lock().unwrap().snapshots[0].values[1],
            Value::Bit(true)
        )
    }
    #[test]
    fn camera_capture_can_precede_controls_without_losing_freshness_or_reference() {
        let h = ready();
        let generation = h.spatial_context().0;
        h.action(Action::Release, 140_000_000);
        let mut f = frame(&h, 33_000_000);
        f.query_finished += 135_000_000;
        h.spatial_frame(f);
        assert_eq!(h.spatial_context().0, generation);
        assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 33_000_000);
        assert!(position_valid(&h));
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
        h.spatial_frame(f);
        h.action(Action::Hold, capture + 10);
        assert!(h.handset_status(0).held);
        let mut next = frame(&h, capture + 33_333_333);
        next.timestamp += 21_636_872;
        h.spatial_frame(next);
        assert!(position_valid(&h));
        assert_eq!(
            h.state.lock().unwrap().snapshots[0].timestamp,
            capture + 33_333_333
        );
        h.action(Action::Release, next.query_finished + 1);
        assert!(position_valid(&h));
    }
    #[test]
    fn fresh_repeats_do_not_release_retime_or_create_acquisitions_but_stall_does() {
        let h = ready();
        assert!(h.handset_status(0).held);
        assert!(position_valid(&h));
        let serial = h.state.lock().unwrap().serial;
        for t in [30, 40, 100, 1000] {
            let mut f = frame(&h, 20);
            f.query_started = t;
            f.query_finished = t + 1;
            h.spatial_frame(f);
            h.tick(t);
            assert!(h.handset_status(0).held);
            assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 20);
            assert_eq!(h.state.lock().unwrap().serial, serial);
        }
        h.spatial_frame(frame(&h, 2000));
        assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 2000);
        let mut f = frame(&h, 2000);
        f.query_started = 2000 + STALE_NS;
        f.query_finished = f.query_started + 1;
        h.spatial_frame(f);
        assert!(h.handset_status(0).held);
        assert!(!position_valid(&h));
        h.spatial_frame(frame(&h, 3000 + STALE_NS));
        assert!(position_valid(&h));
    }
    #[test]
    fn automatically_calibrates_then_recovers_camera_and_anchor_without_losing_reference() {
        use crate::spatial::FrameAnchor;
        let h = Hub::spatial_at([true; 3], "camera", 0);
        h.action(Action::Resume, 1);
        h.action(Action::Focus(true), 2);
        assert_eq!(h.spatial_context().2, Some(2));
        let generation = h.spatial_context().0;
        let mut startup = frame(&h, 4);
        startup.tracking = false;
        startup.anchor = FrameAnchor::Missing;
        h.spatial_frame(startup);
        assert_eq!(h.handset_status(5).motion, Motion::Calibrating);
        h.spatial_frame(frame(&h, 10));
        assert_eq!(h.handset_status(11).motion, Motion::Tracking);
        for (i, anchor_loss) in [false, true].into_iter().enumerate() {
            let at = 20 + 20 * i as u64;
            let mut lost = frame(&h, at);
            if anchor_loss {
                lost.anchor = FrameAnchor::Paused;
            } else {
                lost.tracking = false;
            }
            h.spatial_frame(lost);
            assert_eq!(h.handset_status(at + 1).motion, Motion::Recovering);
            assert!(!position_valid(&h));
            assert_eq!(h.spatial_context().0, generation);
            h.spatial_frame(frame(&h, at + 10));
            assert!(position_valid(&h));
        }
        let mut stopped = frame(&h, 60);
        stopped.anchor = FrameAnchor::Missing;
        h.spatial_frame(stopped);
        assert_eq!(h.handset_status(61).motion, Motion::Calibrating);
        h.spatial_frame(frame(&h, 70));
        assert!(position_valid(&h));
        h.action(Action::Release, 75);
        h.spatial_frame(frame(&h, 80));
        assert!(position_valid(&h));
        assert!(h.spatial_context().2.is_some());
        let s = h.state.lock().unwrap();
        assert_eq!((s.presses, s.releases), (0, 0));
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
            assert_eq!(h.handset_status(0).held, matches!(action, Action::Recenter));
            assert!(!position_valid(&h));
        }
    }
    #[test]
    fn fallback_preserves_camera_heading_clears_translation_and_uses_real_rotation_stamp() {
        let h = ready();
        let half = std::f64::consts::FRAC_1_SQRT_2;
        let imu = [half, 0., 0., half];
        h.sensor(0, 30, imu, 32);
        let mut f = frame(&h, 30);
        f.sensor.orientation = [0., half, 0., half];
        h.spatial_frame(f);
        let good = h.state.lock().unwrap().snapshots[0].clone();
        h.sensor(0, 40, imu, 42);
        let mut lost = frame(&h, 41);
        lost.tracking = false;
        h.spatial_frame(lost);
        let fallback = h.state.lock().unwrap().snapshots[0].clone();
        assert_eq!(fallback.timestamp, 40);
        assert_eq!(
            &fallback.values[1..],
            &[false, true, false, true].map(Value::Bit)
        );
        let (Value::Numbers(a), Value::Numbers(b)) = (&good.values[0], &fallback.values[0]) else {
            panic!()
        };
        assert_eq!(b[..3], [0.; 3]);
        assert!(
            a[3..]
                .iter()
                .zip(&b[3..])
                .all(|(a, b)| (a - b).abs() < 1e-10)
        );
        assert_eq!(h.handset_status(43).motion, Motion::OrientationOnly);
        h.tick(STALE_NS + 50);
        assert_eq!(
            &h.state.lock().unwrap().snapshots[0].values[1..],
            &[false; 4].map(Value::Bit)
        );
        assert!(h.handset_status(0).held);
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
