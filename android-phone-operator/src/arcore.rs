//! Single-owner ARCore/EGL worker. No session/GL calls run on the UI thread.
mod ffi;
use crate::{
    phone::{self, Hub},
    spatial::{Frame, Pose, origin_pose},
};
use ffi::*;
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JObject},
};
use std::{
    cell::RefCell,
    ffi::{CStr, c_void},
    ptr::{null, null_mut},
    sync::{Arc, Mutex, OnceLock, mpsc},
    thread::JoinHandle,
    time::Duration,
};

struct RunContext {
    hub: Arc<Hub>,
    stop: mpsc::Receiver<()>,
    result: Option<Result<(), String>>,
}
thread_local! {
    // Already const; Clippy also lints std's Android fallback expansion.
    #[allow(clippy::missing_const_for_thread_local)]
    static RUN: RefCell<Option<RunContext>> = const { RefCell::new(None) };
}

struct Worker {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}
fn slot() -> &'static Mutex<Option<Worker>> {
    static SLOT: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}
pub fn stop() {
    if let Some(w) = slot().lock().unwrap().as_ref() {
        let _ = w.stop.send(());
    }
}
pub fn start(vm: JavaVM, activity: GlobalRef, hub: Arc<Hub>) {
    let mut slot = slot().lock().unwrap();
    let previous = slot.take();
    if let Some(w) = &previous {
        let _ = w.stop.send(());
    }
    let (stop, rx) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        if let Some(w) = previous {
            let _ = w.thread.join();
        }
        if rx.try_recv().is_ok() {
            return;
        }
        let mut env = match vm.attach_current_thread() {
            Ok(env) => env,
            Err(e) => {
                hub.spatial_failure(
                    hub.spatial_context().0,
                    &format!("Worker JNI attach failed: {e}"),
                    phone::now(),
                );
                return;
            }
        };
        RUN.with(|c| {
            c.replace(Some(RunContext {
                hub,
                stop: rx,
                result: None,
            }))
        });
        // Enter through our Java class before calling the SDK: FindClass on a
        // merely attached native thread otherwise uses the system class loader.
        let called = env.call_method(activity.as_obj(), "runArCore", "()V", &[]);
        let context = RUN.with(|c| c.take()).expect("Owned worker context");
        let result = match called {
            Ok(_) => context
                .result
                .unwrap_or_else(|| Err("Missing ARCore worker callback".into())),
            Err(e) => {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
                Err(format!("ARCore worker Java entry failed: {e}"))
            }
        };
        if let Err(e) = result
            && context.stop.try_recv().is_err()
        {
            log::error!("ARCore: {e}");
            context
                .hub
                .spatial_failure(context.hub.spatial_context().0, &e, phone::now());
        }
        drop(activity); // Release global reference while still attached.
    });
    *slot = Some(Worker { stop, thread });
}

