//! Advertise a live Android signaling listener through the platform DNS-SD service.
#![cfg(target_os = "android")]

use jni_min_helper::{
    JObjectGet, JniProxy, android_context,
    jni::{JNIEnv, errors::Result, objects::GlobalRef},
    jni_clear_ex, jni_with_env,
};
use std::{
    io,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

const LISTENER: &str = "android/net/nsd/NsdManager$RegistrationListener";
const SERVICE_TYPE: &str = "_teleoperator._tcp";

/// The task owns its registration result until the signaling server drops this handle.
/// Starting the Android system service takes place off the HTTP serving path.
#[must_use]
pub struct Advertisement(tokio::task::JoinHandle<Option<Registration>>);

pub fn advertise(name: &'static str, address: io::Result<SocketAddr>) -> Advertisement {
    Advertisement(tokio::task::spawn_blocking(move || {
        let result = address.and_then(|address| {
            jni_with_env(|env| env.with_local_frame(24, |env| register(env, name, address.port())))
                .map_err(io::Error::other)
        });
        match result {
            Ok(registration) => Some(registration),
            Err(error) => {
                log::warn!("DNS-SD unavailable: {error}");
                None
            }
        }
    }))
}

impl Drop for Advertisement {
    fn drop(&mut self) {
        // Skip registration if the server already closed before the worker ran.
        self.0.abort();
    }
}

struct MulticastLock(GlobalRef);
impl Drop for MulticastLock {
    fn drop(&mut self) {
        if let Err(e) =
            jni_with_env(|env| env.call_method(&self.0, "release", "()V", &[]).map(|_| ()))
        {
            log::warn!("Could not release Wi-Fi multicast lock: {e}");
        }
    }
}

fn system_service(env: &mut JNIEnv, name: &str) -> Result<GlobalRef> {
    let name = env.new_string(name)?;
    let service = env
        .call_method(
            android_context(),
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[(&name).into()],
        )?
        .l()?;
    env.new_global_ref(service)
}

// Older Android releases require this even in the foreground. The signaling
// listener also remains available when its Activity is in the background.
fn multicast_lock(env: &mut JNIEnv) -> Result<Option<MulticastLock>> {
    let wifi = system_service(env, "wifi")?;
    if wifi.is_null() {
        return Ok(None);
    }
    let tag = env.new_string("Teleoperator DNS-SD")?;
    let lock = env
        .call_method(
            wifi,
            "createMulticastLock",
            "(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;",
            &[(&tag).into()],
        )?
        .l()?;
    let lock = env.new_global_ref(lock)?;
    env.call_method(&lock, "acquire", "()V", &[])?;
    Ok(Some(MulticastLock(lock)))
}

// Android delivers the terminal listener callback asynchronously, including after
// unregisterService returns. Keep the proxy and legacy lock until that callback.
type Callback = Arc<Mutex<Option<(JniProxy, Option<MulticastLock>)>>>;

struct Registration {
    manager: GlobalRef,
    listener: GlobalRef,
    callback: Callback,
}

fn register(env: &mut JNIEnv, name: &'static str, port: u16) -> Result<Registration> {
    let manager = system_service(env, "servicediscovery")?;
    let info = env.new_object("android/net/nsd/NsdServiceInfo", "()V", &[])?;
    let service_name = env.new_string(name)?;
    let service_type = env.new_string(SERVICE_TYPE)?;
    env.call_method(
        &info,
        "setServiceName",
        "(Ljava/lang/String;)V",
        &[(&service_name).into()],
    )?;
    env.call_method(
        &info,
        "setServiceType",
        "(Ljava/lang/String;)V",
        &[(&service_type).into()],
    )?;
    env.call_method(&info, "setPort", "(I)V", &[i32::from(port).into()])?;
    let callback: Callback = Arc::default();
    let pending = callback.clone();
    let proxy = JniProxy::build(env, None, [LISTENER], move |env, method, args| {
        // A diagnostic failure must not throw out of Android's callback thread.
        if let Ok(method) = method.get_method_name(env).map_err(jni_clear_ex) {
            match method.as_str() {
                "onServiceRegistered" => {
                    let actual = env
                        .call_method(args[0], "getServiceName", "()Ljava/lang/String;", &[])
                        .and_then(|value| value.l()?.get_string(env))
                        .map_err(jni_clear_ex);
                    log::info!(
                        "DNS-SD registered {} {SERVICE_TYPE} on port {port}",
                        actual.as_deref().unwrap_or(name)
                    );
                }
                "onRegistrationFailed" | "onUnregistrationFailed" => {
                    let code = env
                        .call_method(args[1], "intValue", "()I", &[])
                        .and_then(|v| v.i())
                        .map_err(jni_clear_ex);
                    log::warn!("DNS-SD {method} for {name}: {code:?}");
                    pending.lock().unwrap().take();
                }
                "onServiceUnregistered" => {
                    log::info!("DNS-SD withdrew {name}");
                    pending.lock().unwrap().take();
                }
                _ => {}
            }
        }
        JniProxy::void(env)
    })?;
    let listener = env.new_global_ref(proxy.as_ref())?;
    let lock = multicast_lock(env).unwrap_or_else(|error| {
        log::warn!("Could not enable Wi-Fi multicast: {}", jni_clear_ex(error));
        None
    });
    *callback.lock().unwrap() = Some((proxy, lock));
    let result = env.call_method(
        &manager,
        "registerService",
        "(Landroid/net/nsd/NsdServiceInfo;ILandroid/net/nsd/NsdManager$RegistrationListener;)V",
        &[(&info).into(), 1.into(), listener.as_obj().into()],
    );
    if let Err(error) = result {
        let error = jni_clear_ex(error);
        callback.lock().unwrap().take();
        return Err(error);
    }
    Ok(Registration {
        manager,
        listener,
        callback,
    })
}

impl Drop for Registration {
    fn drop(&mut self) {
        if self.callback.lock().unwrap().is_none() {
            return;
        }
        let result = jni_with_env(|env| {
            env.call_method(
                &self.manager,
                "unregisterService",
                "(Landroid/net/nsd/NsdManager$RegistrationListener;)V",
                &[self.listener.as_obj().into()],
            )
            .map(|_| ())
        });
        if let Err(e) = result {
            self.callback.lock().unwrap().take();
            log::warn!("Could not withdraw DNS-SD registration: {e}");
        }
    }
}
