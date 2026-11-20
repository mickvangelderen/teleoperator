//! The activity owns cancellation. All camera calls, including potentially slow
//! session destruction, run under one process-wide lock on background threads.
use crate::{
    phone::{self, Hub},
    spatial::{
        Acquisition, AnchorRecovery, CameraProgress, ClockGate, Frame, FrameAnchor, Pose,
        resumed_origin,
    },
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
    sync::{Arc, Mutex, Weak},
    thread,
};

static CAMERA: Mutex<()> = Mutex::new(());

struct State {
    stopped: bool,
    clients: Weak<()>,
    failure: Option<Failure>,
}

impl State {
    fn stopped(&self) -> bool {
        self.stopped || self.clients.strong_count() == 0
    }
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
    pub(super) fn start(
        vm: JavaVM,
        context: GlobalRef,
        hub: Arc<Hub>,
        mode: TrackingMode,
        clients: Weak<()>,
    ) -> Self {
        let state = Arc::new(Mutex::new(State {
            stopped: false,
            clients,
            failure: None,
        }));
        let worker = state.clone();
        let spawned = thread::Builder::new()
            .name("ARCore camera".into())
            .spawn(move || {
                let _camera = CAMERA.lock().unwrap();
                if worker.lock().unwrap().stopped() {
                    return;
                }
                let result = run(&vm, &context, &hub, &worker, mode);
                if let Err(error) = result {
                    let mut state = worker.lock().unwrap();
                    if !state.stopped() {
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
                        let interrupted = error.downcast_ref::<CameraInterrupted>().is_some();
                        state.failure = Some(Failure {
                            message: if busy {
                                "Camera unavailable".into()
                            } else {
                                error.to_string()
                            },
                            transient: busy || setup_changed || interrupted,
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
    let mut prefer_small_preview = true;
    let mut session = loop {
        if worker.lock().unwrap().stopped() {
            return Ok(());
        }
        let mut session = Session::new(&mut env, context.as_obj())?;
        let changed = if prefer_small_preview {
            match session.prefer_small_preview() {
                Ok(changed) => changed,
                Err(error) => {
                    log::warn!("Could not select a smaller camera preview: {error}");
                    prefer_small_preview = false;
                    continue;
                }
            }
        } else {
            false
        };
        let configured = configure_camera(&mut session, &mut env, context.as_obj());
        if worker.lock().unwrap().stopped() {
            return Ok(());
        }
        match configured.and_then(|()| Ok(session.resume()?)) {
            Ok(()) => break session,
            Err(error) if changed => {
                log::warn!(
                    "Smaller preview failed to start, trying the default camera config: {error}"
                );
                prefer_small_preview = false;
            }
            Err(error) => return Err(error),
        }
    };
    {
        // Do not disturb the fallback's origin while an unavailable camera is
        // being retried. A retired worker must never switch the active source.
        let state = worker.lock().unwrap();
        if state.stopped() || !hub.start_camera_mode(mode, phone::now(), &state.clients) {
            return Ok(());
        }
    }
    let tracking = track(&mut session, hub, worker);
    let paused = session.pause();
    // Once setup succeeded, a failed update can be retried with a new session.
    tracking.map_err(|e| CameraInterrupted(e.to_string()))?;
    paused?;
    Ok(())
}

fn configure_camera(
    session: &mut Session,
    env: &mut JNIEnv<'_>,
    context: &JObject<'_>,
) -> Result<(), Box<dyn Error>> {
    let mut config = session.config()?;
    config.set_plane_finding_mode(PlaneFindingMode::Disabled);
    config.set_light_estimation_mode(LightEstimationMode::Disabled);
    config.set_texture_update_mode(TextureUpdateMode::ExposeHardwareBuffer);
    config.apply()?;
    let camera_id = session.camera_id()?;
    match realtime_camera(env, context, &camera_id) {
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
struct CameraInterrupted(String);
impl std::fmt::Display for CameraInterrupted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl Error for CameraInterrupted {}

fn track(session: &mut Session, hub: &Hub, worker: &Mutex<State>) -> Result<(), Box<dyn Error>> {
    let mut anchor: Option<Anchor> = None;
    let mut anchor_generation = None;
    let mut recovery = AnchorRecovery::default();
    let mut clock = ClockGate::default();
    let mut progress = CameraProgress::default();
    while !worker.lock().unwrap().stopped() {
        let context = hub.spatial_context();
        let generation = context.generation;
        if !context.active {
            break;
        }
        if anchor_generation != Some(generation) {
            anchor = None;
            recovery = AnchorRecovery::default();
            anchor_generation = Some(generation);
        }

        let query_started = phone::now();
        let frame = session.update()?;
        let timestamp = frame.timestamp_ns();
        let metadata_timestamp = frame.android_camera_timestamp_ns()?;
        let (camera_state, reason) = frame.tracking_status()?;
        let tracking = camera_state == TrackingState::Tracking;
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
        let capture = match clock.observe(&sample) {
            Ok(Acquisition::New(at)) => Some(at),
            _ => None,
        };
        // A running session may keep returning cached/unusable frames or report
        // a camera fault without transitioning to STOPPED. Restart only those
        // sessions; give environmental tracking loss time to relocalize.
        let camera_fault = matches!(
            reason as u32,
            arcore_sys::AR_TRACKING_FAILURE_REASON_BAD_STATE
                | arcore_sys::AR_TRACKING_FAILURE_REASON_CAMERA_UNAVAILABLE
        );
        if progress.needs_restart(&sample, capture.is_some(), camera_fault) {
            return Err("Camera frames stopped progressing".into());
        }
        let previous = anchor.as_ref().map(|a| a.tracking_state());
        sample.anchor = match (&anchor, previous) {
            (Some(a), Some(TrackingState::Tracking)) => FrameAnchor::Tracking(phone_pose(a.pose())),
            (_, Some(TrackingState::Paused | TrackingState::Unknown(_))) => FrameAnchor::Paused,
            _ => FrameAnchor::Missing,
        };
        let replace = recovery.needs_replacement(sample.anchor, capture.filter(|_| tracking));
        if replace || previous == Some(TrackingState::Stopped) {
            // Report the reference boundary (and release any hold) before using a replacement.
            anchor = None;
            sample.anchor = FrameAnchor::Missing;
        } else if anchor.is_none()
            && tracking
            && let (Some(since), Some(at)) = (context.origin_since, capture)
            && at >= since
            && let Some(origin) = resumed_origin(sensor, context.last_grip)
        {
            match session.create_anchor(arcore::Pose {
                translation: origin.position.map(|v| v as f32),
                rotation: origin.orientation.map(|v| v as f32),
            }) {
                Ok(new_anchor) => {
                    sample.anchor = match new_anchor.tracking_state() {
                        TrackingState::Tracking => {
                            FrameAnchor::Tracking(phone_pose(new_anchor.pose()))
                        }
                        _ => FrameAnchor::Paused,
                    };
                    anchor = Some(new_anchor);
                }
                // The SDK can lose tracking between update and acquisition.
                Err(arcore::Error::Status(
                    _,
                    arcore_sys::AR_ERROR_NOT_TRACKING | arcore_sys::AR_ERROR_RESOURCE_EXHAUSTED,
                )) => {}
                Err(error) => return Err(error.into()),
            }
        }
        let state = worker.lock().unwrap();
        if state.stopped() {
            break;
        }
        sample.query_finished = phone::now();
        hub.spatial_frame(sample);
        if camera_state == TrackingState::Stopped {
            return Err("ARCore stopped tracking".into());
        }
    }
    Ok(())
}
