//! Minimal JNI boundary. All tracking/lifecycle state and networking live in Rust.
use crate::{
    phone::{self, Action, Hand, Hub, TrackingMode},
    server,
};
use jni::{
    JNIEnv,
    objects::JClass,
    sys::{jfloat, jint, jlong, jstring},
};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::watch;

const PORT: u16 = 8080;

struct App {
    hub: Arc<Hub>,
    stop: watch::Sender<bool>,
    thread: Option<std::thread::JoinHandle<()>>,
    network: Arc<Mutex<String>>,
}
impl App {
    fn shutdown(mut self) -> std::thread::JoinHandle<()> {
        self.hub.action(Action::Shutdown, phone::now());
        let _ = self.stop.send(true);
        self.thread.take().expect("Owned server thread")
    }
}
#[derive(Default)]
struct AppSlot {
    running: Option<App>,
    stopping: Option<std::thread::JoinHandle<()>>,
}
fn app() -> &'static Mutex<AppSlot> {
    static APP: OnceLock<Mutex<AppSlot>> = OnceLock::new();
    APP.get_or_init(|| Mutex::new(AppSlot::default()))
}
fn addresses() -> String {
    let mut first = std::ptr::null_mut();
    let mut ips = Vec::new();
    unsafe {
        if libc::getifaddrs(&mut first) == 0 {
            let mut entry = first;
            while !entry.is_null() {
                let address = (*entry).ifa_addr;
                if !address.is_null() && (*address).sa_family as i32 == libc::AF_INET {
                    let bytes = (*(address as *const libc::sockaddr_in))
                        .sin_addr
                        .s_addr
                        .to_ne_bytes();
                    let ip = std::net::Ipv4Addr::from(bytes);
                    if !ip.is_loopback() && !ip.is_unspecified() {
                        ips.push(format!("http://{ip}:{PORT}"));
                    }
                }
                entry = (*entry).ifa_next;
            }
            libc::freeifaddrs(first);
        }
    }
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        format!("No LAN IPv4 address. Connect Wi-Fi; server port {PORT}.")
    } else {
        ips.join("\n")
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_MainActivity_nativeStart(
    _env: JNIEnv,
    _class: JClass,
    mask: jint,
) {
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("PhoneOperator"),
    );
    let mut current = app().lock().unwrap();
    // A configuration recreation retains the inactive server and its peers.
    if current.running.is_some() {
        return;
    }
    let previous = current.stopping.take();
    let hub = Hub::new(
        std::array::from_fn(|i| mask & (1 << i) != 0),
        "Android phone",
    );
    let (stop, rx) = watch::channel(false);
    let network = Arc::new(Mutex::new("Starting server…".into()));
    let h = hub.clone();
    let n = network.clone();
    let thread = std::thread::spawn(move || {
        // Serialize restart after port release without joining on Android's UI thread.
        if let Some(previous) = previous {
            let _ = previous.join();
        }
        if *rx.borrow() {
            return;
        }
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
        {
            Ok(r) => r,
            Err(e) => {
                *n.lock().unwrap() = format!("Runtime failed: {e}");
                return;
            }
        };
        runtime.block_on(async move {
            let listener=match tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED,PORT)).await {Ok(l)=>l,Err(e)=>{*n.lock().unwrap()=format!("Server unavailable: {e}");return;}};
            *n.lock().unwrap()=format!("Listening — port {PORT}");
            let source=h.clone();let mut ticker_stop=rx.clone();
            let ticker=tokio::spawn(async move {
                let mut timer=tokio::time::interval(std::time::Duration::from_millis(25));
                loop{tokio::select!{_ = ticker_stop.changed()=>break,_=timer.tick()=>source.tick(phone::now())}}
            });
            if let Err(e)=server::serve(listener,rx,h).await{*n.lock().unwrap()=format!("Server stopped: {e}");}
            ticker.abort();let _=ticker.await;
        });
        runtime.shutdown_timeout(std::time::Duration::from_secs(3));
    });
    current.running = Some(App {
        hub,
        stop,
        thread: Some(thread),
        network,
    });
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_MainActivity_nativeStop(
    _env: JNIEnv,
    _class: JClass,
) {
    let mut current = app().lock().unwrap();
    if let Some(running) = current.running.take() {
        current.stopping = Some(running.shutdown());
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_MainActivity_nativeAction(
    _env: JNIEnv,
    _class: JClass,
    code: jint,
) {
    let action = match code {
        0 => Action::Select(Hand::Left),
        1 => Action::Select(Hand::Right),
        2 => Action::Hold,
        3 => Action::Release,
        4 => Action::Cancel,
        5 => Action::Resume,
        6 => Action::Pause,
        7 => Action::Focus(true),
        8 => Action::Focus(false),
        9 => Action::Recenter,
        _ => return,
    };
    if let Some(a) = app().lock().unwrap().running.as_ref() {
        a.hub.action(action, phone::now());
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_MainActivity_nativeSensor(
    _env: JNIEnv,
    _class: JClass,
    kind: jint,
    timestamp: jlong,
    x: jfloat,
    y: jfloat,
    z: jfloat,
    w: jfloat,
) {
    if timestamp < 0 {
        return;
    }
    if let Some(a) = app().lock().unwrap().running.as_ref() {
        a.hub.sensor(
            kind as usize,
            timestamp as u64,
            [x as f64, y as f64, z as f64, w as f64],
            phone::now(),
        );
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_MainActivity_nativeStatus(
    env: JNIEnv,
    _class: JClass,
) -> jstring {
    let current = app().lock().unwrap();
    let text = current
        .running
        .as_ref()
        .map(|a| {
            format!(
                "{}\n\n{}\n{}",
                a.hub.status(phone::now()),
                a.network.lock().unwrap(),
                addresses()
            )
        })
        .unwrap_or_else(|| "Server stopped".into());
    env.new_string(text)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_MainActivity_nativeFlags(
    _env: JNIEnv,
    _class: JClass,
) -> jint {
    app().lock().unwrap().running.as_ref().map_or(0, |a| {
        i32::from(a.hub.held()) | ((a.hub.selected() as i32) << 1)
    })
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_MainActivity_nativeSetMode(
    _env: JNIEnv,
    _class: JClass,
    mode: jint,
    has_rotation_sensor: jni::sys::jboolean,
) {
    let mode = match mode {
        0 => TrackingMode::Orientation,
        1 => TrackingMode::Displacement,
        2 => TrackingMode::Spatial,
        _ => return,
    };
    if let Some(a) = &app().lock().unwrap().running {
        a.hub
            .set_tracking_mode(mode, has_rotation_sensor != 0, phone::now());
    }
}

// The low bit requests a new origin. A change to the generation invalidates
// frames and anchors captured before recenter, lifecycle or source changes.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_ArTracking_nativeContext(
    _env: JNIEnv,
    _class: JClass,
) -> jlong {
    let current = app().lock().unwrap();
    let Some(a) = &current.running else { return -1 };
    let (generation, active, recenter) = a.hub.spatial_context();
    if active {
        ((generation << 1) | u64::from(recenter)) as jlong
    } else {
        -1
    }
}

fn read_pose(env: &JNIEnv, array: &jni::objects::JFloatArray) -> Option<crate::spatial::Pose> {
    if array.is_null() {
        return None;
    }
    let mut values = [0f32; 7];
    env.get_float_array_region(array, 0, &mut values).ok()?;
    Some(crate::spatial::Pose {
        position: std::array::from_fn(|i| values[i] as f64),
        orientation: std::array::from_fn(|i| values[i + 3] as f64),
    })
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_ArTracking_nativeOriginRotation(
    env: JNIEnv,
    _class: JClass,
    sensor: jni::objects::JFloatArray,
) -> jni::sys::jfloatArray {
    let rotation = read_pose(&env, &sensor).and_then(crate::spatial::origin_pose);
    let Some(origin) = rotation else {
        return std::ptr::null_mut();
    };
    let Ok(array) = env.new_float_array(4) else {
        return std::ptr::null_mut();
    };
    if env
        .set_float_array_region(&array, 0, &origin.orientation.map(|n| n as f32))
        .is_err()
    {
        return std::ptr::null_mut();
    }
    array.into_raw()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_xroperator_phone_ArTracking_nativeFrame(
    env: JNIEnv,
    _class: JClass,
    generation: jlong,
    timestamp: jlong,
    camera_timestamp: jlong,
    before: jlong,
    sensor: jni::objects::JFloatArray,
    anchor: jni::objects::JFloatArray,
    created: jni::sys::jboolean,
) {
    let sensor = read_pose(&env, &sensor);
    if let Some(a) = &app().lock().unwrap().running {
        a.hub.spatial_frame(crate::spatial::Frame {
            generation: generation as u64,
            timestamp,
            metadata_timestamp: Some(camera_timestamp),
            realtime: true, // The camera worker checks CameraCharacteristics before starting.
            query_started: before as u64,
            query_finished: phone::now(),
            tracking: sensor.is_some(),
            sensor: sensor.unwrap_or(crate::spatial::Pose::IDENTITY),
            anchor: read_pose(&env, &anchor),
            created_origin: created != 0,
        });
    }
}
