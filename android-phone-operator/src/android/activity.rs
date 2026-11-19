//! NativeActivity calls these hooks synchronously on the application's main thread.
use super::ui::Ui;
use jni::{
    JNIEnv,
    errors::Result,
    objects::{GlobalRef, JObject},
};
use ndk_sys::ANativeActivity;
use std::{cell::Cell, cell::RefCell, collections::HashMap, ffi::c_void, ptr, sync::OnceLock};

// An explicit launch and a launcher tap can briefly leave two NativeActivities alive.
// Each owns its Views and their callbacks. Only the resumed owner drives the shared Hub.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct ActivityId(usize);
thread_local! {
    static VIEWS: RefCell<HashMap<ActivityId, Ui>> = RefCell::default();
    static ACTIVE: Cell<Option<ActivityId>> = const { Cell::new(None) };
}

impl ActivityId {
    fn with_ui(self, f: impl FnOnce(&mut Ui) -> Result<()>) -> Result<()> {
        VIEWS.with_borrow_mut(|views| match views.get_mut(&self) {
            Some(ui) => f(ui),
            None => Ok(()),
        })
    }

    pub(super) fn is_active(self) -> bool {
        ACTIVE.get() == Some(self)
    }

    pub(super) fn with_active_ui(self, f: impl FnOnce(&mut Ui) -> Result<()>) -> Result<()> {
        if self.is_active() {
            self.with_ui(f)
        } else {
            Ok(())
        }
    }
}

fn dispatch(native: *mut ANativeActivity, run: impl FnOnce(&mut JNIEnv, &JObject) -> Result<()>) {
    // The VM owns this thread's environment and the Activity global reference until onDestroy returns.
    let native = unsafe { &*native };
    let mut env =
        unsafe { JNIEnv::from_raw(native.env.cast()).expect("NativeActivity JNI environment") };
    let activity = unsafe { JObject::from_raw(native.clazz.cast()) };
    if let Err(error) = run(&mut env, &activity) {
        log::error!("Activity callback failed: {error}");
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
        let _ = env.call_method(activity, "finish", "()V", &[]);
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ANativeActivity_onCreate(
    native: *mut ANativeActivity,
    saved: *mut c_void,
    size: usize,
) {
    let flags = if size == 1 && !saved.is_null() {
        unsafe { *saved.cast::<u8>() }
    } else {
        0
    };
    // All remaining callbacks (including native rendering and input) are optional.
    let callbacks = unsafe { &mut *(*native).callbacks };
    callbacks.onResume = Some(resume);
    callbacks.onPause = Some(pause);
    callbacks.onWindowFocusChanged = Some(focus);
    callbacks.onSaveInstanceState = Some(save);
    callbacks.onDestroy = Some(destroy);
    dispatch(native, |env, activity| {
        // Proxy class loading needs a process-lifetime context, including across recreation.
        static APPLICATION: OnceLock<GlobalRef> = OnceLock::new();
        if APPLICATION.get().is_none() {
            let application = env
                .call_method(
                    activity,
                    "getApplicationContext",
                    "()Landroid/content/Context;",
                    &[],
                )?
                .l()?;
            let application = env.new_global_ref(application)?;
            let vm = env.get_java_vm()?.get_java_vm_pointer();
            unsafe {
                ndk_context::initialize_android_context(
                    vm.cast(),
                    application.as_obj().as_raw().cast(),
                );
            }
            let _ = APPLICATION.set(application);
        }
        let owner = ActivityId(native as usize);
        let ui = Ui::create(env, activity, flags, owner)?;
        VIEWS.with_borrow_mut(|views| views.insert(owner, ui));
        Ok(())
    });
}

unsafe extern "C" fn resume(native: *mut ANativeActivity) {
    let owner = ActivityId(native as usize);
    dispatch(native, |env, _| {
        let previous = ACTIVE.replace(Some(owner));
        if previous != Some(owner) {
            if let Some(previous) = previous {
                previous.with_ui(|ui| ui.pause(env))?;
            }
            owner.with_ui(|ui| ui.resume(env))?;
        }
        Ok(())
    });
}
unsafe extern "C" fn pause(native: *mut ANativeActivity) {
    let owner = ActivityId(native as usize);
    if ACTIVE.get() == Some(owner) {
        ACTIVE.set(None);
        dispatch(native, |env, _| owner.with_ui(|ui| ui.pause(env)));
    }
}
unsafe extern "C" fn focus(native: *mut ANativeActivity, focused: i32) {
    dispatch(native, |_, _| {
        ActivityId(native as usize).with_ui(|ui| {
            ui.focus(focused != 0);
            Ok(())
        })
    });
}
unsafe extern "C" fn save(native: *mut ANativeActivity, size: *mut usize) -> *mut c_void {
    // Android copies the bytes and calls free() on the returned buffer.
    let flags = VIEWS.with_borrow(|views| {
        views.get(&ActivityId(native as usize)).map(|ui| {
            u8::from(ui.tracking.asked_permission) | (u8::from(ui.tracking.asked_install) << 1)
        })
    });
    unsafe {
        *size = 0;
    }
    let Some(flags) = flags else {
        return ptr::null_mut();
    };
    let data = unsafe { libc::malloc(1) };
    if !data.is_null() {
        unsafe {
            *data.cast::<u8>() = flags;
            *size = 1;
        }
    }
    data
}
unsafe extern "C" fn destroy(native: *mut ANativeActivity) {
    dispatch(native, |env, activity| {
        let owner = ActivityId(native as usize);
        if ACTIVE.get() == Some(owner) {
            ACTIVE.set(None);
        }
        let ui = VIEWS.with_borrow_mut(|views| views.remove(&owner));
        let cleanup = ui.map_or(Ok(()), |mut ui| ui.detach(env));
        if VIEWS.with_borrow(HashMap::is_empty)
            && !env
                .call_method(activity, "isChangingConfigurations", "()Z", &[])?
                .z()?
        {
            super::stop();
        }
        cleanup
    });
}
