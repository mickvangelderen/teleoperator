//! Pure ARCore source policy, shared by Android and explicitly synthetic tests.
//! ARCore is Y-up. The reference point is its Android sensor-frame origin,
//! with zero grip translation; this is not a calibrated palm or robot frame.
use crate::phone::{STALE_NS, heading_inverse, multiply, normalized};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub position: [f64; 3],
    pub orientation: [f64; 4],
}
impl Pose {
    pub const IDENTITY: Self = Self {
        position: [0.; 3],
        orientation: [0., 0., 0., 1.],
    };
    pub fn checked(self) -> Option<Self> {
        if self
            .position
            .iter()
            .any(|v| !v.is_finite() || v.abs() > f32::MAX as f64)
        {
            return None;
        }
        Some(Self {
            orientation: normalized(self.orientation)?,
            ..self
        })
    }
}
pub fn rotate(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let r = multiply(
        multiply(q, [v[0], v[1], v[2], 0.]),
        [-q[0], -q[1], -q[2], q[3]],
    );
    [r[0], r[1], r[2]]
}
/// Anchor/device must come from the SAME update, never a saved world pose.
/// Project the anchor heading onto gravity's horizontal plane each frame.
pub fn relative_grip(sensor: Pose, anchor: Pose) -> Option<Pose> {
    let sensor = sensor.checked()?;
    let anchor = anchor.checked()?;
    let yaw = heading_inverse(anchor.orientation);
    let s = std::f64::consts::FRAC_1_SQRT_2;
    Pose {
        position: rotate(
            yaw,
            std::array::from_fn(|i| sensor.position[i] - anchor.position[i]),
        ),
        orientation: multiply(multiply(yaw, sensor.orientation), [s, 0., 0., s]),
    }
    .checked()
}
/// New origin is translation + yaw only, retaining world gravity-up.
pub fn origin_pose(sensor: Pose) -> Option<Pose> {
    let sensor = sensor.checked()?;
    let h = heading_inverse(sensor.orientation);
    Some(Pose {
        position: sensor.position,
        orientation: [-h[0], -h[1], -h[2], h[3]],
    })
}

/// A replacement anchor resumes at the last known local position and heading.
pub fn resumed_origin(sensor: Pose, last_grip: Option<Pose>) -> Option<Pose> {
    let mut origin = origin_pose(sensor)?;
    if let Some(last) = last_grip {
        let h = std::f64::consts::FRAC_1_SQRT_2;
        let local_sensor = multiply(last.orientation, [-h, 0., 0., h]);
        origin.orientation = multiply(origin.orientation, heading_inverse(local_sensor));
        let offset = rotate(origin.orientation, last.position);
        origin.position = std::array::from_fn(|i| sensor.position[i] - offset[i]);
    }
    origin.checked()
}

#[derive(Default)]
pub struct AnchorRecovery {
    paused_since: Option<u64>,
}
impl AnchorRecovery {
    pub fn needs_replacement(&mut self, anchor: FrameAnchor, capture: Option<u64>) -> bool {
        if !matches!(anchor, FrameAnchor::Paused) {
            self.paused_since = None;
            return false;
        }
        // Only a fresh tracked-camera frame can start or complete recovery.
        let Some(at) = capture else { return false };
        let since = *self.paused_since.get_or_insert(at);
        at.saturating_sub(since) >= 1_000_000_000
    }
}

#[derive(Default)]
pub struct CameraContext {
    pub generation: u64,
    pub active: bool,
    pub origin_since: Option<u64>,
    pub last_grip: Option<Pose>,
}

#[derive(Clone, Copy, Debug)]
pub enum FrameAnchor {
    Missing,
    Paused,
    Tracking(Pose),
}

#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub generation: u64,
    /// Timestamp identifying this ARCore frame. Its time base is unspecified.
    pub timestamp: i64,
    /// Camera2 SENSOR_TIMESTAMP for the image in this same frame.
    pub metadata_timestamp: Option<i64>,
    pub realtime: bool,
    pub query_started: u64,
    pub query_finished: u64,
    pub tracking: Result<(), &'static str>,
    pub sensor: Pose,
    pub anchor: FrameAnchor,
}

#[derive(Default)]
pub struct CameraProgress {
    last_frame: Option<i64>,
    interrupted_since: Option<u64>,
}
impl CameraProgress {
    pub fn needs_restart(&mut self, frame: &Frame, new_capture: bool, camera_fault: bool) -> bool {
        let advancing = frame.timestamp > 0
            && self.last_frame.replace(frame.timestamp) != Some(frame.timestamp);
        // While relocalizing, progressing images are enough to keep the session.
        // A tracking camera must also supply a verified advancing capture time.
        let progressing = if frame.tracking.is_ok() {
            new_capture
        } else {
            advancing
        };
        if !camera_fault && progressing {
            self.interrupted_since = None;
            return false;
        }
        let since = *self.interrupted_since.get_or_insert(frame.query_finished);
        frame.query_finished.saturating_sub(since) >= 5_000_000_000
    }
}

