//! UI-thread install/permission flow. Only the worker owns a camera session.
use super::camera_worker::CameraWorker;
use crate::phone::{self, Hub, TrackingMode};
use arcore_sys as ar;
use jni::{
    JNIEnv,
    errors::Result,
    objects::{GlobalRef, JObject},
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) struct Tracking {
    pub source: i32,
    pub message: String,
    pub retry_visible: bool,
    pub asked_permission: bool,
    pub asked_install: bool,
    install_enabled: bool,
    failed: bool,
    next_check: Option<Instant>,
    worker: Option<CameraWorker>,
    has_rotation: bool,
    hub: Arc<Hub>,
}

impl Tracking {
    pub fn new(source: i32, mask: i32, flags: u8, hub: Arc<Hub>) -> Self {
        Self {
            source,
            has_rotation: mask & 1 != 0,
            hub,
            message: Self::sensor_source(source).1.into(),
            retry_visible: false,
            asked_permission: flags & 1 != 0,
            asked_install: flags & 2 != 0,
            worker: None,
            install_enabled: false,
            failed: false,
            next_check: None,
        }
    }
    fn sensor_source(source: i32) -> (TrackingMode, &'static str) {
        if source == 2 {
            (
                TrackingMode::Displacement,
                "Using estimated IMU displacement",
            )
        } else {
            (TrackingMode::Orientation, "Using phone orientation")
        }
    }
    pub fn resume(&mut self) {
        let (mode, _) = Self::sensor_source(self.source);
        self.hub
            .set_tracking_mode(mode, self.has_rotation, phone::now());
        self.check_soon();
    }
    fn sensors(&mut self) {
        let (mode, message) = Self::sensor_source(self.source);
        self.hub
            .set_tracking_mode(mode, self.has_rotation, phone::now());
        self.message = message.into();
        self.retry_visible = false;
    }
    pub fn select(&mut self, source: i32) {
        self.worker.take();
        self.hub.action(phone::Action::Cancel, phone::now());
        self.failed = false;
        self.source = source;
        self.sensors();
        self.check_soon();
    }
    pub fn stop(&mut self) {
        self.next_check = None;
        if self.worker.take().is_some() {
            self.sensors();
        }
    }
    pub fn check_soon(&mut self) {
        if !self.failed && self.source == 0 {
            self.next_check = Some(Instant::now());
        }
    }
    fn fallback(&mut self, reason: &str, retry: bool) {
        self.stop();
        self.message = format!("Using phone orientation · {reason}");
        self.retry_visible = retry;
    }
    pub fn retry(&mut self, env: &mut JNIEnv, activity: &JObject) -> Result<()> {
        let permission = env.new_string("android.permission.CAMERA")?;
        if self.asked_permission
            && env
                .call_method(
                    activity,
                    "checkSelfPermission",
                    "(Ljava/lang/String;)I",
                    &[(&permission).into()],
                )?
                .i()?
                != 0
            && !env
                .call_method(
                    activity,
                    "shouldShowRequestPermissionRationale",
                    "(Ljava/lang/String;)Z",
                    &[(&permission).into()],
                )?
                .z()?
        {
            let pkg = env
                .call_method(activity, "getPackageName", "()Ljava/lang/String;", &[])?
                .l()?;
            let scheme = env.new_string("package")?;
            let uri = env
                .call_static_method(
                    "android/net/Uri",
                    "fromParts",
                    "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri;",
                    &[(&scheme).into(), (&pkg).into(), (&JObject::null()).into()],
                )?
                .l()?;
            let action = env.new_string("android.settings.APPLICATION_DETAILS_SETTINGS")?;
            let intent = env.new_object(
                "android/content/Intent",
                "(Ljava/lang/String;Landroid/net/Uri;)V",
                &[(&action).into(), (&uri).into()],
            )?;
            env.call_method(
                activity,
                "startActivity",
                "(Landroid/content/Intent;)V",
                &[(&intent).into()],
            )?;
        } else {
            self.asked_permission = false;
            self.asked_install = false;
            self.failed = false;
            self.install_enabled = true;
            self.check_soon();
        }
        Ok(())
    }
    pub fn update(&mut self, env: &mut JNIEnv, activity: &GlobalRef) -> Result<()> {
        if let Some(reason) = self.worker.as_ref().and_then(CameraWorker::failure) {
            self.failed = true;
            self.fallback(&reason, true);
        } else if self.next_check.is_some_and(|at| at <= Instant::now()) {
            self.next_check = None;
            self.try_camera(env, activity.as_obj())?;
        }
        Ok(())
    }
    fn try_camera(&mut self, env: &mut JNIEnv, activity: &JObject) -> Result<()> {
        if self.source != 0 || self.worker.is_some() {
            return Ok(());
        }
        let mut availability = 0;
        // The native SDK borrows this thread's JNIEnv and the live Activity only for these calls.
        unsafe {
            ar::ArCoreApk_checkAvailability(
                env.get_raw().cast(),
                activity.as_raw().cast(),
                &mut availability,
            )
        };
        match availability as u32 {
            ar::AR_AVAILABILITY_UNKNOWN_CHECKING => {
                self.next_check = Some(Instant::now() + Duration::from_millis(500));
                return Ok(());
            }
            ar::AR_AVAILABILITY_SUPPORTED_INSTALLED => {}
            ar::AR_AVAILABILITY_SUPPORTED_NOT_INSTALLED
            | ar::AR_AVAILABILITY_SUPPORTED_APK_TOO_OLD => {
                if !self.install_enabled && !self.asked_install {
                    self.fallback(
                        "Google Play Services for AR needs installation or an update",
                        true,
                    );
                    return Ok(());
                }
            }
            state => {
                self.fallback(
                    "ARCore unavailable",
                    state != ar::AR_AVAILABILITY_UNSUPPORTED_DEVICE_NOT_CAPABLE,
                );
                return Ok(());
            }
        }
        let mut install = 0;
        let result = unsafe {
            ar::ArCoreApk_requestInstall(
                env.get_raw().cast(),
                activity.as_raw().cast(),
                i32::from(!self.asked_install),
                &mut install,
            )
        };
        if result != ar::AR_SUCCESS {
            self.failed = true;
            self.fallback(&format!("ARCore install check returned {result}"), true);
            return Ok(());
        }
        if install as u32 == ar::AR_INSTALL_STATUS_INSTALL_REQUESTED {
            self.asked_install = true;
            return Ok(());
        }
        let permission = env.new_string("android.permission.CAMERA")?;
        if env
            .call_method(
                activity,
                "checkSelfPermission",
                "(Ljava/lang/String;)I",
                &[(&permission).into()],
            )?
            .i()?
            != 0
        {
            self.fallback("Camera permission needed for ARCore", true);
            if !self.asked_permission {
                self.asked_permission = true;
                let permissions = env.new_object_array(1, "java/lang/String", &permission)?;
                env.call_method(
                    activity,
                    "requestPermissions",
                    "([Ljava/lang/String;I)V",
                    &[(&permissions).into(), 7.into()],
                )?;
            }
            return Ok(());
        }
        let context = env
            .call_method(
                activity,
                "getApplicationContext",
                "()Landroid/content/Context;",
                &[],
            )?
            .l()?;
        let context = env.new_global_ref(context)?;
        let vm = env.get_java_vm()?;
        self.hub
            .set_tracking_mode(TrackingMode::Spatial, self.has_rotation, phone::now());
        self.worker = Some(CameraWorker::start(vm, context, self.hub.clone()));
        self.message = "Using ARCore".into();
        self.retry_visible = false;
        Ok(())
    }
}
