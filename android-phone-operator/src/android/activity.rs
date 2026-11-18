//! NativeActivity calls these hooks synchronously on the application's main thread.
use super::ui::Ui;
use jni::{
    JNIEnv,
    errors::Result,
    objects::{GlobalRef, JObject},
};
use ndk_sys::ANativeActivity;
use std::{cell::RefCell, ffi::c_void, ptr, sync::OnceLock};

thread_local! { static UI: RefCell<Option<Ui>> = const { RefCell::new(None) }; }

pub(super) fn with_ui(f: impl FnOnce(&mut Ui) -> Result<()>) -> Result<()> {
    UI.with_borrow_mut(|ui| match ui {
        Some(ui) => f(ui),
        None => Ok(()),
    })
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
        let ui = Ui::create(env, activity, flags)?;
        UI.with_borrow_mut(|slot| *slot = Some(ui));
        Ok(())
    });
}

unsafe extern "C" fn resume(native: *mut ANativeActivity) {
    dispatch(native, |env, _| with_ui(|ui| ui.resume(env)));
}
unsafe extern "C" fn pause(native: *mut ANativeActivity) {
    dispatch(native, |env, _| with_ui(|ui| ui.pause(env)));
}
unsafe extern "C" fn focus(_native: *mut ANativeActivity, focused: i32) {
    UI.with_borrow_mut(|ui| {
        if let Some(ui) = ui {
            ui.focus(focused != 0);
        }
    });
}
unsafe extern "C" fn save(_native: *mut ANativeActivity, size: *mut usize) -> *mut c_void {
    // Android copies the bytes and calls free() on the returned buffer.
    let flags = UI.with_borrow(|ui| {
        ui.as_ref().map(|ui| {
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
        if let Some(ui) = UI.with_borrow_mut(Option::take) {
            ui.detach(env)?;
        }
        if !env
            .call_method(activity, "isChangingConfigurations", "()Z", &[])?
            .z()?
        {
            super::stop();
        }
        Ok(())
    });
}
