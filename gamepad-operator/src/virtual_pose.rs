//! Opt-in software pose in a model frame, never physical tracking or prediction.
use crate::input::{Definition, InputValue};
use crate::protocol::{Capabilities, Descriptor, Value};
use serde::Serialize;
use std::f64::consts::{FRAC_PI_2, PI, TAU};

pub const POSE_ID: &str = "/gamepad/virtual/pose";
pub const ENABLED_ID: &str = "/gamepad/virtual/enabled";
pub const MAX_GAP_NS: u64 = 100_000_000;
const STICK_DEADZONE: f64 = 0.15;
const TRIGGER_DEADZONE: f64 = 0.05;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Config {
    pub linear_metres_per_second: f64,
    pub angular_degrees_per_second: f64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            linear_metres_per_second: 1.,
            angular_degrees_per_second: 90.,
        }
    }
}
impl Config {
    pub fn validate(self) -> Result<(), String> {
        if !(self.linear_metres_per_second > 0.
            && self.linear_metres_per_second <= 10.
            && self.angular_degrees_per_second > 0.
            && self.angular_degrees_per_second <= 720.)
        {
            return Err("Virtual speeds must be finite, translation in (0,10] m/s and rotation in (0,720] degrees/s".into());
        }
        Ok(())
    }
}
// These exact semantic controls are advertised only after SDL's actual native
// mapping/availability checks. Raw indices and partial sticks never qualify.
const REQUIRED: [(&str, u8); 8] = [
    ("/user/gamepad/input/thumbstick_left", 9),
    ("/user/gamepad/input/thumbstick_right", 9),
    ("/user/gamepad/input/trigger_left/value", 8),
    ("/user/gamepad/input/trigger_right/value", 8),
    ("/user/gamepad/input/shoulder_left/click", 2),
    ("/user/gamepad/input/shoulder_right/click", 2),
    ("/user/gamepad/input/menu/click", 2),
    ("/user/gamepad/input/view/click", 2),
];
#[derive(Clone, Copy, Debug, Default)]
struct Motion {
    horizontal: [f64; 2],
    vertical: f64,
    rotation: [f64; 3], // yaw, pitch, roll rates in radians/s
}
#[derive(Debug)]
pub struct VirtualPose {
    config: Config,
    indices: [usize; 8],
    position: [f64; 3],
    angles: [f64; 3], // independent heading avoids projection singularities
    motion: Motion,
    at: u64,
    enabled: bool,
    valid: bool,
    commands_allowed: bool,
    reset_this_batch: bool,
    reason: &'static str,
}
impl VirtualPose {
    pub fn new(
        defs: &[Definition],
        initial: &[InputValue],
        config: Config,
        at: u64,
    ) -> Result<Self, String> {
        config.validate()?;
        let mut indices = [0; 8];
        for (index, (id, kind)) in indices.iter_mut().zip(REQUIRED) {
            *index = defs
                .iter()
                .position(|d| d.id == id && d.kind == kind)
                .ok_or_else(|| {
                    format!(
                        "Virtual pose unavailable: missing mapped {id}; raw inputs remain available"
                    )
                })?;
        }
        let mut pose = Self {
            config,
            indices,
            position: [0.; 3],
            angles: [0.; 3],
            motion: Motion::default(),
            at,
            enabled: false,
            valid: true,
            commands_allowed: false,
            reset_this_batch: false,
            reason: "Paused: press Start/Options to enable",
        };
        pose.valid = pose.healthy(initial);
        pose.finish(initial);
        Ok(pose)
    }
    fn read_motion(&self, values: &[InputValue]) -> Option<Motion> {
        let value = |i: usize| values.get(*self.indices.get(i)?);
        let stick = |i| match value(i)? {
            InputValue::Stick(v) if v.iter().all(|v| (-1.0..=1.).contains(v)) => Some(deadzone(*v)),
            _ => None,
        };
        let trigger = |i| match value(i)? {
            InputValue::Scalar(v) if (0.0..=1.).contains(v) => {
                Some(((v - TRIGGER_DEADZONE) / (1. - TRIGGER_DEADZONE)).max(0.))
            }
            _ => None,
        };
        let button = |i| match value(i)? {
            InputValue::Button(v) => Some(u8::from(*v) as f64),
            _ => None,
        };
        // Enable/reset are required even though they do not contribute a rate.
        button(6)?;
        button(7)?;
        let left = stick(0)?;
        let right = stick(1)?;
        let angular = self.config.angular_degrees_per_second.to_radians();
        Some(Motion {
            horizontal: left.map(|v| v * self.config.linear_metres_per_second),
            vertical: (trigger(3)? - trigger(2)?) * self.config.linear_metres_per_second,
            rotation: [
                -right[0] * angular,
                right[1] * angular,
                (button(4)? - button(5)?) * angular,
            ],
        })
    }
    fn healthy(&self, values: &[InputValue]) -> bool {
        self.read_motion(values).is_some()
    }
    /// Integrate the previously retained command over elapsed monotonic time.
    /// New events affect future intervals; a stall never replays elapsed motion.
    pub fn begin(&mut self, at: u64, values: &[InputValue]) {
        let gap = at.checked_sub(self.at);
        self.at = at;
        self.reset_this_batch = false;
        let healthy = self.healthy(values);
        self.commands_allowed = healthy && self.valid && gap.is_some_and(|dt| dt <= MAX_GAP_NS);
        self.valid = healthy;
        if !healthy {
            self.pause("Paused: required mapped input unavailable");
        } else if gap.is_none_or(|dt| dt > MAX_GAP_NS) {
            self.pause("Paused: observation gap exceeded 100 ms; press Start/Options again");
        } else if self.enabled {
            self.integrate(gap.unwrap() as f64 / 1e9);
        }
    }
    /// Called only for a genuine observed press edge, never snapshot inference.
    pub fn press(&mut self, index: usize) {
        if !self.commands_allowed {
            return;
        }
        if index == self.indices[7] {
            self.position = [0.; 3];
            self.angles = [0.; 3];
            self.reset_this_batch = true;
            self.pause("Reset to model origin; paused");
        } else if index == self.indices[6] && !self.reset_this_batch {
            self.enabled = !self.enabled;
            self.reason = if self.enabled {
                "Enabled: software motion"
            } else {
                "Paused by Start/Options"
            };
        }
    }
    pub fn finish(&mut self, values: &[InputValue]) {
        if !self.valid {
            self.motion = Motion::default();
            return;
        }
        match self.read_motion(values) {
            Some(motion) => self.motion = motion,
            None => {
                self.motion = Motion::default();
                self.valid = false;
                self.commands_allowed = false;
                self.pause("Paused: required mapped input unavailable");
            }
        }
    }
    fn integrate(&mut self, dt: f64) {
        let [yaw, pitch, roll] = self.angles;
        let [wy, wp, wr] = self.motion.rotation;
        // Exact horizontal integration for constant velocity and heading rate.
        // sinc's limit avoids dividing by zero at neutral yaw.
        let half = wy * dt * 0.5;
        let scale = if half.abs() < 1e-8 {
            1. - half * half / 6.
        } else {
            half.sin() / half
        };
        let (sin, cos) = (yaw + half).sin_cos();
        let [right, forward] = self.motion.horizontal;
        self.position[0] += (cos * right - sin * forward) * dt * scale;
        self.position[1] += self.motion.vertical * dt;
        self.position[2] += (-sin * right - cos * forward) * dt * scale;
        self.angles = [
            wrap(yaw + wy * dt),
            (pitch + wp * dt).clamp(-FRAC_PI_2, FRAC_PI_2),
            wrap(roll + wr * dt),
        ];
    }
    fn pause(&mut self, reason: &'static str) {
        self.enabled = false;
        self.reason = reason;
    }
    pub fn disconnect(&mut self) {
        self.pause("Paused: selected device disconnected");
        self.valid = false;
        self.commands_allowed = false;
        self.motion = Motion::default();
    }
    fn quaternion(&self) -> [f64; 4] {
        let [y, p, r] = self.angles.map(|v| v * 0.5);
        let q = multiply(
            multiply([0., y.sin(), 0., y.cos()], [p.sin(), 0., 0., p.cos()]),
            [0., 0., r.sin(), r.cos()],
        );
        let norm = q.iter().map(|v| v * v).sum::<f64>().sqrt();
        q.map(|v| v / norm)
    }
    pub fn wire_values(&self) -> Vec<Value> {
        let position = if self.valid { self.position } else { [0.; 3] };
        let rotation = if self.valid {
            self.quaternion()
        } else {
            [0., 0., 0., 1.]
        };
        vec![
            Value::Numbers(position.into_iter().chain(rotation).collect()),
            Value::Bit(self.valid),
            Value::Bit(self.valid),
            Value::Bit(false),
            Value::Bit(false),
            Value::Bit(self.enabled),
        ]
    }
    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({"supported":true,"enabled":self.enabled,"valid":self.valid,"status":self.reason,"frame":"model: +X right, +Y up, -Z forward; origin [0,0,0], initial identity orientation","physical_tracking":false,"config":self.config})
    }
}
fn wrap(angle: f64) -> f64 {
    (angle + PI).rem_euclid(TAU) - PI
}
fn deadzone(v: [f64; 2]) -> [f64; 2] {
    let length = v[0].hypot(v[1]);
    if length <= STICK_DEADZONE {
        [0.; 2]
    } else {
        let scale = ((length.min(1.) - STICK_DEADZONE) / (1. - STICK_DEADZONE)) / length;
        v.map(|v| v * scale)
    }
}
fn multiply(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let [x, y, z, w] = a;
    let [u, v, t, s] = b;
    [
        w * u + x * s + y * t - z * v,
        w * v - x * t + y * s + z * u,
        w * t + x * v - y * u + z * s,
        w * s - x * u - y * v - z * t,
    ]
}
pub fn append_descriptors(c: &mut Capabilities, config: Config) {
    let base = c.descriptors.len() as u32;
    c.descriptors.push(Descriptor { id: POSE_ID.into(), name: "Virtual reference pose (software)".into(),
        description: format!("Software-generated pose, not a tracked physical controller or standard OpenXR input path. Model frame only: +X right, +Y up, -Z forward; origin [0,0,0], initial identity orientation. Left stick moves horizontally in independent yaw heading; RT/LT up/down; right stick right turns right, up pitches up (clamped +/-90 degrees); LB/RB roll left/right. Start/Options toggles enable; View/Back (Xbox) or Share/Create (PlayStation) resets and pauses; Xbox Series Share is unused. Horizontal/vertical speed each {} m/s, rotation {} degrees/s. Virtual-only radial stick deadzone 0.15, trigger deadzone 0.05, rescaled. Paused state remains a valid software pose; disconnect/missing controls invalidates it. Tracked flags always false. No prediction. Same software observation timestamp as inputs.",config.linear_metres_per_second,config.angular_degrees_per_second),
        kind:10, formats:vec![10,11], group:0, spaces:vec![6], position_valid_sample:Some(base+1),orientation_valid_sample:Some(base+2),position_tracked_sample:Some(base+3),orientation_tracked_sample:Some(base+4),..Default::default() });
    for (suffix, kind, description) in [
        (
            "position_valid",
            12,
            "Valid software position at the pose timestamp, including intentional pause; false means zero placeholder.",
        ),
        (
            "orientation_valid",
            13,
            "Valid software orientation at the pose timestamp, including intentional pause; false means identity placeholder.",
        ),
        (
            "position_tracked",
            14,
            "Always false: no physical position tracking.",
        ),
        (
            "orientation_tracked",
            15,
            "Always false: no physical orientation tracking.",
        ),
    ] {
        c.descriptors.push(Descriptor {
            id: format!("{POSE_ID}/{suffix}"),
            name: format!("Virtual {suffix}"),
            description: description.into(),
            kind,
            formats: vec![1],
            group: 0,
            ..Default::default()
        });
    }
    c.descriptors.push(Descriptor { id:ENABLED_ID.into(),name:"Virtual motion enabled".into(),description:"Software integration enabled at the matching pose timestamp. Starts paused; reset, missing inputs, disconnect and observation gaps >100 ms pause without automatic resumption. Requires a fresh Start/Options press to resume.".into(),kind:1,formats:vec![1],group:0,..Default::default() });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{synthetic_definitions, synthetic_virtual_values};
    fn pose() -> VirtualPose {
        VirtualPose::new(
            &synthetic_definitions(),
            &synthetic_virtual_values(0),
            Config::default(),
            0,
        )
        .unwrap()
    }
    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-10, "{a} != {b}");
    }
    #[test]
    fn translation_rotation_axes_and_virtual_deadzones() {
        let mut p = pose();
        let mut v = synthetic_virtual_values(0);
        for (index, value, expected) in [
            (14, InputValue::Stick([1., 0.]), [1., 0., 0.]),
            (14, InputValue::Stick([0., 1.]), [0., 0., -1.]),
            (16, InputValue::Scalar(1.), [0., -1., 0.]),
            (17, InputValue::Scalar(1.), [0., 1., 0.]),
        ] {
            v[index] = value;
            p.finish(&v);
            p.position = [0.; 3];
            p.integrate(1.);
            for (a, b) in p.position.into_iter().zip(expected) {
                near(a, b);
            }
            v = synthetic_virtual_values(0);
        }
        v[15] = InputValue::Stick([1., 0.]);
        p.finish(&v);
        near(p.motion.rotation[0], -FRAC_PI_2);
        v[15] = InputValue::Stick([0., 1.]);
        p.finish(&v);
        near(p.motion.rotation[1], FRAC_PI_2);
        v[6] = InputValue::Button(true);
        p.finish(&v);
        near(p.motion.rotation[2], FRAC_PI_2);
        v[6] = InputValue::Button(false);
        v[7] = InputValue::Button(true);
        p.finish(&v);
        near(p.motion.rotation[2], -FRAC_PI_2);
        assert_eq!(deadzone([0.1, 0.1]), [0., 0.]);
        near(deadzone([1., 1.])[0], 1. / 2f64.sqrt());
        v = synthetic_virtual_values(0);
        v[16] = InputValue::Scalar(0.04);
        v[17] = InputValue::Scalar(0.05);
        p.finish(&v);
        near(p.motion.vertical, 0.);
        v[16] = InputValue::Scalar(1.);
        v[17] = InputValue::Scalar(1.);
        p.finish(&v);
        near(p.motion.vertical, 0.);
        let before = (p.position, p.angles);
        p.integrate(1.);
        assert_eq!(before, (p.position, p.angles));
    }
    #[test]
    fn horizontal_motion_survives_vertical_pitch_and_roll_without_heading_flip() {
        let mut p = pose();
        p.angles = [FRAC_PI_2, FRAC_PI_2, 1.2];
        p.motion.horizontal = [0., 1.];
        p.integrate(1.);
        near(p.position[0], -1.);
        near(p.position[1], 0.);
        near(p.position[2], 0.);
        p.motion.rotation = [0., FRAC_PI_2, 0.];
        p.integrate(3.);
        near(p.angles[1], FRAC_PI_2);
        near(p.position[1], 0.);
        p.motion.rotation = [0., -FRAC_PI_2, 0.];
        p.integrate(3.);
        near(p.angles[1], -FRAC_PI_2);
        near(p.position[1], 0.);
    }
    #[test]
    fn cadence_independent_constant_commands_and_normalized_rotation() {
        let run = |steps: &[f64]| {
            let mut p = pose();
            p.motion = Motion {
                horizontal: [0.7, 0.4],
                vertical: 0.2,
                rotation: [0.8, 0.2, -0.3],
            };
            for &dt in steps {
                p.integrate(dt);
            }
            p
        };
        let a = run(&[0.01; 200]);
        let b = run(&[0.02; 100]);
        let c = run(&[0.007, 0.013].repeat(100));
        for other in [&b, &c] {
            for (x, y) in a.position.iter().zip(other.position) {
                near(*x, y);
            }
            for (x, y) in a.quaternion().into_iter().zip(other.quaternion()) {
                near(x, y);
            }
        }
        let mut p = run(&[0.01; 10000]);
        near(p.quaternion().iter().map(|v| v * v).sum(), 1.);
        assert!(p.angles.iter().all(|a| a.abs() <= PI));
        p.angles = [0., 0., 0.];
        assert_eq!(p.quaternion(), [0., 0., 0., 1.]);
        p.angles = [0., FRAC_PI_2, 0.];
        near(p.quaternion()[0], 0.5f64.sqrt());
    }
    #[test]
    fn stalls_invalid_inputs_reset_and_disconnect_require_a_fresh_enable() {
        let mut p = pose();
        let mut v = synthetic_virtual_values(0);
        v[14] = InputValue::Stick([1., 0.]);
        p.finish(&v);
        p.begin(10_000_000, &v);
        p.press(p.indices[6]);
        assert!(p.enabled);
        p.begin(20_000_000, &v);
        near(p.position[0], 0.01);
        let held = p.position;
        p.begin(200_000_001, &v);
        p.press(p.indices[6]);
        assert!(!p.enabled);
        assert_eq!(p.position, held);
        p.begin(210_000_001, &v);
        assert!(!p.enabled);
        p.press(p.indices[6]);
        assert!(p.enabled);
        v[14] = InputValue::Stick([f64::NAN, 0.]);
        p.begin(220_000_001, &v);
        p.finish(&v);
        assert!(!p.valid && !p.enabled);
        v[14] = InputValue::Stick([1., 0.]);
        p.begin(230_000_001, &v);
        p.press(p.indices[6]);
        p.finish(&v);
        assert!(!p.enabled);
        p.begin(240_000_001, &v);
        p.press(p.indices[6]);
        assert!(p.enabled);
        p.press(p.indices[7]);
        p.press(p.indices[6]);
        assert!(!p.enabled);
        assert_eq!(p.position, [0.; 3]);
        p.disconnect();
        assert!(!p.enabled && !p.valid);
        assert!(matches!(p.wire_values()[3], Value::Bit(false)));
    }
    #[test]
    fn missing_mapping_does_not_guess_raw_axes_and_configuration_is_bounded() {
        let defs = synthetic_definitions();
        for (id, _) in REQUIRED {
            let mut missing = defs.clone();
            missing.retain(|d| d.id != id);
            assert!(
                VirtualPose::new(&missing, &synthetic_virtual_values(0), Config::default(), 0)
                    .is_err()
            );
        }
        for bad in [f64::NAN, f64::INFINITY, 0., -1., 11.] {
            assert!(
                Config {
                    linear_metres_per_second: bad,
                    ..Config::default()
                }
                .validate()
                .is_err()
            );
        }
        for bad in [f64::NAN, f64::INFINITY, 0., -1., 721.] {
            assert!(
                Config {
                    angular_degrees_per_second: bad,
                    ..Config::default()
                }
                .validate()
                .is_err()
            );
        }
    }
    #[test]
    fn invalid_final_snapshot_pauses_without_panicking_or_retaining_motion() {
        for values in [
            vec![],
            vec![InputValue::Scalar(f64::NAN); 18],
            vec![InputValue::Button(false); 18],
        ] {
            let mut p = pose();
            p.enabled = true;
            p.motion.horizontal = [1., 0.];
            p.finish(&values);
            assert!(!p.valid && !p.enabled && !p.commands_allowed);
            assert_eq!(p.motion.horizontal, [0.; 2]);
            assert!(matches!(p.wire_values()[1], Value::Bit(false)));
        }
    }
}
