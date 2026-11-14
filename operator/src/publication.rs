//! Device bindings. The protocol itself does not depend on OpenXR identities.
use crate::{
    body, inputs,
    protocol::{Capabilities, Descriptor, Joint, Value},
    tracking::{Hub, Pose, RATE, Sample},
};
use std::sync::atomic::Ordering;

#[derive(Clone, Debug)]
pub enum Source {
    Pose(usize),
    Input(usize, u8),
    Joint(usize),
    Rest(usize),
    PoseFlag(usize, u16),
    JointFlag(usize, u16),
    Confidence,
    Revision,
}
#[derive(Clone)]
pub struct Catalog {
    pub capabilities: Capabilities,
    pub sources: Vec<Source>,
    contract: (bool, bool, bool),
    parents: Vec<i32>,
}
impl Catalog {
    pub fn snapshot(hub: &Hub) -> Self {
        let contract = Self::contract(hub);
        let skeleton = hub.skeleton.lock().unwrap().clone();
        let mut result = Self {
            capabilities: Capabilities::default(),
            sources: Vec::new(),
            contract,
            parents: skeleton
                .as_ref()
                .map_or_else(Vec::new, |s| s.joints.iter().map(|j| j.parent).collect()),
        };
        if !contract.0 || hub.source == "none" {
            return result;
        }
        result.capabilities.groups.push(RATE);
        let space = if contract.1 { 4 } else { 2 };
        for (i, (id, name)) in [
            ("/user/head/input/pose", "Head"),
            ("/user/hand/left/input/aim/pose", "Left aim"),
            ("/user/hand/left/input/grip/pose", "Left grip"),
            ("/user/hand/right/input/aim/pose", "Right aim"),
            ("/user/hand/right/input/grip/pose", "Right grip"),
        ]
        .into_iter()
        .enumerate()
        {
            let index = result.sources.len();
            result.add(
                id.into(),
                name.into(),
                10,
                vec![10, 11],
                vec![space],
                Source::Pose(i),
            );
            result.quality(index, false, i);
        }
        for (i, d) in inputs::definitions().iter().enumerate() {
            let component = if d.kind == inputs::InputType::Boolean && d.path.ends_with("/value") {
                d.id
            } else {
                d.path
            };
            let id = format!("/user/hand/{}/input/{}", d.source, component);
            let name = format!("{} {}", d.source, d.label);
            match d.kind {
                inputs::InputType::Boolean => {
                    let touched = d.id.ends_with("/touch");
                    let index = result.sources.len();
                    result.add(
                        id.clone(),
                        name.clone(),
                        if touched { 5 } else { 2 },
                        vec![1],
                        vec![],
                        Source::Input(i, 0),
                    );
                    for (field, kind, suffix) in if touched {
                        [(1, 6, "touch_count"), (2, 7, "untouch_count")]
                    } else {
                        [(1, 3, "press_count"), (2, 4, "release_count")]
                    } {
                        result.add(
                            format!("{id}/{suffix}"),
                            format!("{name} {suffix}"),
                            kind,
                            vec![2, 3, 4, 5],
                            vec![],
                            Source::Input(i, field),
                        );
                    }
                    let d = &mut result.capabilities.descriptors[index];
                    if touched {
                        d.touch_count_sample = Some(index as u32 + 1);
                        d.untouch_count_sample = Some(index as u32 + 2);
                    } else {
                        d.press_count_sample = Some(index as u32 + 1);
                        d.release_count_sample = Some(index as u32 + 2);
                    }
                }
                inputs::InputType::Scalar => result.add(
                    id,
                    name,
                    8,
                    vec![12, 13, 10, 11],
                    vec![],
                    Source::Input(i, 0),
                ),
                inputs::InputType::Vector2 => result.add(
                    format!("/user/hand/{}/input/{}", d.source, d.path),
                    name,
                    9,
                    vec![14, 15, 10, 11],
                    vec![],
                    Source::Input(i, 0),
                ),
            }
        }
        if let Some(skeleton) = skeleton.filter(|s| contract.2 && s.valid()) {
            result.capabilities.groups.push(RATE);
            let confidence = result.sources.len() as u32;
            result.add(
                "/body/FB/confidence".into(),
                "Body confidence".into(),
                16,
                vec![12, 13, 10, 11],
                vec![],
                Source::Confidence,
            );
            result.add(
                "/body/FB/revision".into(),
                "Body rest revision".into(),
                11,
                vec![4, 5],
                vec![],
                Source::Revision,
            );
            result
                .capabilities
                .descriptors
                .last_mut()
                .unwrap()
                .revision_of = Some(1);
            let mut joints = Vec::new();
            for (i, joint) in skeleton.joints.iter().enumerate() {
                let pose_sample = result.sources.len() as u32;
                result.add(
                    format!("/body/FB/{i}"),
                    joint.name.clone(),
                    10,
                    vec![10, 11],
                    vec![space],
                    Source::Joint(i),
                );
                result.quality(pose_sample as usize, true, i);
                result.capabilities.descriptors[pose_sample as usize].confidence_sample =
                    Some(confidence);
                let rest_pose_sample = result.sources.len() as u32;
                result.add(
                    format!("/body/FB/{i}/rest"),
                    format!("{} rest", joint.name),
                    10,
                    vec![10, 11],
                    vec![5],
                    Source::Rest(i),
                );
                result.capabilities.descriptors.last_mut().unwrap().group = 1;
                joints.push(Joint {
                    parent: if joint.parent < 0 {
                        i as u32
                    } else {
                        joint.parent as u32
                    },
                    pose_sample,
                    rest_pose_sample,
                });
            }
            result.add(
                "/body/FB/rest/revision".into(),
                "Rest revision".into(),
                11,
                vec![4, 5],
                vec![],
                Source::Revision,
            );
            let d = result.capabilities.descriptors.last_mut().unwrap();
            d.group = 1;
            d.revision_of = Some(1);
            result.capabilities.skeletons.push(joints);
        }
        result.capabilities.validate().expect("Device capabilities");
        result
    }
    fn contract(hub: &Hub) -> (bool, bool, bool) {
        (
            hub.initialized.load(Ordering::SeqCst),
            hub.local_floor.load(Ordering::SeqCst),
            hub.body_supported.load(Ordering::SeqCst),
        )
    }
    pub fn changed(&self, hub: &Hub) -> bool {
        self.contract != Self::contract(hub)
            || self.parents
                != hub
                    .skeleton
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map_or_else(Vec::new, |s| s.joints.iter().map(|j| j.parent).collect())
    }
    fn quality(&mut self, index: usize, body: bool, joint: usize) {
        let first = self.sources.len() as u32;
        for (kind, flag, suffix) in [
            (12, 2, "position_valid"),
            (13, 1, "orientation_valid"),
            (14, 8, "position_tracked"),
            (15, 4, "orientation_tracked"),
        ] {
            let d = &self.capabilities.descriptors[index];
            self.add(
                format!("{}/{suffix}", d.id),
                format!("{} {suffix}", d.name),
                kind,
                vec![1],
                vec![],
                if body {
                    Source::JointFlag(joint, flag)
                } else {
                    Source::PoseFlag(joint, flag)
                },
            );
        }
        let d = &mut self.capabilities.descriptors[index];
        d.position_valid_sample = Some(first);
        d.orientation_valid_sample = Some(first + 1);
        d.position_tracked_sample = Some(first + 2);
        d.orientation_tracked_sample = Some(first + 3);
    }
    fn add(
        &mut self,
        id: String,
        name: String,
        kind: u8,
        formats: Vec<u8>,
        spaces: Vec<u8>,
        source: Source,
    ) {
        let description = if matches!(source, Source::Joint(_)) {
            format!("{} individual joint pose", body::JOINT_SET)
        } else {
            name.clone()
        };
        self.capabilities.descriptors.push(Descriptor {
            id,
            name,
            description,
            kind,
            formats,
            spaces,
            group: 0,
            ..Descriptor::default()
        });
        self.sources.push(source);
    }
    pub fn value(&self, index: u32, sample: &Sample) -> Option<Value> {
        match self.sources.get(index as usize)? {
            Source::Pose(i) => pose_value(sample.poses.get(*i)?),
            Source::PoseFlag(i, flag) => {
                let p = sample.poses.get(*i)?;
                Some(Value::Bit(p.active != Some(false) && p.flags & flag != 0))
            }
            Source::JointFlag(i, flag) => {
                let body = sample.body.as_ref()?;
                Some(Value::Bit(
                    body.active && body.joints.get(*i)?.flags & flag != 0,
                ))
            }
            Source::Confidence => Some(Value::Numbers(vec![
                sample.body.as_ref()?.confidence? as f64,
            ])),
            Source::Revision => Some(Value::Unsigned(sample.body.as_ref()?.skeleton.version)),
            Source::Rest(i) => {
                let skeleton = &sample.body.as_ref()?.skeleton;
                let joint = skeleton.joints.get(*i)?;
                if joint.parent < 0 {
                    return Some(Value::Numbers(vec![0., 0., 0., 0., 0., 0., 1.]));
                }
                // OpenXR rest poses share one frame; the advertised wire space is parent.
                let parent = &skeleton.joints.get(joint.parent as usize)?.rest;
                pose_value(&relative_pose(&joint.rest, parent))
            }
            Source::Joint(i) => {
                let body = sample.body.as_ref()?;
                if !body.active {
                    return None;
                }
                pose_value(body.joints.get(*i)?)
            }
            Source::Input(i, field) => {
                let input = sample.inputs.get(*i)?;
                if !input.active {
                    return None;
                }
                Some(match &input.value {
                    inputs::Value::Boolean {
                        value,
                        presses,
                        releases,
                    } => match field {
                        1 => Value::Unsigned(*presses),
                        2 => Value::Unsigned(*releases),
                        _ => Value::Bit(*value),
                    },
                    inputs::Value::Scalar(v) => Value::Numbers(vec![*v as f64]),
                    inputs::Value::Vector2(v) => {
                        Value::Numbers(v.iter().map(|v| *v as f64).collect())
                    }
                })
            }
        }
    }
}
fn relative_pose(pose: &Pose, parent: &Pose) -> Pose {
    let norm = parent.orientation.iter().map(|v| v * v).sum::<f32>().sqrt();
    let [x, y, z, w] = parent.orientation.map(|v| v / norm);
    let [x, y, z] = [-x, -y, -z];
    let d: [f32; 3] = std::array::from_fn(|i| pose.position[i] - parent.position[i]);
    // Rotate the displacement by the inverse parent orientation.
    let t = [
        2. * (y * d[2] - z * d[1]),
        2. * (z * d[0] - x * d[2]),
        2. * (x * d[1] - y * d[0]),
    ];
    let [qx, qy, qz, qw] = pose.orientation;
    Pose {
        position: [
            d[0] + w * t[0] + y * t[2] - z * t[1],
            d[1] + w * t[1] + z * t[0] - x * t[2],
            d[2] + w * t[2] + x * t[1] - y * t[0],
        ],
        orientation: [
            w * qx + x * qw + y * qz - z * qy,
            w * qy - x * qz + y * qw + z * qx,
            w * qz + x * qy - y * qx + z * qw,
            w * qw - x * qx - y * qy - z * qz,
        ],
        flags: pose.flags,
        active: pose.active,
    }
}
pub fn pose_value(p: &Pose) -> Option<Value> {
    if p.active == Some(false) {
        return None;
    }
    let position = if p.flags & 2 != 0 {
        p.position
    } else {
        [0.; 3]
    };
    let orientation = if p.flags & 1 != 0 {
        p.orientation
    } else {
        [0., 0., 0., 1.]
    };
    if !position.iter().chain(&orientation).all(|v| v.is_finite()) {
        return None;
    }
    let norm = orientation
        .iter()
        .map(|v| (*v as f64).powi(2))
        .sum::<f64>()
        .sqrt();
    if norm == 0. {
        return None;
    }
    Some(Value::Numbers(
        position
            .iter()
            .map(|v| *v as f64)
            .chain(orientation.iter().map(|v| *v as f64 / norm))
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{self, Message, Request, Selection, Session};

    #[test]
    fn rest_publications_convert_common_space_poses_to_parent_space() {
        let h = Hub::new("test");
        h.initialized.store(true, Ordering::SeqCst);
        h.body_supported.store(true, Ordering::SeqCst);
        let mut body = body::Body::inactive(body::synthetic_skeleton());
        let skeleton = std::sync::Arc::make_mut(&mut body.skeleton);
        let s = std::f32::consts::FRAC_1_SQRT_2;
        // Translated root with a 90-degree Y rotation; child adds a Z rotation.
        // Small runtime quaternion length errors must not distort bone lengths.
        for (joint, (position, orientation)) in skeleton.joints.iter_mut().zip([
            ([4., 5., 6.], [0., s * 1.001, 0., s * 1.001]),
            ([4., 6., 6.], [0.5, 0.5, 0.5, 0.5]),
            ([4., 7., 6.], [0.5, 0.5, 0.5, 0.5]),
        ]) {
            joint.rest.position = position;
            joint.rest.orientation = orientation;
        }
        assert!(skeleton.valid());
        body.active = true;
        body.joints = skeleton.joints.iter().map(|j| j.rest.clone()).collect();
        h.acquire(
            &std::array::from_fn(|_| Pose::default()),
            &[],
            Some(&body),
            0,
            None,
        );
        let c = Catalog::snapshot(&h);
        let sample = h.latest.lock().unwrap().clone().unwrap();
        let joints = &c.capabilities.skeletons[0];
        let s = std::f64::consts::FRAC_1_SQRT_2;
        for (joint, expected) in joints.iter().zip([
            [0., 0., 0., 0., 0., 0., 1.],
            [0., 1., 0., 0., 0., s, s],
            [1., 0., 0., 0., 0., 0., 1.],
        ]) {
            assert_eq!(
                c.capabilities.descriptors[joint.rest_pose_sample as usize].spaces,
                [5]
            );
            let Some(Value::Numbers(actual)) = c.value(joint.rest_pose_sample, &sample) else {
                panic!("Rest pose unavailable");
            };
            for (a, e) in actual.iter().zip(expected) {
                assert!((a - e).abs() < 1e-6, "{actual:?} != {expected:?}");
            }
        }
        assert_eq!(joints[0].parent, 0, "The root is self-relative");
        let Some(Value::Numbers(live)) = c.value(joints[1].pose_sample, &sample) else {
            panic!("Live pose unavailable");
        };
        assert_eq!(
            live,
            vec![4., 6., 6., 0.5, 0.5, 0.5, 0.5],
            "Live poses remain in their tracking reference space"
        );
    }

    #[test]
    fn reliable_rest_publishes_initial_snapshot_then_changes_and_availability() {
        let h = Hub::new("test");
        h.initialized.store(true, Ordering::SeqCst);
        h.body_supported.store(true, Ordering::SeqCst);
        let poses = std::array::from_fn(|_| Pose::default());
        let mut body = body::Body::inactive(body::synthetic_skeleton());
        h.acquire(&poses, &[], Some(&body), 0, None);
        let c = Catalog::snapshot(&h);
        let mut session = Session::new(c.capabilities.clone());
        session.handle(Message::Offer(vec![1]), 0).unwrap();
        let request = Request {
            id: 1,
            group: 1,
            delivery: 2,
            rate: 1.,
            // Deliberately omit the revision sample: native revision changes still publish.
            samples: c
                .capabilities
                .descriptors
                .iter()
                .enumerate()
                .filter(|(_, d)| d.group == 1 && d.kind == 10)
                .map(|(i, d)| Selection {
                    descriptor: i as u32,
                    format: d.formats[0],
                    space: d.spaces[0],
                })
                .collect(),
        };
        session
            .handle(Message::Subscribe(request.clone()), 0)
            .unwrap();
        assert!(session.active[&1].on_change);
        assert!(!c.capabilities.rest_group(0));
        let publish = |session: &mut Session, body: Option<&body::Body>, now| {
            h.acquire(&poses, &[], body, now, None);
            assert!(!c.changed(&h), "Availability does not change the catalog");
            let sample = h.latest.lock().unwrap().clone().unwrap();
            let sub = session.active.get_mut(&1).unwrap();
            let Some(timestamp) = sub.timestamp(now, 0, now) else {
                return false;
            };
            let values = sub
                .request
                .samples
                .iter()
                .map(|s| c.value(s.descriptor, &sample))
                .collect::<Vec<_>>();
            let bytes = protocol::tracking(
                &c.capabilities,
                &sub.request,
                sub.generation,
                timestamp,
                &values,
            );
            let revision = body.map(|b| b.skeleton.version);
            if !sub.should_publish(revision, &bytes) {
                return false;
            }
            assert!(
                sub.should_publish(revision, &bytes),
                "Only a successful send commits the snapshot"
            );
            sub.published(now, now, revision, &bytes);
            true
        };
        assert!(publish(&mut session, Some(&body), 0));
        for t in 1..=600 {
            assert!(!publish(&mut session, Some(&body), t * 5_000_000));
        }
        // No one-second timer delay, even when the encoded poses are identical.
        std::sync::Arc::make_mut(&mut body.skeleton).version += 256;
        assert!(publish(&mut session, Some(&body), 3_005_000_000));
        assert!(!publish(&mut session, Some(&body), 3_010_000_000));
        std::sync::Arc::make_mut(&mut body.skeleton).joints[1]
            .rest
            .position[0] += 0.1;
        assert!(publish(&mut session, Some(&body), 3_015_000_000));
        assert!(publish(&mut session, None, 3_020_000_000));
        assert!(!publish(&mut session, None, 3_025_000_000));
        assert!(publish(&mut session, Some(&body), 3_030_000_000));
        session
            .handle(Message::Subscribe(request.clone()), 3_030_000_000)
            .unwrap();
        assert!(
            publish(&mut session, Some(&body), 3_035_000_000),
            "Replacement sends a fresh snapshot"
        );
        session
            .handle(
                Message::Subscribe(Request {
                    delivery: 1,
                    ..request
                }),
                3_040_000_000,
            )
            .unwrap();
        assert!(!session.active[&1].on_change);
        assert!(publish(&mut session, Some(&body), 3_040_000_000));
        assert!(!publish(&mut session, Some(&body), 3_045_000_000));
        assert!(
            publish(&mut session, Some(&body), 4_040_000_000),
            "Unreliable snapshots refresh after packet loss"
        );
    }
    #[test]
    fn capabilities_use_actual_spaces_native_paths_and_stable_body_indices() {
        let h = Hub::new("test");
        assert!(Catalog::snapshot(&h).capabilities.descriptors.is_empty());
        h.initialized.store(true, Ordering::SeqCst);
        h.local_floor.store(true, Ordering::SeqCst);
        h.body_supported.store(true, Ordering::SeqCst);
        *h.skeleton.lock().unwrap() = Some(body::synthetic_skeleton());
        let c = Catalog::snapshot(&h);
        c.capabilities.validate().unwrap();
        for path in [
            "/user/hand/left/input/x/click",
            "/user/hand/left/input/y/touch",
            "/user/hand/right/input/a/click",
            "/user/hand/right/input/b/touch",
            "/user/hand/left/input/trigger/click",
            "/user/hand/left/input/trigger/value",
        ] {
            assert!(
                c.capabilities.descriptors.iter().any(|d| d.id == path),
                "{path}"
            );
        }
        assert!(
            c.capabilities
                .descriptors
                .iter()
                .filter(|d| d.kind == 10 && d.group == 0)
                .all(|d| d.spaces == [4])
        );
        assert_eq!(
            c.capabilities
                .descriptors
                .iter()
                .filter(|d| d.kind == 10 && d.group == 0 && d.id.starts_with("/body/"))
                .count(),
            70
        );
        h.local_floor.store(false, Ordering::SeqCst);
        assert!(c.changed(&h));
    }
    #[test]
    fn recenter_keeps_the_catalog_and_publishes_poses_in_the_new_origin() {
        let h = Hub::new("test");
        h.initialized.store(true, Ordering::SeqCst);
        for local_floor in [false, true] {
            h.local_floor.store(local_floor, Ordering::SeqCst);
            let c = Catalog::snapshot(&h);
            for x in [1., 0., -1.] {
                h.reset_reference();
                assert!(!c.changed(&h), "Recentering does not change capabilities");
                let poses = std::array::from_fn(|_| Pose {
                    position: [x, 1.6, 0.],
                    orientation: [0., 0., 0., 1.],
                    flags: 3,
                    active: None,
                });
                h.acquire(&poses, &[], None, h.now(), None);
                let sample = h.latest.lock().unwrap().clone().unwrap();
                let Some(Value::Numbers(pose)) = c.value(0, &sample) else {
                    panic!("Head pose must remain available after recentering")
                };
                assert_eq!(pose[0], x as f64);
                assert!(!c.changed(&h));
            }
        }
    }
    #[test]
    fn native_f32_rotations_are_normalized_in_binary64() {
        let mut p = Pose {
            position: [1., 2., 3.],
            orientation: [0.1, 0.2, 0.3, 0.9],
            flags: 3,
            active: None,
        };
        let Some(Value::Numbers(v)) = pose_value(&p) else {
            panic!()
        };
        assert!(crate::protocol::valid_numbers(10, 11, &v));
        p.orientation = [0.; 4];
        assert!(pose_value(&p).is_none());
        p.orientation = [f32::NAN; 4];
        assert!(pose_value(&p).is_none());
        p.orientation = [0., 0., 0., 1.];
        p.flags = 1;
        let Some(Value::Numbers(values)) = pose_value(&p) else {
            panic!("Orientation remains available")
        };
        assert_eq!(&values[..3], &[0., 0., 0.]);
    }
}
