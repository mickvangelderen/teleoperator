//! Device bindings. The protocol itself does not depend on OpenXR identities.
use crate::{
    body, inputs,
    protocol::{Capabilities, Descriptor, Joint, Value},
    tracking::{Group, Hub, Pose, RATE, Sample},
};
use std::sync::{Arc, atomic::Ordering};

#[derive(Clone, Debug)]
pub enum Source {
    Pose(usize),
    Input(usize, u8),
    Joint(usize),
    Rest(usize),
    PoseFlag(usize, u16),
    JointFlag(usize, u16),
    Confidence,
    ConfidenceValid,
    Revision,
}
#[derive(Clone)]
pub struct Catalog {
    pub capabilities: Capabilities,
    pub sources: Vec<Source>,
    contract: (bool, bool, bool),
    parents: Vec<i32>,
    skeleton: Option<Arc<body::Skeleton>>,
    observed_skeleton: Option<(Arc<body::Skeleton>, bool)>,
}
impl Catalog {
    pub fn predicted_for(
        &self,
        request: &crate::protocol::Request,
        sample: &Sample,
    ) -> Option<u64> {
        let predicted = request.samples.iter().any(|selection| {
            match self.sources.get(selection.descriptor as usize) {
                Some(Source::Pose(i)) => {
                    sample.poses.get(*i).is_some_and(|p| pose_flags(p) & 3 != 0)
                }
                Some(Source::Joint(i)) => sample.body.as_ref().is_some_and(|b| {
                    b.active && b.joints.get(*i).is_some_and(|p| pose_flags(p) & 3 != 0)
                }),
                _ => false,
            }
        });
        predicted
            .then_some(sample.target_at)
            .flatten()
            .and_then(|t| u64::try_from(t).ok())
            .filter(|t| *t < u64::MAX)
    }
    fn valid_skeleton(&mut self, skeleton: &Arc<body::Skeleton>) -> bool {
        if self
            .skeleton
            .as_ref()
            .is_some_and(|s| Arc::ptr_eq(s, skeleton))
        {
            return true;
        }
        if let Some((observed, valid)) = &self.observed_skeleton
            && Arc::ptr_eq(observed, skeleton)
        {
            return *valid;
        }
        let valid = skeleton.valid();
        self.observed_skeleton = Some((skeleton.clone(), valid));
        valid
    }
    pub fn refresh_skeleton(&mut self, hub: &Hub, sample: &Sample) {
        // One retained definition per publication; present-body values keep their own revision.
        let skeleton = sample
            .body
            .as_ref()
            .map(|b| b.skeleton.clone())
            .or_else(|| hub.skeleton.lock().unwrap().clone());
        if let Some(skeleton) = skeleton.filter(|s| self.valid_skeleton(s)) {
            self.skeleton = Some(skeleton);
        }
    }
    pub fn publication(
        &self,
        request: &crate::protocol::Request,
        sample: &Sample,
        timestamp: u64,
    ) -> crate::protocol::Result<Vec<u8>> {
        let mut buffer = Vec::new();
        self.publication_into(request, sample, timestamp, &mut Vec::new(), &mut buffer)?;
        Ok(buffer)
    }
    pub(crate) fn publication_into(
        &self,
        request: &crate::protocol::Request,
        sample: &Sample,
        timestamp: u64,
        values: &mut Vec<Value>,
        buffer: &mut Vec<u8>,
    ) -> crate::protocol::Result<()> {
        if request.samples.iter().any(|s| {
            matches!(
                self.sources.get(s.descriptor as usize),
                Some(
                    Source::Joint(_)
                        | Source::JointFlag(_, _)
                        | Source::Rest(_)
                        | Source::Revision
                        | Source::Confidence
                        | Source::ConfidenceValid
                )
            )
        }) && sample.body.as_ref().is_some_and(|b| {
            !self
                .skeleton
                .as_ref()
                .is_some_and(|s| Arc::ptr_eq(s, &b.skeleton))
        }) {
            return Err("Selected body source has an invalid or unvalidated skeleton".into());
        }
        values.clear();
        for selection in &request.samples {
            values.push(self.value(selection.descriptor, sample).ok_or_else(|| {
                format!(
                    "Selected source {} is missing from the acquisition",
                    selection.descriptor
                )
            })?);
        }
        crate::protocol::tracking_into(
            &self.capabilities,
            request,
            timestamp,
            self.predicted_for(request, sample),
            values,
            buffer,
        )
    }
    pub fn snapshot(hub: &Hub) -> Self {
        let contract = Self::contract(hub);
        let skeleton = hub.skeleton.lock().unwrap().clone();
        let observed_skeleton = skeleton.map(|s| {
            let valid = s.valid();
            (s, valid)
        });
        let skeleton = observed_skeleton
            .as_ref()
            .filter(|(_, valid)| *valid)
            .map(|(s, _)| s.clone());
        let mut result = Self {
            capabilities: Capabilities::default(),
            sources: Vec::new(),
            contract,
            skeleton: skeleton.clone(),
            observed_skeleton,
            parents: skeleton
                .as_ref()
                .map_or_else(Vec::new, |s| s.joints.iter().map(|j| j.parent).collect()),
        };
        if !contract.0 || hub.source == "none" {
            return result;
        }
        result.capabilities.groups.extend([RATE, RATE]);
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
            let value_index = result.sources.len();
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
                    id.clone(),
                    name.clone(),
                    8,
                    vec![12, 13, 10, 11],
                    vec![],
                    Source::Input(i, 0),
                ),
                inputs::InputType::Vector2 => result.add(
                    format!("/user/hand/{}/input/{}", d.source, d.path),
                    name.clone(),
                    9,
                    vec![14, 15, 10, 11],
                    vec![],
                    Source::Input(i, 0),
                ),
            }
            result.capabilities.descriptors[value_index].description =
                "Inactive value is a placeholder; see /active.".into();
            result.add(
                format!("{id}/active"),
                format!("{name} active"),
                1,
                vec![1],
                vec![],
                Source::Input(i, 3),
            );
            result
                .capabilities
                .descriptors
                .last_mut()
                .unwrap()
                .description = "Whether the input value is usable.".into();
        }
        if let Some(skeleton) = skeleton.filter(|_| contract.2) {
            result.capabilities.groups.extend([RATE, RATE]);
            let confidence = result.sources.len() as u32;
            result.add(
                "/body/FB/confidence".into(),
                "Body confidence".into(),
                16,
                vec![12, 13, 10, 11],
                vec![],
                Source::Confidence,
            );
            result
                .capabilities
                .descriptors
                .last_mut()
                .unwrap()
                .description = "Zero placeholder when /body/FB/confidence/valid is false.".into();
            result.add(
                "/body/FB/confidence/valid".into(),
                "Confidence valid".into(),
                1,
                vec![1],
                vec![],
                Source::ConfidenceValid,
            );
            result
                .capabilities
                .descriptors
                .last_mut()
                .unwrap()
                .description = "Whether body confidence is usable.".into();
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
                .revision_of = Some(Group::Rest as u32);
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
                result.capabilities.descriptors.last_mut().unwrap().group = Group::Rest as u32;
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
            d.group = Group::Rest as u32;
            d.revision_of = Some(Group::Rest as u32);
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
    pub fn changed(&mut self, hub: &Hub) -> bool {
        if self.contract != Self::contract(hub) {
            return true;
        }
        let skeleton = hub.skeleton.lock().unwrap().clone();
        skeleton
            .as_ref()
            .filter(|s| self.valid_skeleton(s))
            .is_some_and(|s| self.parents != s.joints.iter().map(|j| j.parent).collect::<Vec<_>>())
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
            String::new()
        };
        self.capabilities.descriptors.push(Descriptor {
            id,
            name,
            description,
            kind,
            formats,
            spaces,
            group: match source {
                Source::Pose(_) | Source::PoseFlag(..) => Group::Poses,
                Source::Input(..) => Group::Inputs,
                Source::Rest(_) => Group::Rest,
                _ => Group::Body,
            } as u32,
            ..Descriptor::default()
        });
        self.sources.push(source);
    }
    pub fn value(&self, index: u32, sample: &Sample) -> Option<Value> {
        let confidence = || {
            sample
                .body
                .as_ref()
                .filter(|b| b.active)
                .and_then(|b| b.confidence)
                .filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
        };
        match self.sources.get(index as usize)? {
            Source::Pose(i) => Some(pose_value(sample.poses.get(*i)?)),
            Source::PoseFlag(i, flag) => {
                Some(Value::Bit(pose_flags(sample.poses.get(*i)?) & flag != 0))
            }
            Source::JointFlag(i, flag) => Some(Value::Bit(if let Some(body) = &sample.body {
                let pose = body.joints.get(*i)?;
                body.active && pose_flags(pose) & flag != 0
            } else {
                false
            })),
            Source::Confidence => Some(Value::Numbers(vec![confidence().unwrap_or(0.) as f64])),
            Source::ConfidenceValid => Some(Value::Bit(confidence().is_some())),
            Source::Revision => Some(Value::Unsigned(
                sample
                    .body
                    .as_ref()
                    .map(|b| &b.skeleton)
                    .or(self.skeleton.as_ref())?
                    .version,
            )),
            Source::Rest(i) => {
                let skeleton = sample
                    .body
                    .as_ref()
                    .map(|b| &b.skeleton)
                    .or(self.skeleton.as_ref())?;
                let joint = skeleton.joints.get(*i)?;
                if joint.parent < 0 {
                    return Some(pose_value(&Pose::default()));
                }
                let parent = &skeleton.joints.get(joint.parent as usize)?.rest;
                let relative = relative_pose(&joint.rest, parent);
                // Rest has no validity companions: failed conversion is not an identity pose.
                (pose_flags(&relative) & 3 == 3).then(|| pose_value(&relative))
            }
            Source::Joint(i) => {
                let pose = if let Some(body) = &sample.body {
                    let pose = body.joints.get(*i)?;
                    body.active.then_some(pose)
                } else {
                    None
                };
                Some(pose_value(pose.unwrap_or(&Pose::default())))
            }
            Source::Input(i, field) => {
                let input = sample.inputs.get(*i)?;
                if !matches!(
                    (&input.value, inputs::definitions().get(*i)?.kind),
                    (inputs::Value::Boolean { .. }, inputs::InputType::Boolean)
                        | (inputs::Value::Scalar(_), inputs::InputType::Scalar)
                        | (inputs::Value::Vector2(_), inputs::InputType::Vector2)
                ) {
                    return None;
                }
                let usable = input.active
                    && match &input.value {
                        inputs::Value::Boolean { .. } => true,
                        inputs::Value::Scalar(v) => v.is_finite() && (0.0..=1.0).contains(v),
                        inputs::Value::Vector2(v) => {
                            v.iter().all(|v| v.is_finite() && (-1.0..=1.0).contains(v))
                        }
                    };
                if *field == 3 {
                    return Some(Value::Bit(usable));
                }
                Some(match &input.value {
                    inputs::Value::Boolean {
                        value,
                        presses,
                        releases,
                    } => match field {
                        1 => Value::Unsigned(*presses),
                        2 => Value::Unsigned(*releases),
                        _ => Value::Bit(usable && *value),
                    },
                    inputs::Value::Scalar(v) => {
                        Value::Numbers(vec![if usable { *v as f64 } else { 0. }])
                    }
                    inputs::Value::Vector2(v) => Value::Numbers(if usable {
                        v.iter().map(|v| *v as f64).collect()
                    } else {
                        vec![0.; 2]
                    }),
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
fn pose_flags(p: &Pose) -> u16 {
    if p.active == Some(false) {
        return 0;
    }
    let mut flags = p.flags;
    if flags & 2 == 0 || !p.position.iter().all(|v| v.is_finite()) {
        flags &= !(2 | 8);
    }
    if flags & 1 == 0
        || !p.orientation.iter().all(|v| v.is_finite())
        || p.orientation.iter().all(|v| *v == 0.)
    {
        flags &= !(1 | 4);
    }
    flags
}
pub fn pose_value(p: &Pose) -> Value {
    let flags = pose_flags(p);
    let position = if flags & 2 != 0 { p.position } else { [0.; 3] };
    let orientation = if flags & 1 != 0 {
        p.orientation
    } else {
        [0., 0., 0., 1.]
    };
    let norm = orientation
        .iter()
        .map(|v| (*v as f64).powi(2))
        .sum::<f64>()
        .sqrt();
    Value::Numbers(
        position
            .iter()
            .map(|v| *v as f64)
            .chain(orientation.iter().map(|v| *v as f64 / norm))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{self, Message, Request, Schedule, Selection, Session};

    fn request_for(c: &Catalog, group: u32) -> Request {
        Request {
            id: group + 1,
            group,
            delivery: 1,
            schedule: Schedule::OnChange,
            samples: c
                .capabilities
                .descriptors
                .iter()
                .enumerate()
                .filter(|(_, d)| d.group == group)
                .map(|(i, d)| Selection {
                    descriptor: i as u32,
                    format: d.formats[0],
                    space: d.spaces.first().copied().unwrap_or(0),
                })
                .collect(),
        }
    }
    fn input_samples() -> Vec<inputs::Input> {
        inputs::definitions()
            .iter()
            .map(|d| inputs::Input::inactive(d.kind))
            .collect()
    }
    fn source_index(c: &Catalog, id: &str) -> u32 {
        c.capabilities
            .descriptors
            .iter()
            .position(|d| d.id == id)
            .unwrap() as u32
    }
    #[test]
    fn rest_conversion_overflow_rejects_selected_geometry_without_fabricating_identity() {
        let h = Hub::new("test");
        h.initialized.store(true, Ordering::SeqCst);
        h.body_supported.store(true, Ordering::SeqCst);
        let mut body = body::Body::inactive(body::synthetic_skeleton());
        let skeleton = Arc::make_mut(&mut body.skeleton);
        skeleton.joints[1].rest.position = [-f32::MAX, 0., 0.];
        skeleton.joints[2].rest.position = [f32::MAX, 0., 0.];
        assert!(skeleton.valid());
        h.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &input_samples(),
            Some(&body),
            100,
            None,
        );
        let c = Catalog::snapshot(&h);
        let sample = h.latest(Group::Poses).unwrap();
        let root = c.capabilities.skeletons[0][0].rest_pose_sample;
        let child = c.capabilities.skeletons[0][2].rest_pose_sample;
        assert!(
            matches!(c.value(root,&sample),Some(Value::Numbers(v)) if v==[0.,0.,0.,0.,0.,0.,1.])
        );
        assert!(c.value(child, &sample).is_none());
        assert!(
            c.publication(&request_for(&c, Group::Rest as u32), &sample, 100)
                .is_err()
        );
        c.publication(&request_for(&c, 0), &sample, 100).unwrap();
    }
    #[test]
    fn invalid_body_definition_fails_only_selected_body_sources_and_retains_valid_rest() {
        let h = Hub::new("test");
        h.initialized.store(true, Ordering::SeqCst);
        h.body_supported.store(true, Ordering::SeqCst);
        let body = body::Body::inactive(body::synthetic_skeleton());
        h.acquire(
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &input_samples(),
            Some(&body),
            100,
            None,
        );
        let mut c = Catalog::snapshot(&h);
        let mut sample = h.latest(Group::Poses).unwrap();
        let original = c
            .publication(&request_for(&c, Group::Rest as u32), &sample, 100)
            .unwrap();
        Arc::make_mut(&mut sample.body.as_mut().unwrap().skeleton).joints[1].parent = 1;
        c.refresh_skeleton(&h, &sample);
        assert!(
            c.publication(&request_for(&c, Group::Rest as u32), &sample, 100)
                .is_err()
        );
        let head = Request {
            samples: vec![Selection {
                descriptor: 0,
                format: 10,
                space: 2,
            }],
            ..request_for(&c, 0)
        };
        assert!(c.publication(&head, &sample, 100).is_ok());
        sample.body = None;
        c.refresh_skeleton(&h, &sample);
        assert_eq!(
            original,
            c.publication(&request_for(&c, Group::Rest as u32), &sample, 100)
                .unwrap()
        );
    }
    #[test]
    fn full_advertisement_fits_one_message_and_status_ids_are_unique() {
        let h = Hub::new("test");
        h.initialized.store(true, Ordering::SeqCst);
        h.body_supported.store(true, Ordering::SeqCst);
        let mut skeleton = (*body::synthetic_skeleton()).clone();
        // Synthetic finger names are shorter than Quest's OpenXR names. Bound every
        // joint by the longest BodyJointFB name, which is repeated by its descriptors.
        for joint in &mut skeleton.joints {
            joint.name = "RIGHT_HAND_MIDDLE_INTERMEDIATE".into();
        }
        *h.skeleton.lock().unwrap() = Some(Arc::new(skeleton));
        let c = Catalog::snapshot(&h);
        c.capabilities.validate().unwrap();
        let bytes = protocol::encode(&Message::Capabilities(c.capabilities.clone()));
        println!(
            "Full catalog: {} descriptors, {} bytes",
            c.sources.len(),
            bytes.len()
        );
        assert!(
            bytes.len() <= protocol::MAX_SERVER_MESSAGE,
            "{}",
            bytes.len()
        );
        assert_eq!(
            c.sources
                .iter()
                .filter(|s| matches!(s, Source::Input(_, 3)))
                .count(),
            inputs::definitions().len()
        );
        for group in 0..4 {
            c.capabilities
                .validate_request(&request_for(&c, group))
                .unwrap();
        }
    }
    #[test]
    fn inactive_and_invalid_sources_publish_complete_values_without_losing_head_or_counters() {
        let h = Hub::new("test");
        h.initialized.store(true, Ordering::SeqCst);
        let mut poses = std::array::from_fn(|_| Pose::default());
        poses[0] = Pose {
            position: [1., 2., 3.],
            orientation: [0., 0., 0., 1.],
            flags: 15,
            active: None,
        };
        let mut inputs = input_samples();
        let action = inputs::definitions()
            .iter()
            .position(|d| d.source == "left" && d.id == "primary/click")
            .unwrap();
        inputs[action].active = true;
        inputs[action].value = inputs::Value::Boolean {
            value: true,
            presses: 123,
            releases: 122,
        };
        h.acquire(Group::Poses, &poses, &inputs, None, 100, Some(125));
        let c = Catalog::snapshot(&h);
        let request = request_for(&c, 0);
        let mut first = h.latest(Group::Poses).unwrap();
        first.inputs[action].value = inputs::Value::Boolean {
            value: true,
            presses: 123,
            releases: 122,
        };
        let first_bytes = c.publication(&request, &first, 100).unwrap();
        let button = source_index(&c, "/user/hand/left/input/x/click");
        let active = source_index(&c, "/user/hand/left/input/x/click/active");
        let mut sample = first.clone();
        sample.inputs[action].active = false;
        sample.poses[1] = Pose {
            active: Some(false),
            flags: 15,
            position: [f32::NAN; 3],
            orientation: [f32::NAN; 4],
        };
        let bytes = c.publication(&request, &sample, 100).unwrap();
        assert_eq!(
            bytes.len(),
            first_bytes.len(),
            "Activity never changes the layout"
        );
        assert_eq!(
            c.predicted_for(&request, &sample),
            Some(125),
            "The valid selected head still has its real target"
        );
        assert!(matches!(c.value(button, &sample), Some(Value::Bit(false))));
        assert!(matches!(c.value(active, &sample), Some(Value::Bit(false))));
        assert!(matches!(
            c.value(button + 1, &sample),
            Some(Value::Unsigned(123))
        ));
        assert!(matches!(
            c.value(button + 2, &sample),
            Some(Value::Unsigned(122))
        ));
        assert_eq!(pose_flags(&sample.poses[1]), 0);
        assert!(
            matches!(pose_value(&sample.poses[1]),Value::Numbers(v) if v == [0.,0.,0.,0.,0.,0.,1.])
        );
        sample.poses[1].active = Some(true);
        sample.poses[1].position = [4., 5., 6.];
        assert_eq!(pose_flags(&sample.poses[1]), 2 | 8);
        assert!(
            matches!(pose_value(&sample.poses[1]),Value::Numbers(v) if v == [4.,5.,6.,0.,0.,0.,1.])
        );
        for (i, definition) in inputs::definitions().iter().enumerate() {
            if definition.kind == inputs::InputType::Boolean {
                continue;
            }
            sample.inputs[i].active = true;
            sample.inputs[i].value = if definition.kind == inputs::InputType::Scalar {
                inputs::Value::Scalar(f32::NAN)
            } else {
                inputs::Value::Vector2([2., 0.])
            };
            let value = c
                .sources
                .iter()
                .position(|s| matches!(s,Source::Input(index,0) if *index==i))
                .unwrap() as u32;
            let status = c
                .sources
                .iter()
                .position(|s| matches!(s,Source::Input(index,3) if *index==i))
                .unwrap() as u32;
            assert!(matches!(c.value(status, &sample), Some(Value::Bit(false))));
            assert!(
                matches!(c.value(value,&sample),Some(Value::Numbers(v)) if v.iter().all(|v| *v==0.))
            );
        }
        c.publication(&request, &sample, 100).unwrap();
        // Activity itself triggers OnChange only when selected; counters are real, not synthetic releases.
        let mut only_value = request_for(&c, Group::Inputs as u32);
        only_value.samples.retain(|s| s.descriptor == button);
        sample.inputs[action].value = inputs::Value::Boolean {
            value: false,
            presses: 123,
            releases: 122,
        };
        let inactive = c.publication(&only_value, &sample, 100).unwrap();
        sample.inputs[action].active = true;
        assert_eq!(inactive, c.publication(&only_value, &sample, 100).unwrap());
        only_value.samples.push(Selection {
            descriptor: active,
            format: 1,
            space: 0,
        });
        let active_bytes = c.publication(&only_value, &sample, 100).unwrap();
        sample.inputs[action].active = false;
        assert_ne!(
            active_bytes,
            c.publication(&only_value, &sample, 100).unwrap()
        );
    }
    #[test]
    fn body_loss_retains_latest_coherent_definition_and_confidence_validity_is_truthful() {
        let h = Hub::new("test");
        h.initialized.store(true, Ordering::SeqCst);
        h.body_supported.store(true, Ordering::SeqCst);
        let poses = std::array::from_fn(|_| Pose::default());
        let inputs = input_samples();
        let mut body = body::Body::inactive(body::synthetic_skeleton());
        body.active = true;
        h.acquire(Group::Poses, &poses, &inputs, Some(&body), 100, Some(125));
        let mut c = Catalog::snapshot(&h);
        let old = h.latest(Group::Poses).unwrap();
        let confidence = source_index(&c, "/body/FB/confidence");
        let valid = source_index(&c, "/body/FB/confidence/valid");
        let mut sample = old.clone();
        for (confidence_value, usable) in [
            (None, false),
            (Some(0.), true),
            (Some(1.), true),
            (Some(f32::NAN), false),
            (Some(-0.1), false),
        ] {
            sample.body.as_mut().unwrap().confidence = confidence_value;
            assert!(matches!(c.value(valid,&sample),Some(Value::Bit(v)) if v==usable));
            assert!(
                matches!(c.value(confidence,&sample),Some(Value::Numbers(v)) if v[0]==if usable {confidence_value.unwrap() as f64} else {0.})
            );
        }
        sample.body.as_mut().unwrap().active = false;
        assert!(matches!(c.value(valid, &sample), Some(Value::Bit(false))));
        assert_eq!(c.predicted_for(&request_for(&c, 0), &sample), None);
        let rest = request_for(&c, Group::Rest as u32);
        let old_bytes = c.publication(&rest, &old, 100).unwrap();
        let skeleton = Arc::make_mut(&mut body.skeleton);
        skeleton.version += 1;
        skeleton.joints[1].rest.position[0] += 0.1;
        h.acquire(Group::Poses, &poses, &inputs, Some(&body), 101, Some(126));
        // A newer hub definition must not mix with the older copied body's live values/revision.
        c.refresh_skeleton(&h, &old);
        assert_eq!(old_bytes, c.publication(&rest, &old, 100).unwrap());
        let latest = h.latest(Group::Poses).unwrap();
        c.refresh_skeleton(&h, &latest);
        let latest_bytes = c.publication(&rest, &latest, 100).unwrap();
        assert_ne!(old_bytes, latest_bytes);
        h.acquire(Group::Poses, &poses, &inputs, None, 102, None);
        let absent = h.latest(Group::Poses).unwrap();
        c.refresh_skeleton(&h, &absent);
        assert_eq!(latest_bytes, c.publication(&rest, &absent, 100).unwrap());
        c.publication(&request_for(&c, 0), &absent, 102).unwrap();
        assert_eq!(c.predicted_for(&rest, &latest), None);
        assert_eq!(c.predicted_for(&request_for(&c, 0), &absent), None);
        for (i, source) in c.sources.iter().enumerate() {
            if matches!(source, Source::JointFlag(..) | Source::ConfidenceValid) {
                assert!(matches!(
                    c.value(i as u32, &absent),
                    Some(Value::Bit(false))
                ));
            }
        }
        // A catalog that did not observe the update still refreshes from the retained hub definition.
        let mut earlier = Catalog::snapshot(&h);
        earlier.skeleton = old.body.as_ref().map(|b| b.skeleton.clone());
        earlier.refresh_skeleton(&h, &absent);
        assert_eq!(
            latest_bytes,
            earlier.publication(&rest, &absent, 100).unwrap()
        );
    }

    #[test]
    fn prediction_metadata_comes_from_selected_available_live_sources() {
        let hub = Hub::new("test");
        hub.initialized.store(true, Ordering::SeqCst);
        let poses = std::array::from_fn(|_| Pose {
            position: [0.; 3],
            orientation: [0., 0., 0., 1.],
            flags: 3,
            active: Some(true),
        });
        hub.acquire(Group::Poses, &poses, &[], None, 100, Some(25_000_100));
        let catalog = Catalog::snapshot(&hub);
        let sample = hub.latest(Group::Poses).unwrap();
        let mut request = Request {
            id: 1,
            group: 0,
            delivery: 1,
            schedule: Schedule::OnChange,
            samples: vec![Selection {
                descriptor: 0,
                format: 10,
                space: 2,
            }],
        };
        assert_eq!(catalog.predicted_for(&request, &sample), Some(25_000_100));
        let mut inactive = sample.clone();
        inactive.poses[0].active = Some(false);
        assert_eq!(catalog.predicted_for(&request, &inactive), None);
        inactive.poses[0].active = Some(true);
        inactive.poses[0].flags = 0;
        assert_eq!(catalog.predicted_for(&request, &inactive), None);
        request.samples[0] = Selection {
            descriptor: 1,
            format: 1,
            space: 0,
        };
        assert_eq!(catalog.predicted_for(&request, &sample), None);
        let bytes = protocol::tracking(
            &catalog.capabilities,
            &request,
            100,
            None,
            &[catalog.value(1, &sample).unwrap()],
        )
        .unwrap();
        assert_eq!(&bytes[4..12], &100u64.to_le_bytes());
        assert_eq!(&bytes[12..20], &u64::MAX.to_le_bytes());
    }
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
            Group::Poses,
            &std::array::from_fn(|_| Pose::default()),
            &[],
            Some(&body),
            0,
            None,
        );
        let c = Catalog::snapshot(&h);
        let sample = h.latest(Group::Poses).unwrap();
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
    fn reliable_rest_publishes_changes_and_retains_latest_definition_during_body_loss() {
        let h = Hub::new("test");
        h.initialized.store(true, Ordering::SeqCst);
        h.body_supported.store(true, Ordering::SeqCst);
        let poses = std::array::from_fn(|_| Pose::default());
        let mut body = body::Body::inactive(body::synthetic_skeleton());
        h.acquire(Group::Poses, &poses, &[], Some(&body), 0, None);
        let mut c = Catalog::snapshot(&h);
        let mut session = Session::new(c.capabilities.clone());
        session.handle(Message::Offer(vec![1]), 0).unwrap();
        let request = Request {
            id: 1,
            group: Group::Rest as u32,
            delivery: 2,
            schedule: Schedule::OnChange,
            // Unselected native revisions must not trigger an OnChange publication.
            samples: c
                .capabilities
                .descriptors
                .iter()
                .enumerate()
                .filter(|(_, d)| d.group == Group::Rest as u32 && d.kind == 10)
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
        assert!(matches!(
            session.active[&1].request.schedule,
            Schedule::OnChange
        ));
        let mut publish = |session: &mut Session, body: Option<&body::Body>, now| {
            h.acquire(Group::Poses, &poses, &[], body, now, None);
            assert!(!c.changed(&h), "Body activity does not change the catalog");
            let sample = h.latest(Group::Poses).unwrap();
            let sub = session.active.get_mut(&1).unwrap();
            let Some(timestamp) = sub.timestamp(now, now) else {
                return false;
            };
            c.refresh_skeleton(&h, &sample);
            let bytes = c.publication(&sub.request, &sample, timestamp).unwrap();
            if !sub.should_publish(&bytes) {
                return false;
            }
            assert!(
                sub.should_publish(&bytes),
                "Only a successful send commits the snapshot"
            );
            sub.published(&bytes);
            true
        };
        assert!(publish(&mut session, Some(&body), 0));
        for t in 1..=600 {
            assert!(!publish(&mut session, Some(&body), t * 5_000_000));
        }
        // Native revisions are not selected and cannot change the encoded snapshot.
        std::sync::Arc::make_mut(&mut body.skeleton).version += 256;
        assert!(!publish(&mut session, Some(&body), 3_005_000_000));
        assert!(!publish(&mut session, Some(&body), 3_010_000_000));
        std::sync::Arc::make_mut(&mut body.skeleton).joints[1]
            .rest
            .position[0] += 0.1;
        assert!(publish(&mut session, Some(&body), 3_015_000_000));
        assert!(!publish(&mut session, None, 3_020_000_000));
        assert!(!publish(&mut session, None, 3_025_000_000));
        assert!(!publish(&mut session, Some(&body), 3_030_000_000));
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
        assert!(matches!(
            session.active[&1].request.schedule,
            Schedule::OnChange
        ));
        assert!(publish(&mut session, Some(&body), 3_040_000_000));
        assert!(!publish(&mut session, Some(&body), 3_045_000_000));
        assert!(
            !publish(&mut session, Some(&body), 4_040_000_000),
            "Unreliable OnChange does not invent a retry or periodic refresh"
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
        let mut c = Catalog::snapshot(&h);
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
                .filter(|d| d.kind == 10
                    && d.group == Group::Body as u32
                    && d.id.starts_with("/body/"))
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
            let mut c = Catalog::snapshot(&h);
            for x in [1., 0., -1.] {
                h.reset_reference();
                assert!(!c.changed(&h), "Recentering does not change capabilities");
                let poses = std::array::from_fn(|_| Pose {
                    position: [x, 1.6, 0.],
                    orientation: [0., 0., 0., 1.],
                    flags: 3,
                    active: None,
                });
                h.acquire(Group::Poses, &poses, &[], None, h.now(), None);
                let sample = h.latest(Group::Poses).unwrap();
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
        let Value::Numbers(v) = pose_value(&p) else {
            panic!()
        };
        assert!(crate::protocol::valid_numbers(10, 11, &v));
        p.orientation = [0.; 4];
        assert_eq!(pose_flags(&p) & 1, 0);
        assert!(matches!(pose_value(&p), Value::Numbers(v) if v == [1.,2.,3.,0.,0.,0.,1.]));
        p.orientation = [f32::NAN; 4];
        assert_eq!(pose_flags(&p) & 1, 0);
        assert!(matches!(pose_value(&p), Value::Numbers(v) if v == [1.,2.,3.,0.,0.,0.,1.]));
        p.orientation = [0., 0., 0., 1.];
        p.flags = 1;
        let Value::Numbers(values) = pose_value(&p) else {
            panic!("Orientation remains available")
        };
        assert_eq!(&values[..3], &[0., 0., 0.]);
    }
}
