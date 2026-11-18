//! Explicit IMU dead reckoning experiment. No damping, deadband, bias removal,
//! stationary detection or external position correction. Drift is observable.
use crate::{
    phone::{STALE_NS, multiply, normalized},
    spatial::{Pose, rotate},
};
use std::collections::VecDeque;

pub const GRAVITY: f64 = 9.80665;
pub const ALIGN_NS: u64 = 25_000_000;
pub const MAX_GAP_NS: u64 = 50_000_000;
const CAPACITY: usize = 32;

#[derive(Clone, Copy, Debug)]
struct Orientation {
    at: u64,
    q: [f64; 4],
}

#[cfg(test)]
mod tests {
    use super::*;
    const MS: u64 = 1_000_000;
    const I: [f64; 4] = [0., 0., 0., 1.];
    fn near(a: [f64; 3], b: [f64; 3]) {
        assert!(
            a.iter().zip(b).all(|(a, b)| (a - b).abs() < 1e-9),
            "{a:?} != {b:?}"
        );
    }
    fn sample(e: &mut Estimator, t: u64, q: [f64; 4], a: [f64; 3]) -> Option<Estimate> {
        e.orientation(t, q, t).unwrap();
        e.acceleration(t, a, t).unwrap()
    }
    #[test]
    fn gravity_cancels_in_multiple_phone_orientations_and_zero_velocity_is_an_assumption() {
        let h = std::f64::consts::FRAC_1_SQRT_2;
        // Analytic phone-axis readings under gravity, not inverse-rotation generated data.
        for (q, a) in [
            (I, [0., GRAVITY, 0.]),
            ([h, 0., 0., h], [0., 0., -GRAVITY]),
            ([-h, 0., 0., h], [0., 0., GRAVITY]),
            ([0., 0., h, h], [GRAVITY, 0., 0.]),
            ([0., 0., 1., 0.], [0., -GRAVITY, 0.]),
            ([0., h, 0., h], [0., GRAVITY, 0.]),
        ] {
            let mut e = Estimator::default();
            e.begin(1, I);
            for k in 0..101 {
                sample(&mut e, 1 + k * 10 * MS, q, a);
            }
            let estimate = e.estimate.unwrap();
            near(estimate.pose.position, [0.; 3]);
            near(estimate.velocity, [0.; 3]);
            // These SAME readings also describe ideal constant-velocity motion.
            // With no initial velocity measurement the estimator still returns zero.
        }
    }
    #[test]
    fn constant_acceleration_and_linear_ramp_match_closed_forms_with_varying_dt() {
        for jerk in [false, true] {
            let mut e = Estimator::default();
            e.begin(1, I);
            let mut elapsed = 0u64;
            for k in 0..81 {
                let t = elapsed as f64 * 1e-9;
                let ax = if jerk { 6. * t } else { 2. };
                let output = sample(&mut e, 1 + elapsed, I, [ax, GRAVITY, 0.]).unwrap();
                near(
                    output.pose.position,
                    [if jerk { t * t * t } else { t * t }, 0., 0.],
                );
                near(
                    output.velocity,
                    [if jerk { 3. * t * t } else { 2. * t }, 0., 0.],
                );
                elapsed += [7, 11, 23, 9][k % 4] * MS;
            }
        }
    }
    #[test]
    fn bias_is_not_damped_clipped_or_silently_removed() {
        let mut e = Estimator::default();
        e.begin(1, I);
        for k in 0..1001 {
            sample(&mut e, 1 + k * 10 * MS, I, [0.02, GRAVITY, 0.]);
        }
        near(e.estimate.unwrap().pose.position, [1., 0., 0.]);
        near(e.estimate.unwrap().velocity, [0.2, 0., 0.]);
    }
    #[test]
    fn acceleration_uses_phone_axes_while_pose_orientation_uses_grip_axes() {
        let h = std::f64::consts::FRAC_1_SQRT_2;
        let q = [0., h, 0., h];
        for heading in [I, [0., -h, 0., h]] {
            let mut e = Estimator::default();
            e.begin(1, heading);
            for k in 0..101 {
                sample(&mut e, 1 + k * 10 * MS, q, [1., GRAVITY, 0.]);
            }
            near(
                e.estimate.unwrap().pose.position,
                if heading == I {
                    [0., 0., -0.5]
                } else {
                    [0.5, 0., 0.]
                },
            );
            if heading == I {
                let actual = e.estimate.unwrap().pose.orientation;
                assert!(
                    actual
                        .iter()
                        .zip([0.5, 0.5, -0.5, 0.5])
                        .all(|(a, b)| (a - b).abs() < 1e-9)
                );
            }
        }
    }
    #[test]
    fn bracket_wait_preserves_acceleration_timestamp_and_starts_zero_at_first_post_press_sample() {
        let h = std::f64::consts::FRAC_1_SQRT_2;
        let mut e = Estimator::default();
        e.begin(5 * MS, I);
        e.orientation(0, I, 0).unwrap();
        assert!(
            e.acceleration(10 * MS, [1., GRAVITY, 0.], 11 * MS)
                .unwrap()
                .is_none()
        );
        assert!(e.estimate.is_none());
        let output = e
            .orientation(20 * MS, [0., h, 0., h], 21 * MS)
            .unwrap()
            .unwrap();
        assert_eq!(output.at, 10 * MS);
        near(output.pose.position, [0.; 3]);
        near(output.velocity, [0.; 3]);
        let forward = rotate(output.pose.orientation, [0., 0., -1.]);
        near(forward, [0., 1., 0.]);
        // Grip +X follows the interpolated phone heading of45degrees, not latest90degrees.
        near(rotate(output.pose.orientation, [1., 0., 0.]), [h, 0., -h]);
        assert_eq!(e.ready_at, Some(10 * MS));
    }
    #[test]
    fn duplicates_do_not_advance_and_invalid_order_future_skew_gaps_or_overflow_reset() {
        let mut e = Estimator::default();
        e.begin(1, I);
        sample(&mut e, 10 * MS, I, [1., GRAVITY, 0.]);
        assert!(
            e.acceleration(10 * MS, [1., GRAVITY, 0.], 20 * MS)
                .unwrap()
                .is_none()
        );
        assert_eq!(e.ready_at, Some(10 * MS));
        assert!(e.acceleration(9 * MS, [1., GRAVITY, 0.], 20 * MS).is_err());
        assert!(e.estimate.is_none());
        assert!(e.orientation(30 * MS, I, 29 * MS).is_err());
        e.orientation(30 * MS, I, 30 * MS).unwrap();
        e.begin(55 * MS, I);
        assert!(e.acceleration(56 * MS, [0., GRAVITY, 0.], 56 * MS).is_err());
        e.begin(60 * MS, I);
        sample(&mut e, 60 * MS, I, [1., GRAVITY, 0.]);
        e.orientation(111 * MS, I, 111 * MS).unwrap();
        assert!(
            e.acceleration(111 * MS, [1., GRAVITY, 0.], 111 * MS)
                .is_err()
        );
        assert!(e.estimate.is_none());
        assert!(
            e.acceleration(120 * MS, [f64::NAN, 0., 0.], 120 * MS)
                .is_err()
        );
        assert!(e.orientation(121 * MS, [0.; 4], 121 * MS).is_err());
        let previous = Integration {
            at: 0,
            acceleration: [0.; 3],
            position: [f32::MAX as f64; 3],
            velocity: [f32::MAX as f64; 3],
        };
        assert!(integrate(previous, MS, [0.; 3]).is_err());
    }
    #[test]
    fn reset_discards_velocity_and_pending_pre_resume_data() {
        let mut e = Estimator::default();
        e.begin(1, I);
        for k in 0..11 {
            sample(&mut e, 1 + k * 10 * MS, I, [2., GRAVITY, 0.]);
        }
        assert!(e.estimate.unwrap().velocity[0] > 0.);
        e.end();
        assert!(e.estimate.is_none());
        e.begin(110 * MS, I);
        let output = sample(&mut e, 111 * MS, I, [2., GRAVITY, 0.]).unwrap();
        near(output.velocity, [0.; 3]);
        near(output.pose.position, [0.; 3]);
        e.resume(200 * MS);
        assert!(e.orientation(199 * MS, I, 201 * MS).unwrap().is_none());
        assert!(!e.ready(201 * MS));
    }
}
#[derive(Clone, Copy, Debug)]
struct Acceleration {
    at: u64,
    value: [f64; 3],
}
#[derive(Clone, Copy, Debug)]
pub struct Estimate {
    pub at: u64,
    pub pose: Pose,
    pub velocity: [f64; 3],
}
#[derive(Clone, Copy, Debug)]
struct Integration {
    at: u64,
    acceleration: [f64; 3],
    position: [f64; 3],
    velocity: [f64; 3],
}

