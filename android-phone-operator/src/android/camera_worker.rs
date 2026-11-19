//! The activity owns cancellation. All camera calls, including potentially slow
//! session destruction, run under one process-wide lock on background threads.
use crate::{
    phone::{self, Hub},
    spatial::{self, Acquisition, ClockGate, Frame, FrameAnchor, Pose},
    tracking::TrackingMode,
};
use arcore::{
    Anchor, LightEstimationMode, PlaneFindingMode, Session, TextureUpdateMode, TrackingState,
};
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JObject},
};
use std::{
    error::Error,
    sync::{Arc, Mutex},
    thread,
};

static CAMERA: Mutex<()> = Mutex::new(());

#[derive(Default)]
struct State {
    stopped: bool,
    failure: Option<Failure>,
}

#[derive(Clone)]
pub(super) struct Failure {
    pub message: String,
    pub transient: bool,
}
pub(super) struct CameraWorker {
    state: Arc<Mutex<State>>,
}

impl CameraWorker {
    pub(super) fn start(vm: JavaVM, context: GlobalRef, hub: Arc<Hub>, mode: TrackingMode) -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let worker = state.clone();
        let spawned = thread::Builder::new()
            .name("ARCore camera".into())
            .spawn(move || {
                let _camera = CAMERA.lock().unwrap();
                if worker.lock().unwrap().stopped {
                    return;
                }
                let result = run(&vm, &context, &hub, &worker, mode);
                if let Err(error) = result {
                    let mut state = worker.lock().unwrap();
                    if !state.stopped {
                        log::warn!("ARCore camera failed: {error}");
                        let busy = matches!(
                            error.downcast_ref::<arcore::Error>(),
                            Some(arcore::Error::Status(
                                _,
                                arcore_sys::AR_ERROR_CAMERA_NOT_AVAILABLE
                            ))
                        );
                        let setup_changed = matches!(
                            error.downcast_ref::<arcore::Error>(),
                            Some(arcore::Error::Status(
                                _,
                                arcore_sys::AR_ERROR_CAMERA_PERMISSION_NOT_GRANTED
                                    | arcore_sys::AR_UNAVAILABLE_ARCORE_NOT_INSTALLED
                                    | arcore_sys::AR_UNAVAILABLE_APK_TOO_OLD
                            ))
                        );
                        let stopped = error.downcast_ref::<CameraStopped>().is_some();
                        state.failure = Some(Failure {
                            message: if busy {
                                "Camera unavailable".into()
                            } else {
                                error.to_string()
                            },
                            transient: busy || setup_changed || stopped,
                        });
                    }
                }
            });
        if let Err(error) = spawned {
            state.lock().unwrap().failure = Some(Failure {
                message: format!("Could not start camera worker: {error}"),
                transient: true,
            });
        }
        Self { state }
    }

    pub(super) fn failure(&self) -> Option<Failure> {
        self.state.lock().unwrap().failure.clone()
    }
}

impl Drop for CameraWorker {
    fn drop(&mut self) {
        // Synchronize only with publication. Once this returns the old worker
        // cannot publish into the next mode or activity, even during teardown.
        self.state.lock().unwrap().stopped = true;
    }
}

fn run(
    vm: &JavaVM,
    context: &GlobalRef,
    hub: &Hub,
    worker: &Mutex<State>,
    mode: TrackingMode,
) -> Result<(), Box<dyn Error>> {
    let mut env = vm.attach_current_thread_as_daemon()?;
    let mut session = Session::new(&mut env, context.as_obj())?;
    let mut config = session.config()?;
    config.set_plane_finding_mode(PlaneFindingMode::Disabled);
    config.set_light_estimation_mode(LightEstimationMode::Disabled);
    config.set_texture_update_mode(TextureUpdateMode::ExposeHardwareBuffer);
    config.apply()?;
    let camera_id = session.camera_id()?;
    match realtime_camera(&mut env, context.as_obj(), &camera_id) {
        Ok(true) => {}
        Ok(false) => {
            return Err(format!(
                "Camera {camera_id} timestamps cannot be aligned with phone sensors"
            )
            .into());
        }
        Err(error) => {
            // A framework exception belongs to this attached worker. Clear it
            // before ARCore calls back into the VM during session destruction.
            if env.exception_check()? {
                env.exception_describe()?;
                env.exception_clear()?;
            }
            return Err(
                format!("Could not read timestamp source for camera {camera_id}: {error}").into(),
            );
        }
    }
    if worker.lock().unwrap().stopped {
        return Ok(());
    }
    session.resume()?;
    {
        // Do not disturb the fallback's origin while an unavailable camera is
        // being retried. A retired worker must never switch the active source.
        let state = worker.lock().unwrap();
        if state.stopped {
            return Ok(());
        }
        hub.set_tracking_mode(mode, phone::now());
    }
    track(&mut session, hub, worker)?;
    session.pause()?;
    Ok(())
}

