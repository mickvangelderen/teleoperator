use crate::tracking::Pose;
use std::sync::Arc;

pub const JOINT_SET: &str = "XR_BODY_JOINT_SET_DEFAULT_FB";
pub const JOINT_COUNT: usize = 70;

#[derive(Clone, Debug)]
pub struct Joint {
    pub id: u32,
    pub parent: i32,
    pub name: String,
    pub rest: Pose,
}
#[derive(Clone, Debug)]
pub struct Skeleton {
    pub version: u32,
    pub reference_version: u32,
    pub joints: Vec<Joint>,
}
#[derive(Clone, Copy, Debug)]
pub enum Fidelity {
    Low,
    High,
}
#[derive(Clone, Copy, Debug)]
pub enum CalibrationStatus {
    Unknown,
    Valid,
    Calibrating,
    Invalid,
}
#[derive(Clone, Debug)]
pub struct Body {
    pub skeleton: Arc<Skeleton>,
    pub active: bool,
    pub confidence: Option<f32>,
    pub returned_at: Option<i64>,
    pub fidelity: Option<Fidelity>,
    pub calibration: Option<CalibrationStatus>,
    pub joints: Vec<Pose>,
}
impl Skeleton {
    pub fn valid(&self) -> bool {
        if self.version == 0 || self.reference_version == 0 || self.joints.len() != JOINT_COUNT {
            return false;
        }
        if self
            .joints
            .iter()
            .any(|j| j.parent < -1 || j.parent >= JOINT_COUNT as i32)
        {
            return false;
        }
        for (i, joint) in self.joints.iter().enumerate() {
            if joint.id as usize != i
                || joint.parent < -1
                || joint.parent >= JOINT_COUNT as i32
                || !joint
                    .rest
                    .position
                    .iter()
                    .chain(&joint.rest.orientation)
                    .all(|v| v.is_finite())
                || (joint.rest.orientation.iter().map(|v| v * v).sum::<f32>() - 1.).abs() > 0.02
            {
                return false;
            }
            let mut parent = joint.parent;
            for step in 0..=JOINT_COUNT {
                if parent == -1 {
                    break;
                }
                if step == JOINT_COUNT {
                    return false;
                }
                parent = self.joints[parent as usize].parent;
            }
        }
        true
    }
}
impl Body {
    pub fn inactive(skeleton: Arc<Skeleton>) -> Self {
        Self {
            joints: vec![Pose::default(); skeleton.joints.len()],
            skeleton,
            active: false,
            confidence: None,
            returned_at: None,
            fidelity: None,
            calibration: None,
        }
    }
}
pub fn synthetic_skeleton() -> Arc<Skeleton> {
    let core = [
        ("root", -1, [0., 1., 0.]),
        ("hips", 0, [0., 1., 0.]),
        ("spine/lower", 1, [0., 1.1, 0.]),
        ("spine/middle", 2, [0., 1.2, 0.]),
        ("spine/upper", 3, [0., 1.3, 0.]),
        ("chest", 4, [0., 1.4, 0.]),
        ("neck", 5, [0., 1.5, 0.]),
        ("head", 6, [0., 1.65, 0.]),
        ("left/shoulder", 5, [-0.15, 1.4, 0.]),
        ("left/scapula", 5, [-0.1, 1.4, 0.05]),
        ("left/upper_arm", 8, [-0.28, 1.4, 0.]),
        ("left/lower_arm", 10, [-0.48, 1.4, 0.]),
        ("left/wrist_twist", 11, [-0.65, 1.4, 0.]),
        ("right/shoulder", 5, [0.15, 1.4, 0.]),
        ("right/scapula", 5, [0.1, 1.4, 0.05]),
        ("right/upper_arm", 13, [0.28, 1.4, 0.]),
        ("right/lower_arm", 15, [0.48, 1.4, 0.]),
        ("right/wrist_twist", 16, [0.65, 1.4, 0.]),
    ];
    let mut joints: Vec<_> = core
        .iter()
        .enumerate()
        .map(|(id, (name, parent, position))| Joint {
            id: id as u32,
            parent: *parent,
            name: (*name).into(),
            rest: Pose {
                position: *position,
                orientation: [0., 0., 0., 1.],
                flags: 15,
                active: None,
            },
        })
        .collect();
    for (hand, sign, parent) in [("left", -1., 12), ("right", 1., 17)] {
        let base = joints.len();
        for i in 0..26 {
            let (name, parent_id, reach, spread) = if i < 2 {
                (
                    if i == 0 {
                        "palm".to_string()
                    } else {
                        "wrist".to_string()
                    },
                    parent,
                    if i == 0 { 0.04 } else { 0. },
                    0.,
                )
            } else {
                let n = i - 2;
                let (finger, segment) = if n < 4 {
                    (0, n)
                } else {
                    (1 + (n - 4) / 5, (n - 4) % 5)
                };
                (
                    format!("finger_{finger}/{segment}"),
                    if segment == 0 {
                        base as i32
                    } else {
                        (base + i - 1) as i32
                    },
                    0.04 + segment as f32 * 0.025,
                    (finger as f32 - 2.) * 0.02,
                )
            };
            joints.push(Joint {
                id: joints.len() as u32,
                parent: parent_id,
                name: format!("{hand}/{name}"),
                rest: Pose {
                    position: [sign * (0.65 + reach), 1.4, spread],
                    orientation: [0., 0., 0., 1.],
                    flags: 15,
                    active: None,
                },
            });
        }
    }
    Arc::new(Skeleton {
        version: 1,
        reference_version: 1,
        joints,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skeleton_is_complete_and_rejects_cycles_or_invalid_geometry() {
        let s = synthetic_skeleton();
        assert!(s.valid());
        assert_eq!(s.joints.len(), 70);
        let mut invalid = (*s).clone();
        invalid.joints[0].parent = 1;
        assert!(!invalid.valid());
        invalid = (*s).clone();
        invalid.joints[3].rest.position[0] = f32::NAN;
        assert!(!invalid.valid());
    }
}