/// Exact integral of acceleration assumed linear BETWEEN the two samples.
/// Constant acceleration therefore gives p = p0 + v0*dt + a*dt²/2.
fn integrate(previous: Integration, at: u64, a: [f64; 3]) -> Result<Integration, &'static str> {
    let dt_ns = at
        .checked_sub(previous.at)
        .filter(|dt| *dt > 0 && *dt <= MAX_GAP_NS)
        .ok_or("Acceleration integration gap or nonincreasing timestamp")?;
    let dt = dt_ns as f64 * 1e-9;
    let position = std::array::from_fn(|i| {
        previous.position[i]
            + previous.velocity[i] * dt
            + (2. * previous.acceleration[i] + a[i]) * dt * dt / 6.
    });
    let velocity =
        std::array::from_fn(|i| previous.velocity[i] + (previous.acceleration[i] + a[i]) * dt / 2.);
    if position
        .iter()
        .chain(velocity.iter())
        .any(|v| !v.is_finite() || v.abs() > f32::MAX as f64)
    {
        return Err("Displacement/velocity overflow; estimate reset");
    }
    Ok(Integration {
        at,
        acceleration: a,
        position,
        velocity,
    })
}
fn slerp(a: [f64; 4], mut b: [f64; 4], t: f64) -> [f64; 4] {
    let mut dot = a.iter().zip(b).map(|(a, b)| a * b).sum::<f64>();
    if dot < 0. {
        b = b.map(|v| -v);
        dot = -dot;
    }
    let q = if dot > 0.9995 {
        std::array::from_fn(|i| a[i] + t * (b[i] - a[i]))
    } else {
        let theta = dot.clamp(-1., 1.).acos();
        let den = theta.sin();
        std::array::from_fn(|i| {
            a[i] * ((1. - t) * theta).sin() / den + b[i] * (t * theta).sin() / den
        })
    };
    normalized(q).expect("Interpolation of normalized quaternions")
}