#[derive(Default, Debug)]
pub struct ClockGate {
    // SDK frame timestamp and Camera2 capture timestamp of the last acquisition.
    last: Option<(i64, u64)>,
}
#[derive(Debug, PartialEq)]
pub enum Acquisition {
    New(u64),
    Repeated,
}
impl ClockGate {
    pub fn observe(&mut self, f: &Frame) -> Result<Acquisition, &'static str> {
        if !f.realtime {
            return Err("Camera timestamp source is not verified REALTIME");
        }
        if f.timestamp <= 0 {
            return Err("Waiting for nonzero camera timestamp");
        }
        // Only the selected camera's REALTIME SENSOR_TIMESTAMP is specified
        // in BOOTTIME. ArFrame_getTimestamp can differ even on the same image.
        let t = f
            .metadata_timestamp
            .filter(|&t| t > 0)
            .ok_or("Waiting for camera capture timestamp metadata")? as u64;
        if f.query_finished < f.query_started || t > f.query_finished {
            return Err("Clock regression or future camera timestamp");
        }
        if f.query_finished - t > STALE_NS {
            return Err("Camera frame stale");
        }
        if let Some((last_frame, last_capture)) = self.last {
            if f.timestamp < last_frame || t < last_capture {
                return Err("Camera timestamp regressed");
            }
            if f.timestamp == last_frame && t == last_capture {
                return Ok(Acquisition::Repeated);
            }
            if f.timestamp == last_frame || t == last_capture {
                return Err("Frame and capture timestamps did not advance together");
            }
        }
        self.last = Some((f.timestamp, t));
        Ok(Acquisition::New(t))
    }
}

