//! UI-thread install/permission flow. Only the worker owns a camera session.
use super::camera_worker::CameraWorker;
use crate::phone::{self, Hub};
use crate::tracking::{CameraPrompts, Permission, Selection, TrackingMode};
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

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Retry {
    Service,
    Permission,
}

pub(super) struct Tracking {
    pub selection: Selection,
    pub message: String,
    pub retry_action: Option<Retry>,
    pub prompts: CameraPrompts,
    sensor_mask: i32,
    next_check: Option<Instant>,
    worker: Option<CameraWorker>,
    hub: Arc<Hub>,
}

impl Tracking {
    pub fn new(selection: Selection, flags: u8, hub: Arc<Hub>) -> Self {
        Self {
            selection,
            sensor_mask: 0,
            hub,
            message: String::new(),
            retry_action: None,
            prompts: CameraPrompts::restore(flags),
            worker: None,
            next_check: None,
        }
    }

    fn without_camera(&mut self, reason: &str, retry: Option<Retry>) {
        self.worker.take();
        self.next_check = None;
        let mode = self
            .selection
            .without_camera(self.sensor_mask & 1 != 0, self.sensor_mask & 2 != 0);
        self.hub.set_tracking_mode(mode, phone::now());
        let source = match mode {
            TrackingMode::Orientation
                if self.selection.output == crate::tracking::Output::FullPose =>
            {
                "IMU orientation · accelerometer unavailable"
            }
            TrackingMode::Orientation => "IMU orientation",
            TrackingMode::Displacement => "IMU estimated displacement",
            _ => "Pose unavailable",
        };
        self.message = if reason.is_empty() {
            source.into()
        } else {
            format!("{source} · {reason}")
        };
        self.retry_action = retry;
    }

    pub fn resume(&mut self, sensor_mask: i32) {
        self.sensor_mask = sensor_mask;
        self.without_camera("", None);
        self.check_soon();
    }
    pub fn select(&mut self, selection: Selection) {
        self.selection = selection;
        self.resume(self.sensor_mask);
    }
    pub fn stop(&mut self) {
        self.without_camera("", None);
    }
    pub fn check_soon(&mut self) {
        if self.worker.is_none() && self.selection.wants_camera(self.sensor_mask & 1 != 0) {
            self.next_check = Some(Instant::now());
        }
    }

    pub fn retry(&mut self, env: &mut JNIEnv, activity: &JObject) -> Result<()> {
        let permission = env.new_string("android.permission.CAMERA")?;
        let denied = env
            .call_method(
                activity,
                "checkSelfPermission",
                "(Ljava/lang/String;)I",
                &[(&permission).into()],
            )?
            .i()?
            != 0;
        let rationale = env
            .call_method(
                activity,
                "shouldShowRequestPermissionRationale",
                "(Ljava/lang/String;)Z",
                &[(&permission).into()],
            )?
            .z()?;
        if self.retry_action == Some(Retry::Permission)
            && self.prompts.needs_settings(denied, rationale)
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
            self.prompts = CameraPrompts::default();
            self.check_soon();
        }
        Ok(())
    }
    pub fn update(&mut self, env: &mut JNIEnv, activity: &GlobalRef) -> Result<()> {
        if let Some(failure) = self.worker.as_ref().and_then(CameraWorker::failure) {
            self.without_camera(&failure.message, Some(Retry::Service));
            if failure.transient {
                self.next_check = Some(Instant::now() + Duration::from_secs(2));
            }
        } else if self.next_check.is_some_and(|at| at <= Instant::now()) {
            // A recovering camera may establish a new origin. Finish the user's
            // current IMU gesture before probing another provider.
            if self.hub.handset_status(phone::now()).held {
                return Ok(());
            }
            self.next_check = None;
            self.try_camera(env, activity.as_obj())?;
        }
        Ok(())
    }
    fn try_camera(&mut self, env: &mut JNIEnv, activity: &JObject) -> Result<()> {
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
            ar::AR_AVAILABILITY_SUPPORTED_INSTALLED
            | ar::AR_AVAILABILITY_SUPPORTED_NOT_INSTALLED
            | ar::AR_AVAILABILITY_SUPPORTED_APK_TOO_OLD => {}
            ar::AR_AVAILABILITY_UNSUPPORTED_DEVICE_NOT_CAPABLE => {
                self.without_camera("ARCore unsupported on this device", None);
                return Ok(());
            }
            _ => {
                self.without_camera("ARCore availability unknown", Some(Retry::Service));
                self.next_check = Some(Instant::now() + Duration::from_secs(5));
                return Ok(());
            }
        }
        let mut install = 0;
        let result = unsafe {
            ar::ArCoreApk_requestInstall(
                env.get_raw().cast(),
                activity.as_raw().cast(),
                i32::from(!self.prompts.install_requested),
                &mut install,
            )
        };
        if result != ar::AR_SUCCESS {
            let reason = match result {
                ar::AR_UNAVAILABLE_USER_DECLINED_INSTALLATION => {
                    "AR services installation declined"
                }
                ar::AR_UNAVAILABLE_DEVICE_NOT_COMPATIBLE => "ARCore unsupported on this device",
                _ => "Could not set up AR services",
            };
            log::warn!("ARCore install check: {result}");
            self.without_camera(
                reason,
                (result != ar::AR_UNAVAILABLE_DEVICE_NOT_COMPATIBLE).then_some(Retry::Service),
            );
            return Ok(());
        }
        if install as u32 == ar::AR_INSTALL_STATUS_INSTALL_REQUESTED {
            self.prompts.install_requested = true;
            self.message = "Waiting for AR services".into();
            return Ok(());
        }
        self.prompts.install_requested = false;
        let permission = env.new_string("android.permission.CAMERA")?;
        let granted = env
            .call_method(
                activity,
                "checkSelfPermission",
                "(Ljava/lang/String;)I",
                &[(&permission).into()],
            )?
            .i()?
            == 0;
        match self.prompts.permission(granted) {
            Permission::Granted => {}
            Permission::Denied => {
                self.without_camera("Camera permission needed", Some(Retry::Permission));
                return Ok(());
            }
            Permission::Request => {
                self.without_camera("Camera permission needed", Some(Retry::Permission));
                env.call_method(activity, "requestCameraPermission", "()V", &[])?;
                return Ok(());
            }
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
        self.worker = Some(CameraWorker::start(
            vm,
            context,
            self.hub.clone(),
            self.selection.camera(),
        ));
        self.message = "Starting ARCore".into();
        self.retry_action = None;
        Ok(())
    }
}