#[derive(Debug, Default)]
pub struct Estimator {
    orientations: VecDeque<Orientation>,
    pending: VecDeque<Acceleration>,
    observed: [Option<u64>; 2],
    accept_after: u64,
    ready_at: Option<u64>,
    hold: Option<(u64, [f64; 4])>,
    integration: Option<Integration>,
    pub estimate: Option<Estimate>,
    pub status: String,
}
impl Estimator {
    pub fn in_epoch(&self, at: u64) -> bool {
        at >= self.accept_after
    }
    pub fn ready(&self, at: u64) -> bool {
        self.ready_at
            .is_some_and(|t| at.saturating_sub(t) <= STALE_NS)
    }
    pub fn begin(&mut self, at: u64, heading: [f64; 4]) {
        self.end();
        self.hold = Some((at, heading));
        self.pending.retain(|a| a.at >= at);
        self.status =
            "Waiting for first aligned sample after press; initial velocity assumed zero".into();
    }
    pub fn end(&mut self) {
        self.hold = None;
        self.integration = None;
        self.estimate = None;
    }
    pub fn invalidate(&mut self, reason: &str) {
        self.end();
        self.orientations.clear();
        self.pending.clear();
        self.ready_at = None;
        self.status = reason.into();
    }
    pub fn resume(&mut self, at: u64) {
        self.invalidate("Waiting for fresh aligned orientation + acceleration");
        self.accept_after = at;
    }
    fn accept(&mut self, kind: usize, at: u64, received: u64) -> Result<bool, &'static str> {
        if at < self.accept_after {
            return Ok(false);
        } // Delayed callback from before resume.
        if at > received {
            return Err("Future IMU timestamp");
        }
        if received - at > STALE_NS {
            return Err("Stale IMU acquisition");
        }
        if let Some(last) = self.observed[kind] {
            if at < last {
                return Err("Out-of-order IMU timestamp");
            }
            if at == last {
                return Ok(false);
            } // No new measurement, no freshness advance.
        }
        self.observed[kind] = Some(at);
        Ok(true)
    }
    pub fn orientation(
        &mut self,
        at: u64,
        q: [f64; 4],
        received: u64,
    ) -> Result<Option<Estimate>, &'static str> {
        let result = (|| {
            let q = normalized(q).ok_or("Invalid orientation");
            if !self.accept(0, at, received)? {
                return Ok(None);
            }
            self.orientations.push_back(Orientation { at, q: q? });
            if self.orientations.len() > CAPACITY {
                self.orientations.pop_front();
            }
            self.process(received)
        })();
        if let Err(reason) = result {
            self.invalidate(reason);
        }
        result
    }
    pub fn acceleration(
        &mut self,
        at: u64,
        value: [f64; 3],
        received: u64,
    ) -> Result<Option<Estimate>, &'static str> {
        let result = (|| {
            if !self.accept(1, at, received)? {
                return Ok(None);
            }
            if value
                .iter()
                .any(|v| !v.is_finite() || v.abs() > f32::MAX as f64)
            {
                return Err("Invalid accelerometer value");
            }
            if self.pending.len() >= CAPACITY {
                return Err("IMU alignment buffer exhausted");
            }
            self.pending.push_back(Acceleration { at, value });
            self.process(received)
        })();
        if let Err(reason) = result {
            self.invalidate(reason);
        }
        result
    }
    fn aligned(&self, at: u64) -> Result<Option<[f64; 4]>, &'static str> {
        let Some(left) = self.orientations.iter().rev().find(|q| q.at <= at) else {
            return if self.orientations.is_empty() {
                Ok(None)
            } else {
                Err("Acceleration has no earlier orientation")
            };
        };
        if at - left.at > ALIGN_NS {
            return Err("Orientation/acceleration skew exceeds 25 ms");
        }
        if left.at == at {
            return Ok(Some(left.q));
        }
        let Some(right) = self.orientations.iter().find(|q| q.at >= at) else {
            return Ok(None);
        };
        if right.at - at > ALIGN_NS {
            return Err("Orientation/acceleration skew exceeds 25 ms");
        }
        Ok(Some(slerp(
            left.q,
            right.q,
            (at - left.at) as f64 / (right.at - left.at) as f64,
        )))
    }
    fn process(&mut self, received: u64) -> Result<Option<Estimate>, &'static str> {
        let mut output = None;
        while let Some(a) = self.pending.front().copied() {
            if received.saturating_sub(a.at) > STALE_NS {
                return Err("Timed out waiting for aligned orientation");
            }
            let q = match self.aligned(a.at) {
                Ok(Some(q)) => q,
                Ok(None) => break,
                Err(reason) if self.hold.is_none() => {
                    // Warm-up can start between sensor phases. Retain the new
                    // orientation as a left bracket for the NEXT acceleration;
                    // clearing it here could otherwise prevent recovery forever.
                    self.pending.pop_front();
                    self.ready_at = None;
                    self.status = format!("{reason}; waiting for a fresh aligned pair");
                    continue;
                }
                Err(reason) => return Err(reason),
            };
            self.pending.pop_front();
            self.ready_at = Some(a.at);
            let Some((hold_at, heading)) = self.hold else {
                self.status = "Aligned IMU ready; new hold starts from zero".into();
                continue;
            };
            if a.at < hold_at {
                continue;
            }
            // The accelerometer is in PHONE axes, not the rotated grip axes.
            let local_phone = multiply(heading, q);
            let mut linear = rotate(local_phone, a.value);
            linear[1] -= GRAVITY;
            if linear
                .iter()
                .any(|v| !v.is_finite() || v.abs() > f32::MAX as f64)
            {
                return Err("Rotated acceleration overflow");
            }
            let next = if let Some(previous) = self.integration {
                integrate(previous, a.at, linear)?
            } else {
                Integration {
                    at: a.at,
                    acceleration: linear,
                    position: [0.; 3],
                    velocity: [0.; 3],
                }
            };
            let h = std::f64::consts::FRAC_1_SQRT_2;
            let estimate = Estimate {
                at: a.at,
                pose: Pose {
                    position: next.position,
                    orientation: normalized(multiply(local_phone, [h, 0., 0., h])).unwrap(),
                },
                velocity: next.velocity,
            };
            self.integration = Some(next);
            self.estimate = Some(estimate);
            output = Some(estimate);
            self.status = "Integrating IMU displacement estimate; drift is uncorrected".into();
        }
        Ok(output)
    }
    pub fn expired(&self, at: u64) -> bool {
        self.pending
            .front()
            .is_some_and(|a| at.saturating_sub(a.at) > STALE_NS)
            || (self.hold.is_some() && !self.ready(at))
    }
}