struct Egl {
    display: *mut c_void,
    context: *mut c_void,
    surface: *mut c_void,
    texture: u32,
}
impl Egl {
    fn new() -> Result<Self, String> {
        let mut e = Self {
            display: null_mut(),
            context: null_mut(),
            surface: null_mut(),
            texture: 0,
        };
        unsafe {
            e.display = eglGetDisplay(null_mut());
            if e.display.is_null() || eglInitialize(e.display, null_mut(), null_mut()) == 0 {
                return Err("EGL initialization failed".into());
            }
            if eglBindAPI(EGL_OPENGL_ES_API) == 0 {
                return Err("EGL ES API unavailable".into());
            }
            let attrs = [
                EGL_SURFACE_TYPE,
                EGL_PBUFFER_BIT,
                EGL_RENDERABLE_TYPE,
                EGL_OPENGL_ES2_BIT,
                EGL_RED_SIZE,
                8,
                EGL_GREEN_SIZE,
                8,
                EGL_BLUE_SIZE,
                8,
                EGL_NONE,
            ];
            let mut config = null_mut();
            let mut count = 0;
            if eglChooseConfig(e.display, attrs.as_ptr(), &mut config, 1, &mut count) == 0
                || count != 1
            {
                return Err("EGL pbuffer config unavailable".into());
            }
            e.context = eglCreateContext(
                e.display,
                config,
                null_mut(),
                [EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE].as_ptr(),
            );
            e.surface = eglCreatePbufferSurface(
                e.display,
                config,
                [EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE].as_ptr(),
            );
            if e.context.is_null()
                || e.surface.is_null()
                || eglMakeCurrent(e.display, e.surface, e.surface, e.context) == 0
            {
                return Err("EGL offscreen context failed".into());
            }
            glGenTextures(1, &mut e.texture);
            glBindTexture(GL_TEXTURE_EXTERNAL_OES, e.texture);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            if e.texture == 0 || glGetError() != 0 {
                return Err("External OES camera texture failed".into());
            }
        }
        Ok(e)
    }
}
impl Drop for Egl {
    fn drop(&mut self) {
        unsafe {
            if self.display.is_null() {
                return;
            }
            if self.texture != 0 {
                glDeleteTextures(1, &self.texture);
            }
            eglMakeCurrent(self.display, null_mut(), null_mut(), null_mut());
            if !self.surface.is_null() {
                eglDestroySurface(self.display, self.surface);
            }
            if !self.context.is_null() {
                eglDestroyContext(self.display, self.context);
            }
            eglTerminate(self.display);
            eglReleaseThread();
        }
    }
}
struct Session {
    session: *mut ArSession,
    frame: *mut ArFrame,
    pose: *mut ArPose,
    anchor: *mut ArAnchor,
    resumed: bool,
    _egl: Egl,
}
impl Session {
    fn clear_anchor(&mut self) {
        unsafe {
            if !self.anchor.is_null() {
                ArAnchor_detach(self.session, self.anchor);
                ArAnchor_release(self.anchor);
                self.anchor = null_mut();
            }
        }
    }
    fn pose(&self) -> Pose {
        unsafe {
            let mut raw = [0f32; 7];
            ArPose_getPoseRaw(self.session, self.pose, raw.as_mut_ptr());
            Pose {
                orientation: std::array::from_fn(|i| raw[i] as f64),
                position: std::array::from_fn(|i| raw[i + 4] as f64),
            }
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            self.clear_anchor();
            if self.resumed {
                ArSession_pause(self.session);
            }
            if !self.frame.is_null() {
                ArFrame_destroy(self.frame);
            }
            if !self.pose.is_null() {
                ArPose_destroy(self.pose);
            }
            if !self.session.is_null() {
                ArSession_destroy(self.session);
            }
            // EGL remains current until all ARCore objects/session are destroyed.
        }
    }
}
fn check(status: i32, operation: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "{operation}: ARCore status {status}; leave/reopen app to retry"
        ))
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_MainActivity_nativeRunSession(
    mut env: JNIEnv,
    _class: JClass,
    activity: JObject,
) {
    RUN.with(|cell| {
        let Some(mut context) = cell.take() else {
            return;
        };
        context.result = Some(run(&mut env, &activity, &context.hub, &context.stop));
        cell.replace(Some(context));
    });
}
fn run(
    env: &mut JNIEnv,
    activity: &JObject,
    hub: &Hub,
    stop: &mpsc::Receiver<()>,
) -> Result<(), String> {
    let egl = Egl::new()?;
    let mut s = Session {
        session: null_mut(),
        frame: null_mut(),
        pose: null_mut(),
        anchor: null_mut(),
        resumed: false,
        _egl: egl,
    };
    unsafe {
        check(
            ArSession_create(
                env.get_raw().cast(),
                activity.as_raw().cast(),
                &mut s.session,
            ),
            "Create session",
        )?;
        let mut config = null_mut();
        ArConfig_create(s.session, &mut config);
        if config.is_null() {
            return Err("ARCore config allocation failed".into());
        }
        ArConfig_setPlaneFindingMode(s.session, config, 0);
        ArConfig_setLightEstimationMode(s.session, config, 0);
        ArConfig_setDepthMode(s.session, config, 0);
        ArConfig_setInstantPlacementMode(s.session, config, 0);
        ArConfig_setCloudAnchorMode(s.session, config, 0);
        ArConfig_setGeospatialMode(s.session, config, 0);
        ArConfig_setSemanticMode(s.session, config, 0);
        ArConfig_setImageStabilizationMode(s.session, config, 0);
        ArConfig_setUpdateMode(s.session, config, 0); // BLOCKING: new camera frame, bounded SDK wait.
        ArConfig_setTextureUpdateMode(s.session, config, 0); // External OES.
        let status = ArSession_configure(s.session, config);
        ArConfig_destroy(config);
        check(status, "Configure tracking")?;
        ArFrame_create(s.session, &mut s.frame);
        ArPose_create(s.session, null(), &mut s.pose);
        if s.frame.is_null() || s.pose.is_null() {
            return Err("ARCore frame/pose allocation failed".into());
        }
        ArSession_setCameraTextureName(s.session, s._egl.texture);
        ArSession_setDisplayGeometry(s.session, 0, 1, 1); // No display-oriented pose is consumed.
    }
    let mut camera_config = null_mut();
    let mut camera_id = null_mut();
    unsafe {
        ArCameraConfig_create(s.session, &mut camera_config);
        if camera_config.is_null() {
            return Err("ARCore camera config allocation failed".into());
        }
        ArSession_getCameraConfig(s.session, camera_config);
        ArCameraConfig_getCameraId(s.session, camera_config, &mut camera_id);
    }
    let id = if camera_id.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(camera_id).to_string_lossy().into_owned() }
    };
    unsafe {
        if !camera_id.is_null() {
            ArString_release(camera_id);
        }
        ArCameraConfig_destroy(camera_config);
    }
    let j_id = env.new_string(&id).map_err(|e| e.to_string())?;
    // Camera2 static characteristics of the EXACT camera chosen by ARCore.
    let source = env
        .call_method(
            activity,
            "cameraTimestampSource",
            "(Ljava/lang/String;)I",
            &[(&j_id).into()],
        )
        .and_then(|v| v.i())
        .map_err(|e| e.to_string())?;
    let realtime = source == 1;
    log::info!("ARCore SDK 1.57.0 camera_id={id} timestamp_source={source} REALTIME={realtime}");
    if stop.try_recv().is_ok() || !hub.spatial_context().1 {
        return Ok(());
    }
    unsafe {
        check(ArSession_resume(s.session), "Resume camera")?;
    }
    s.resumed = true;
    let mut generation = hub.spatial_context().0;
    let mut frames = 0u64;
    let mut last_observed_timestamp = 0;
    let mut last_tracking = -1;
    loop {
        if stop.try_recv().is_ok() {
            break;
        }
        let (token, active, recenter) = hub.spatial_context();
        if !active {
            break;
        }
        if generation != token {
            s.clear_anchor();
            generation = token;
        }
        let before = phone::now();
        unsafe {
            check(ArSession_update(s.session, s.frame), "Update camera")?;
        }
        let mut timestamp = 0;
        let mut tracking = 2;
        let mut failure = 0;
        let mut camera = null_mut();
        unsafe {
            ArFrame_getTimestamp(s.session, s.frame, &mut timestamp);
            ArFrame_acquireCamera(s.session, s.frame, &mut camera);
            if camera.is_null() {
                return Err("ARCore camera unavailable".into());
            }
            ArCamera_getTrackingState(s.session, camera, &mut tracking);
            ArCamera_getTrackingFailureReason(s.session, camera, &mut failure);
            ArCamera_release(camera);
        }
        let mut metadata = null_mut();
        let metadata_timestamp = unsafe {
            if ArFrame_acquireImageMetadata(s.session, s.frame, &mut metadata) == 0 {
                let mut entry = MetadataEntry::default();
                let result = if ArImageMetadata_getConstEntry(
                    s.session,
                    metadata,
                    ACAMERA_SENSOR_TIMESTAMP,
                    &mut entry,
                ) == 0
                    && entry.kind == 3
                    && entry.count == 1
                    && !entry.data.is_null()
                {
                    Some(*entry.data.cast::<i64>())
                } else {
                    None
                };
                ArImageMetadata_release(metadata);
                result
            } else {
                None
            }
        };
        let mut sensor = Pose::IDENTITY;
        let mut anchor = None;
        let mut created = false;
        if tracking == 0 {
            unsafe {
                ArFrame_getAndroidSensorPose(s.session, s.frame, s.pose);
            }
            sensor = s.pose();
        }
        // Never create an origin from an unverified, stale or duplicated frame.
        let after = phone::now();
        if tracking == 0
            && recenter
            && s.anchor.is_null()
            && timestamp > last_observed_timestamp
            && realtime
            && timestamp > 0
            && metadata_timestamp == Some(timestamp)
            && (timestamp as u64) <= after
            && after - (timestamp as u64) <= phone::STALE_NS
        {
            if let Some(origin) = origin_pose(sensor) {
                let raw: [f32; 7] = std::array::from_fn(|i| {
                    if i < 4 {
                        origin.orientation[i] as f32
                    } else {
                        origin.position[i - 4] as f32
                    }
                });
                let mut pose = null_mut();
                let status = unsafe {
                    ArPose_create(s.session, raw.as_ptr(), &mut pose);
                    let status = ArSession_acquireNewAnchor(s.session, pose, &mut s.anchor);
                    ArPose_destroy(pose);
                    status
                };
                if status != 0 {
                    hub.spatial_failure(
                        token,
                        &format!("Origin anchor creation failed ({status}); recenter again"),
                        after,
                    );
                    continue;
                }
                created = true;
            } else {
                hub.spatial_failure(
                    token,
                    "Recenter needs a finite, nonvertical rear-camera heading",
                    after,
                );
                continue;
            }
        }
        if !s.anchor.is_null() {
            unsafe {
                let mut state = 2;
                ArAnchor_getTrackingState(s.session, s.anchor, &mut state);
                if state == 0 {
                    ArAnchor_getPose(s.session, s.anchor, s.pose);
                    anchor = Some(s.pose());
                }
            }
        }
        let end = phone::now();
        if frames.is_multiple_of(120) || tracking != last_tracking {
            log::info!(
                "AR frame={timestamp} metadata={metadata_timestamp:?} query={before}..{end} camera_state={tracking} failure={failure} anchor={} generation={token}",
                anchor.is_some()
            );
        }
        frames += 1;
        last_tracking = tracking;
        last_observed_timestamp = last_observed_timestamp.max(timestamp);
        hub.spatial_frame(Frame {
            generation: token,
            timestamp,
            metadata_timestamp,
            realtime,
            query_started: before,
            query_finished: end,
            tracking: tracking == 0,
            sensor,
            anchor,
            created_origin: created,
        });
        // Wake promptly on lifecycle stop. Polling never manufactures camera frames.
        if stop.recv_timeout(Duration::from_millis(8)).is_ok() {
            break;
        }
    }
    Ok(())
}

/// Availability/install UI is deliberately called only on Android's UI thread.
pub fn prepare(env: *mut c_void, activity: *mut c_void, requested: bool) -> i32 {
    unsafe {
        let mut availability = 0;
        ArCoreApk_checkAvailability(env, activity, &mut availability);
        if availability == 1 {
            return 2;
        }
        if availability == 2 {
            return -2002;
        } // Timed out: explicit UI retry.
        if availability == 100 {
            return -100;
        }
        let mut installed = 1;
        let result = ArCoreApk_requestInstall(env, activity, i32::from(requested), &mut installed);
        if result != 0 { result } else { installed }
    }
}