#[derive(Debug)]
pub(crate) struct SpatialState {
    pub capture_at: Option<u64>,
    pub generation: u64,
    pub recenter_since: Option<u64>,
    pub origin: bool,
    pub pose: Option<Pose>,
    pub clock: ClockGate,
    pub status: String,
    pub diagnostics: String,
}
impl Default for SpatialState {
    fn default() -> Self {
        Self {
            capture_at: None,
            generation: 0,
            recenter_since: None,
            origin: false,
            pose: None,
            clock: ClockGate::default(),
            status: "Waiting for camera tracking".into(),
            diagnostics: String::new(),
        }
    }
}
impl SpatialState {
    pub fn invalidate(&mut self, reason: &str) {
        self.capture_at = None;
        self.generation = self.generation.wrapping_add(1);
        self.recenter_since = None;
        self.origin = false;
        self.pose = None;
        // Keep last timestamp across recenter/loss. Only a new session resets it.
        self.status = reason.into();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn near(a: &[f64], b: &[f64]) {
        assert!(
            a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-8),
            "{a:?} != {b:?}"
        );
    }
    fn yaw(a: f64) -> [f64; 4] {
        [0., (a / 2.).sin(), 0., (a / 2.).cos()]
    }
    fn world(p: Pose, q: [f64; 4], t: [f64; 3]) -> Pose {
        Pose {
            position: std::array::from_fn(|i| rotate(q, p.position)[i] + t[i]),
            orientation: multiply(q, p.orientation),
        }
    }
    #[test]
    fn same_frame_refinement_translation_and_yaw_cancel() {
        let anchor = Pose {
            position: [2., 1., 3.],
            orientation: yaw(0.7),
        };
        let sensor = Pose {
            position: [3., 2., 4.],
            orientation: multiply(yaw(1.), [0.1, 0., 0., (0.99_f64).sqrt()]),
        };
        let a = relative_grip(sensor, anchor).unwrap();
        let b = relative_grip(
            world(sensor, yaw(-1.2), [9., 2., -4.]),
            world(anchor, yaw(-1.2), [9., 2., -4.]),
        )
        .unwrap();
        near(&a.position, &b.position);
        near(&a.orientation, &b.orientation);
        assert!((a.position[1] - 1.).abs() < 1e-8);
    }
    #[test]
    fn recenter_retains_pitch_roll_and_applies_only_grip_basis() {
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let p = relative_grip(Pose::IDENTITY, Pose::IDENTITY).unwrap();
        near(&p.orientation, &[s, 0., 0., s]);
        near(&rotate(p.orientation, [0., 0., -1.]), &[0., 1., 0.]);
        let device = Pose {
            position: [1., 2., 3.],
            orientation: multiply(yaw(0.8), [0.2, 0., 0., (0.96_f64).sqrt()]),
        };
        let origin = origin_pose(device).unwrap();
        let result = relative_grip(device, origin).unwrap();
        near(&result.position, &[0.; 3]);
        near(
            &result.orientation,
            &multiply([0.2, 0., 0., (0.96_f64).sqrt()], [s, 0., 0., s]),
        );
        assert!(
            origin_pose(Pose {
                orientation: [s, 0., 0., s],
                ..device
            })
            .is_some()
        );
        assert!(
            relative_grip(
                Pose {
                    position: [f64::NAN, 0., 0.],
                    ..device
                },
                origin
            )
            .is_none()
        );
    }
    #[test]
    fn paused_anchor_relocalizes_or_rebuilds_at_last_known_local_pose() {
        let mut recovery = AnchorRecovery::default();
        let anchor = Pose {
            position: [8., 2., -4.],
            orientation: yaw(-0.7),
        };
        let sensor = Pose {
            position: [10., 2.5, -3.],
            orientation: yaw(0.3),
        };
        let original = relative_grip(sensor, anchor).unwrap();
        assert!(!recovery.needs_replacement(FrameAnchor::Tracking(anchor), Some(10)));
        assert!(!recovery.needs_replacement(FrameAnchor::Paused, Some(20)));
        assert!(!recovery.needs_replacement(FrameAnchor::Paused, None));
        assert!(!recovery.needs_replacement(FrameAnchor::Tracking(anchor), Some(900_000_020)));
        assert!(!recovery.needs_replacement(FrameAnchor::Paused, None));
        assert!(!recovery.needs_replacement(FrameAnchor::Paused, Some(3_000_000_000)));
        assert!(recovery.needs_replacement(FrameAnchor::Paused, Some(4_000_000_000)));
        let relocated = world(sensor, yaw(1.9), [-90., 18., 30.]);
        let restored = relative_grip(
            relocated,
            resumed_origin(relocated, Some(original)).unwrap(),
        )
        .unwrap();
        near(&original.position, &restored.position);
        near(&original.orientation, &restored.orientation);
        let recentered =
            relative_grip(relocated, resumed_origin(relocated, None).unwrap()).unwrap();
        near(&recentered.position, &[0.; 3]);
    }
    pub fn frame(t: i64) -> Frame {
        Frame {
            generation: 0,
            timestamp: t,
            metadata_timestamp: Some(t),
            realtime: true,
            query_started: t as u64,
            query_finished: t as u64 + 10,
            tracking: Ok(()),
            sensor: Pose::IDENTITY,
            anchor: FrameAnchor::Tracking(Pose::IDENTITY),
        }
    }
    #[test]
    fn stalled_camera_restarts_but_advancing_relocalization_keeps_the_session() {
        let mut progress = CameraProgress::default();
        let mut f = frame(1);
        for n in 1..10 {
            f.timestamp = n;
            f.query_finished = n as u64 * 1_000_000_000;
            f.tracking = Err("Insufficient features");
            assert!(!progress.needs_restart(&f, false, false));
        }
        for n in 10..=15 {
            f.query_finished = n * 1_000_000_000;
            assert_eq!(progress.needs_restart(&f, false, false), n == 15);
        }
        f.tracking = Ok(());
        assert!(!progress.needs_restart(&f, true, false));
        assert!(!progress.needs_restart(&f, false, false));
        f.query_finished += 5_000_000_000;
        assert!(progress.needs_restart(&f, false, false));
        assert!(!progress.needs_restart(&f, true, false));
    }

    #[test]
    fn clock_bridge_requires_evidence_deduplicates_and_expires() {
        let mut g = ClockGate::default();
        let mut f = frame(100);
        assert_eq!(g.observe(&f), Ok(Acquisition::New(100)));
        f.query_finished += 100;
        assert_eq!(g.observe(&f), Ok(Acquisition::Repeated));
        f.query_finished = 100 + STALE_NS + 1;
        assert_eq!(g.observe(&f), Err("Camera frame stale"));
        let mut f = frame(200);
        f.realtime = false;
        assert!(g.observe(&f).is_err());
        f.realtime = true;
        f.metadata_timestamp = None;
        assert!(g.observe(&f).is_err());
        f.metadata_timestamp = Some(199);
        assert_eq!(g.observe(&f), Ok(Acquisition::New(199)));
        assert_eq!(g.observe(&f), Ok(Acquisition::Repeated));
        f.timestamp += 1;
        assert!(g.observe(&f).is_err());
        f.timestamp -= 1;
        f.metadata_timestamp = Some(200);
        f.query_finished = 199;
        assert!(g.observe(&f).is_err());
        assert!(g.observe(&frame(0)).is_err());
        assert!(g.observe(&frame(99)).is_err());
        assert_eq!(g.observe(&frame(201)), Ok(Acquisition::New(201)));
    }
}
