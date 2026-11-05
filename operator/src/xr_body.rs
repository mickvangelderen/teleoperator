use crate::{
    body::{Body, JOINT_COUNT, Joint, Skeleton},
    protocol::wire,
    tracking::{Hub, Pose},
};
use android_activity::AndroidApp;
use jni::{
    JavaVM,
    objects::{JObject, JValue},
};
use openxr::{
    self as xr,
    sys::{self, Handle},
};
use std::{
    ptr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub fn poll_permission(app: &AndroidApp, granted: Arc<AtomicBool>, request: bool) {
    let activity_app = app.clone();
    app.run_on_java_main_thread(Box::new(move || {
        let result = (|| -> jni::errors::Result<()> {
            let vm = unsafe { JavaVM::from_raw(activity_app.vm_as_ptr().cast()) }?;
            let mut env = vm.attach_current_thread()?;
            let result = env.with_local_frame(16, |env| -> jni::errors::Result<()> {
                // AndroidApp owns this global reference; borrowing it does not delete it.
                let activity = unsafe { JObject::from_raw(activity_app.activity_as_ptr().cast()) };
                let name = env.new_string("com.oculus.permission.BODY_TRACKING")?;
                let allowed = env
                    .call_method(
                        &activity,
                        "checkSelfPermission",
                        "(Ljava/lang/String;)I",
                        &[JValue::Object(&name)],
                    )?
                    .i()?
                    == 0;
                granted.store(allowed, Ordering::SeqCst);
                if request && !allowed {
                    let permissions =
                        env.new_object_array(1, "java/lang/String", JObject::null())?;
                    env.set_object_array_element(&permissions, 0, &name)?;
                    env.call_method(
                        &activity,
                        "requestPermissions",
                        "([Ljava/lang/String;I)V",
                        &[JValue::Object(&permissions), JValue::Int(41)],
                    )?;
                }
                Ok(())
            });
            if env.exception_check()? {
                env.exception_describe()?;
                env.exception_clear()?;
            }
            result
        })();
        if let Err(error) = result {
            granted.store(false, Ordering::SeqCst);
            log::warn!("Body tracking permission: {error}");
        }
    }));
}

pub struct Tracker {
    session: xr::Session<xr::OpenGlEs>,
    handle: sys::BodyTrackerFB,
    skeleton: Option<Arc<Skeleton>>,
    changed: u32,
    fidelity: bool,
    calibration: bool,
}
impl Tracker {
    pub fn new(
        session: &xr::Session<xr::OpenGlEs>,
        fidelity: bool,
        calibration: bool,
    ) -> xr::Result<Self> {
        let api = session
            .instance()
            .exts()
            .fb_body_tracking
            .as_ref()
            .ok_or(sys::Result::ERROR_FEATURE_UNSUPPORTED)?;
        let mut handle = sys::BodyTrackerFB::NULL;
        let result = unsafe {
            (api.create_body_tracker)(
                session.as_raw(),
                &sys::BodyTrackerCreateInfoFB {
                    ty: sys::BodyTrackerCreateInfoFB::TYPE,
                    next: ptr::null(),
                    body_joint_set: sys::BodyJointSetFB::DEFAULT,
                },
                &mut handle,
            )
        };
        if result.into_raw() < 0 {
            return Err(result);
        }
        Ok(Self {
            session: session.clone(),
            handle,
            skeleton: None,
            changed: 0,
            fidelity,
            calibration,
        })
    }
    pub fn sample(&mut self, local: &xr::Space, time: xr::Time, hub: &Hub) -> xr::Result<Body> {
        let api = self
            .session
            .instance()
            .exts()
            .fb_body_tracking
            .as_ref()
            .unwrap();
        let mut joints = vec![sys::BodyJointLocationFB::default(); JOINT_COUNT];
        let mut calibration = sys::BodyTrackingCalibrationStatusMETA {
            ty: sys::BodyTrackingCalibrationStatusMETA::TYPE,
            next: ptr::null_mut(),
            status: sys::BodyTrackingCalibrationStateMETA::INVALID,
        };
        let mut fidelity = sys::BodyTrackingFidelityStatusMETA {
            ty: sys::BodyTrackingFidelityStatusMETA::TYPE,
            next: if self.calibration {
                (&mut calibration as *mut sys::BodyTrackingCalibrationStatusMETA).cast()
            } else {
                ptr::null_mut()
            },
            fidelity: sys::BodyTrackingFidelityMETA::LOW,
        };
        let next = if self.fidelity {
            (&mut fidelity as *mut sys::BodyTrackingFidelityStatusMETA).cast()
        } else if self.calibration {
            (&mut calibration as *mut sys::BodyTrackingCalibrationStatusMETA).cast()
        } else {
            ptr::null_mut()
        };
        let mut locations = sys::BodyJointLocationsFB {
            ty: sys::BodyJointLocationsFB::TYPE,
            next,
            is_active: false.into(),
            confidence: 0.,
            joint_count: JOINT_COUNT as u32,
            joint_locations: joints.as_mut_ptr(),
            skeleton_changed_count: 0,
            time,
        };
        let result = unsafe {
            (api.locate_body_joints)(
                self.handle,
                &sys::BodyJointsLocateInfoFB {
                    ty: sys::BodyJointsLocateInfoFB::TYPE,
                    next: ptr::null(),
                    base_space: local.as_raw(),
                    time,
                },
                &mut locations,
            )
        };
        if result.into_raw() < 0 {
            return Err(result);
        }
        let reference_version = *hub.reference_version.lock().unwrap();
        if self
            .skeleton
            .as_ref()
            .is_none_or(|s| s.reference_version != reference_version)
            || self.changed != locations.skeleton_changed_count
        {
            let mut joints = vec![sys::BodySkeletonJointFB::default(); JOINT_COUNT];
            let result = unsafe {
                (api.get_body_skeleton)(
                    self.handle,
                    &mut sys::BodySkeletonFB {
                        ty: sys::BodySkeletonFB::TYPE,
                        next: ptr::null_mut(),
                        joint_count: JOINT_COUNT as u32,
                        joints: joints.as_mut_ptr(),
                    },
                )
            };
            if result.into_raw() < 0 {
                return Err(result);
            }
            let skeleton = Skeleton {
                version: hub.next_skeleton_version(),
                reference_version,
                joints: joints
                    .iter()
                    .map(|j| Joint {
                        id: j.joint as u32,
                        parent: j.parent_joint,
                        name: format!("{:?}", sys::BodyJointFB::from_raw(j.joint)),
                        rest: pose(j.pose, 15),
                    })
                    .collect(),
            };
            if !skeleton.valid() {
                return Err(sys::Result::ERROR_VALIDATION_FAILURE);
            }
            self.skeleton = Some(Arc::new(skeleton));
            self.changed = locations.skeleton_changed_count;
        }
        let active = bool::from(locations.is_active);
        let confidence = (active
            && locations.confidence.is_finite()
            && (0.0..=1.0).contains(&locations.confidence))
        .then_some(locations.confidence);
        Ok(Body {
            skeleton: self.skeleton.as_ref().unwrap().clone(),
            active,
            confidence,
            returned_at: None,
            fidelity: if self.fidelity {
                match fidelity.fidelity {
                    sys::BodyTrackingFidelityMETA::HIGH => Some(wire::Fidelity::High),
                    sys::BodyTrackingFidelityMETA::LOW => Some(wire::Fidelity::Low),
                    _ => None,
                }
            } else {
                None
            },
            calibration: self.calibration.then_some(match calibration.status {
                sys::BodyTrackingCalibrationStateMETA::VALID => wire::CalibrationStatus::Valid,
                sys::BodyTrackingCalibrationStateMETA::CALIBRATING => {
                    wire::CalibrationStatus::Calibrating
                }
                sys::BodyTrackingCalibrationStateMETA::INVALID => wire::CalibrationStatus::Invalid,
                _ => wire::CalibrationStatus::Unknown,
            }),
            joints: joints
                .iter()
                .map(|j| {
                    pose(
                        j.pose,
                        if active {
                            j.location_flags.into_raw() as u16
                        } else {
                            0
                        },
                    )
                })
                .collect(),
        })
    }
}
fn pose(p: xr::Posef, flags: u16) -> Pose {
    Pose {
        position: [p.position.x, p.position.y, p.position.z],
        orientation: [
            p.orientation.x,
            p.orientation.y,
            p.orientation.z,
            p.orientation.w,
        ],
        flags,
        active: None,
    }
}
impl Drop for Tracker {
    fn drop(&mut self) {
        unsafe {
            (self
                .session
                .instance()
                .exts()
                .fb_body_tracking
                .as_ref()
                .unwrap()
                .destroy_body_tracker)(self.handle);
        }
    }
}
