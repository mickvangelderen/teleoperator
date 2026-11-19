//! Opt-in software pose in a model frame, never physical tracking or prediction.
use crate::input::{Definition, InputValue};
use crate::protocol::{Capabilities, Descriptor, Value};
use serde::Serialize;
use std::f64::consts::{FRAC_PI_2, PI, TAU};

pub const POSE_ID: &str = "/gamepad/virtual/pose";
pub const ENABLED_ID: &str = "/gamepad/virtual/enabled";
pub const MAX_GAP_NS: u64 = 100_000_000;
const STICK_DEADZONE: f64 = 0.15;
const BUTTON_RAMP_SECONDS: f64 = 0.25;
pub const EFFECTOR_CONTROLS: &str = "LB raises and RB lowers along model Y. X (West) rolls counterclockwise and B (East) rolls clockwise about local +Z when looking forward along -Z. Height and roll reach full speed after a 250 ms linear ramp. Release stops immediately. Opposing buttons cancel. LT multiplies all translation and rotation speeds by 1 + 3 × LT (1× to 4×). RT sets gripper closure directly from 0 (open) to 1 (closed), including while pose motion is paused.";
const BOOST_ID: &str = "/user/gamepad/input/trigger_left/value";
const GRIPPER_ID: &str = "/user/gamepad/input/trigger_right/value";

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Config {
    pub linear_metres_per_second: f64,
    pub angular_degrees_per_second: f64,
    pub invert_pitch: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            linear_metres_per_second: 0.125,
            angular_degrees_per_second: 180.,
            invert_pitch: true,
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
const REQUIRED: [(&str, u8); 10] = [
    ("/user/gamepad/input/thumbstick_left", 9),
    ("/user/gamepad/input/thumbstick_right", 9),
    (BOOST_ID, 8),
    (GRIPPER_ID, 8),
    ("/user/gamepad/input/shoulder_left/click", 2),
    ("/user/gamepad/input/shoulder_right/click", 2),
    ("/user/gamepad/input/menu/click", 2),
    ("/user/gamepad/input/view/click", 2),
    ("/user/gamepad/input/x/click", 2),
    ("/user/gamepad/input/b/click", 2),
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
    indices: [usize; REQUIRED.len()],
    position: [f64; 3],
    angles: [f64; 3], // independent heading avoids projection singularities
    motion: Motion,
    height_held: f64,
    roll_held: f64,
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
        let mut indices = [0; REQUIRED.len()];
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
            height_held: 0.,
            roll_held: 0.,
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
        let [left, right, lt, rt, raise, lower, menu, view, ccw, cw] = self.indices;
        let stick = |i: usize| match values.get(i)? {
            InputValue::Stick(v) if v.iter().all(|v| (-1.0..=1.).contains(v)) => Some(deadzone(*v)),
            _ => None,
        };
        let trigger = |i: usize| match values.get(i)? {
            InputValue::Scalar(v) if (0.0..=1.).contains(v) => Some(*v),
            _ => None,
        };
        let button = |i: usize| match values.get(i)? {
            InputValue::Button(v) => Some(u8::from(*v) as f64),
            _ => None,
        };
        button(menu)?;
        button(view)?;
        trigger(rt)?; // The raw RT value independently supplies gripper closure.
        let left = stick(left)?;
        let right = stick(right)?;
        let boost = 1. + 3. * trigger(lt)?;
        let linear = self.config.linear_metres_per_second * boost;
        let angular = self.config.angular_degrees_per_second.to_radians() * boost;
        let pitch = if self.config.invert_pitch {
            -right[1]
        } else {
            right[1]
        };
        Some(Motion {
            horizontal: left.map(|v| v * linear),
            vertical: (button(raise)? - button(lower)?) * linear,
            rotation: [
                -right[0] * angular,
                pitch * angular,
                (button(ccw)? - button(cw)?) * angular,
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
    /// Preserve a release/repress within one poll even if the snapshot still reads held.
    pub fn button_edge(&mut self, index: usize, pressed: bool) {
        let [_, _, _, _, raise, lower, menu, view, ccw, cw] = self.indices;
        if index == raise || index == lower {
            self.height_held = 0.;
        } else if index == ccw || index == cw {
            self.roll_held = 0.;
        }
        if !pressed || !self.commands_allowed {
            return;
        }
        if index == view {
            self.position = [0.; 3];
            self.angles = [0.; 3];
            self.reset_this_batch = true;
            self.pause("Reset to model origin; paused");
        } else if index == menu && !self.reset_this_batch {
            if self.enabled {
                self.pause("Paused by Start/Options");
            } else {
                self.enabled = true;
                self.reason = "Enabled: software motion";
            }
        }
    }
    pub fn finish(&mut self, values: &[InputValue]) {
        if !self.valid {
            self.motion = Motion::default();
            return;
        }
        match self.read_motion(values) {
            Some(motion) => {
                // Snapshot reconciliation can also reveal a release or reversal.
                if self.motion.vertical * motion.vertical <= 0. {
                    self.height_held = 0.;
                }
                if self.motion.rotation[2] * motion.rotation[2] <= 0. {
                    self.roll_held = 0.;
                }
                self.motion = motion;
            }
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
        self.position[1] += ramp_delta(&mut self.height_held, self.motion.vertical, dt);
        self.position[2] += (-sin * right - cos * forward) * dt * scale;
        self.angles = [
            wrap(yaw + wy * dt),
            (pitch + wp * dt).clamp(-FRAC_PI_2, FRAC_PI_2),
            wrap(roll + ramp_delta(&mut self.roll_held, wr, dt)),
        ];
    }
    fn pause(&mut self, reason: &'static str) {
        self.enabled = false;
        self.height_held = 0.;
        self.roll_held = 0.;
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
// Integral of min(held / ramp, 1) over this interval, including a crossing of full speed.
fn ramp_delta(held: &mut f64, full_speed: f64, dt: f64) -> f64 {
    if full_speed == 0. {
        return 0.;
    }
    let ramping = dt.min(BUTTON_RAMP_SECONDS - *held);
    let weighted = ramping * (*held + 0.5 * ramping) / BUTTON_RAMP_SECONDS;
    *held += ramping;
    full_speed * (weighted + (dt - ramping))
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
    for d in &mut c.descriptors {
        match d.id.as_str() {
            BOOST_ID => {
                d.name.push_str(" / motion boost");
                d.description.push_str(
                    " In virtual mode, all linear and angular speeds scale by 1 + 3 × this value.",
                );
            }
            GRIPPER_ID => {
                d.name.push_str(" / gripper target");
                d.description.push_str(" In virtual mode, this value is the gripper closure target. 0 is open, 1 is closed, and intermediate values give proportional closure, including while pose motion is paused.");
            }
            _ => {}
        }
    }
    let base = c.descriptors.len() as u32;
    let pitch_direction = if config.invert_pitch { "down" } else { "up" };
    c.descriptors.push(Descriptor { id: POSE_ID.into(), name: "Virtual reference pose (software)".into(),
        description: format!("Software-generated pose, not a tracked physical controller or standard OpenXR input path. Model frame only: +X right, +Y up, -Z forward; origin [0,0,0], initial identity orientation. Left stick moves horizontally in the yaw frame. Right stick right turns right, up pitches {pitch_direction} (clamped +/-90 degrees). {EFFECTOR_CONTROLS} The gripper target is {GRIPPER_ID}. Start/Options toggles enable; View/Back (Xbox) or Share/Create (PlayStation) resets and pauses; Xbox Series Share is unused. Base horizontal and vertical speed {} m/s, base rotation {} degrees/s. Sticks use a rescaled radial deadzone of 0.15 for virtual motion. Paused state remains a valid software pose; disconnect/missing controls invalidates it. Tracked flags always false. No prediction. Same software observation timestamp as inputs.",config.linear_metres_per_second,config.angular_degrees_per_second),
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
    fn boost_scales_every_command_and_rt_only_sets_gripper_closure() {
        let mut p = pose();
        p.config.linear_metres_per_second = 0.3;
        p.config.angular_degrees_per_second = 90.;
        let mut v = synthetic_virtual_values(0);
        v[14] = InputValue::Stick([0., 1.]);
        v[15] = InputValue::Stick([0.6, 0.8]);
        v[6] = InputValue::Button(true); // LB raises
        v[2] = InputValue::Button(true); // West rolls CCW
        for lt in [0., 0.04, 0.5, 1.] {
            v[16] = InputValue::Scalar(lt);
            let scale = 1. + 3. * lt;
            for rt in [0., 0.25, 1.] {
                v[17] = InputValue::Scalar(rt);
                p.finish(&v);
                near(p.motion.horizontal[0], 0.);
                near(p.motion.horizontal[1], 0.3 * scale);
                near(p.motion.vertical, 0.3 * scale);
                near(p.motion.rotation[0], -0.6 * FRAC_PI_2 * scale);
                near(p.motion.rotation[1], -0.8 * FRAC_PI_2 * scale);
                near(p.motion.rotation[2], FRAC_PI_2 * scale);
            }
        }
        p.config.invert_pitch = false;
        p.finish(&v);
        near(p.motion.rotation[1], 0.8 * FRAC_PI_2 * 4.);
        assert_eq!(deadzone([0.1, 0.1]), [0., 0.]);
        near(deadzone([1., 1.])[0], 1. / 2f64.sqrt());
    }
    #[test]
    fn button_ramps_integrate_exactly_in_model_y_and_local_roll_and_stop_on_release() {
        for (height, roll, sign) in [(6, 2, 1.), (7, 1, -1.)] {
            let mut p = pose();
            p.angles = [0.6, -0.4, 0.1];
            let initial = p.quaternion();
            let mut v = synthetic_virtual_values(0);
            v[height] = InputValue::Button(true);
            v[roll] = InputValue::Button(true);
            p.finish(&v);
            p.integrate(0.05);
            near(p.position[1], sign * 0.000625); // 50 ms tap at base speed
            near(p.angles[2], 0.1 + sign * 0.9_f64.to_radians());

            // Releasing and repressing within one observation restarts height only.
            p.button_edge(height, false);
            p.button_edge(height, true);
            p.finish(&v);
            for dt in [0.08, 0.09, 0.09, 0.10, 0.07, 0.07] {
                p.integrate(dt);
            }
            near(p.position[0], 0.);
            near(p.position[1], sign * (0.000625 + 0.046875)); // New 500 ms hold
            near(p.position[2], 0.);
            let half_roll = sign * (180.0_f64 * (0.55 - 0.125)).to_radians() / 2.;
            let expected = multiply(initial, [0., 0., half_roll.sin(), half_roll.cos()]);
            for (actual, expected) in p.quaternion().into_iter().zip(expected) {
                near(actual, expected);
            }

            v[6] = InputValue::Button(true);
            v[7] = InputValue::Button(true);
            v[2] = InputValue::Button(true);
            v[1] = InputValue::Button(true);
            let stopped = (p.position, p.angles);
            p.finish(&v);
            p.integrate(0.1);
            assert_eq!((p.position, p.angles), stopped); // Opposing controls cancel.
            v = synthetic_virtual_values(0);
            p.finish(&v);
            p.integrate(0.1);
            assert_eq!((p.position, p.angles), stopped); // No release tail.
        }
    }
    #[test]
    fn pause_and_gap_restart_held_button_ramps_without_catch_up() {
        let mut p = pose();
        let mut v = synthetic_virtual_values(0);
        v[6] = InputValue::Button(true);
        v[2] = InputValue::Button(true);
        p.finish(&v);
        let menu = p.indices[6];
        p.begin(10_000_000, &v);
        p.button_edge(menu, true);
        for t in [110, 210, 310] {
            p.begin(t * 1_000_000, &v);
        }
        let before = (p.position[1], p.angles[2]);
        p.button_edge(menu, true); // Pause with both controls held.
        p.begin(400_000_000, &v);
        p.begin(900_000_000, &v); // Gap suppresses even a new enable at this observation.
        p.button_edge(menu, true);
        assert!(!p.enabled);
        p.begin(910_000_000, &v);
        p.button_edge(menu, true);
        p.begin(960_000_000, &v);
        near(p.position[1] - before.0, 0.000625);
        near(p.angles[2] - before.1, 0.9_f64.to_radians());
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
        p.button_edge(p.indices[6], true);
        assert!(p.enabled);
        p.begin(20_000_000, &v);
        near(p.position[0], 0.00125);
        let held = p.position;
        p.begin(200_000_001, &v);
        p.button_edge(p.indices[6], true);
        assert!(!p.enabled);
        assert_eq!(p.position, held);
        p.begin(210_000_001, &v);
        assert!(!p.enabled);
        p.button_edge(p.indices[6], true);
        assert!(p.enabled);
        v[14] = InputValue::Stick([f64::NAN, 0.]);
        p.begin(220_000_001, &v);
        p.finish(&v);
        assert!(!p.valid && !p.enabled);
        v[14] = InputValue::Stick([1., 0.]);
        p.begin(230_000_001, &v);
        p.button_edge(p.indices[6], true);
        p.finish(&v);
        assert!(!p.enabled);
        p.begin(240_000_001, &v);
        p.button_edge(p.indices[6], true);
        assert!(p.enabled);
        p.button_edge(p.indices[7], true);
        p.button_edge(p.indices[6], true);
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