/// Read Camera2's static characteristic for the exact camera selected by ARCore.
fn realtime_camera(
    env: &mut JNIEnv<'_>,
    context: &JObject<'_>,
    id: &str,
) -> jni::errors::Result<bool> {
    let service = env.new_string("camera")?;
    let manager = env
        .call_method(
            context,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[(&service).into()],
        )?
        .l()?;
    let id = env.new_string(id)?;
    let characteristics = env
        .call_method(
            manager,
            "getCameraCharacteristics",
            "(Ljava/lang/String;)Landroid/hardware/camera2/CameraCharacteristics;",
            &[(&id).into()],
        )?
        .l()?;
    let class = env.find_class("android/hardware/camera2/CameraCharacteristics")?;
    let key = env
        .get_static_field(
            &class,
            "SENSOR_INFO_TIMESTAMP_SOURCE",
            "Landroid/hardware/camera2/CameraCharacteristics$Key;",
        )?
        .l()?;
    let source = env
        .call_method(
            characteristics,
            "get",
            "(Landroid/hardware/camera2/CameraCharacteristics$Key;)Ljava/lang/Object;",
            &[(&key).into()],
        )?
        .l()?;
    if source.is_null() {
        return Ok(false);
    }
    let value = env.call_method(source, "intValue", "()I", &[])?.i()?;
    Ok(value
        == env
            .get_static_field(class, "SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME", "I")?
            .i()?)
}

fn phone_pose(pose: arcore::Pose) -> Pose {
    Pose {
        position: pose.translation.map(f64::from),
        orientation: pose.rotation.map(f64::from),
    }
}

#[derive(Debug)]
struct CameraStopped;
impl std::fmt::Display for CameraStopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ARCore stopped tracking")
    }
}
impl Error for CameraStopped {}

fn track(session: &mut Session, hub: &Hub, worker: &Mutex<State>) -> Result<(), Box<dyn Error>> {
    let mut anchor: Option<Anchor> = None;
    let mut anchor_generation = None;
    let mut clock = ClockGate::default();
    let mut missing_metadata_since = None;
    while !worker.lock().unwrap().stopped {
        let (generation, active, origin_since) = hub.spatial_context();
        if !active {
            break;
        }
        if anchor_generation != Some(generation) {
            anchor = None;
            anchor_generation = Some(generation);
        }

        let query_started = phone::now();
        let frame = session.update()?;
        let timestamp = frame.timestamp_ns();
        let metadata_timestamp = frame.android_camera_timestamp_ns()?;
        let (camera_state, reason) = frame.tracking_status()?;
        let tracking = camera_state == TrackingState::Tracking;
        // Some camera implementations omit SENSOR_TIMESTAMP despite reporting a
        // REALTIME clock. Allow startup, then release the unusable camera.
        if tracking && metadata_timestamp.is_none_or(|t| t <= 0) {
            let since = *missing_metadata_since.get_or_insert(query_started);
            if query_started - since >= 5_000_000_000 {
                return Err("Camera capture timestamps unavailable".into());
            }
        } else {
            missing_metadata_since = None;
        }
        let sensor = if tracking {
            phone_pose(frame.android_sensor_pose())
        } else {
            Pose::IDENTITY
        };
        let mut sample = Frame {
            generation,
            timestamp,
            metadata_timestamp,
            realtime: true,
            query_started,
            query_finished: phone::now(),
            tracking: if tracking {
                Ok(())
            } else {
                Err(match reason as u32 {
                    arcore_sys::AR_TRACKING_FAILURE_REASON_INSUFFICIENT_LIGHT => {
                        "ARCore needs more light"
                    }
                    arcore_sys::AR_TRACKING_FAILURE_REASON_EXCESSIVE_MOTION => {
                        "ARCore needs slower movement"
                    }
                    arcore_sys::AR_TRACKING_FAILURE_REASON_INSUFFICIENT_FEATURES => {
                        "Point the camera at a textured surface"
                    }
                    arcore_sys::AR_TRACKING_FAILURE_REASON_CAMERA_UNAVAILABLE => {
                        "ARCore camera in use"
                    }
                    arcore_sys::AR_TRACKING_FAILURE_REASON_BAD_STATE => "ARCore lost tracking",
                    _ => "Waiting for ARCore camera tracking",
                })
            },
            sensor,
            anchor: FrameAnchor::Missing,
        };
        let acquisition = clock.observe(&sample);
        // A paused anchor can relocalize in the same reference. STOPPED is
        // terminal. Report that loss before creating a new local reference.
        if anchor
            .as_ref()
            .is_some_and(|a| a.tracking_state() == TrackingState::Stopped)
        {
            anchor = None;
        } else if anchor.is_none()
            && tracking
            && let (Some(since), Ok(Acquisition::New(at))) = (origin_since, acquisition)
            && at >= since
            && let Some(origin) = spatial::origin_pose(sensor)
        {
            match session.create_anchor(arcore::Pose {
                translation: origin.position.map(|v| v as f32),
                rotation: origin.orientation.map(|v| v as f32),
            }) {
                Ok(new_anchor) => anchor = Some(new_anchor),
                // The SDK can lose tracking between update and acquisition.
                Err(arcore::Error::Status(
                    _,
                    arcore_sys::AR_ERROR_NOT_TRACKING | arcore_sys::AR_ERROR_RESOURCE_EXHAUSTED,
                )) => {}
                Err(error) => return Err(error.into()),
            }
        }
        if let Some(anchor) = &anchor {
            sample.anchor = match anchor.tracking_state() {
                TrackingState::Tracking => FrameAnchor::Tracking(phone_pose(anchor.pose())),
                _ => FrameAnchor::Paused,
            };
        }

        let state = worker.lock().unwrap();
        if state.stopped {
            break;
        }
        sample.query_finished = phone::now();
        hub.spatial_frame(sample);
        if camera_state == TrackingState::Stopped {
            return Err(CameraStopped.into());
        }
    }
    Ok(())
}
