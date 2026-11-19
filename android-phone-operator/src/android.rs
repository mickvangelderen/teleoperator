//! NativeActivity entry, Android framework adapters and operator server lifetime.
mod activity;
mod camera;
mod camera_worker;
mod sensors;
mod ui;

use crate::{
    phone::{self, Action, Hub},
    server,
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
    let mut wifi = Vec::new();
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
                        let name = std::ffi::CStr::from_ptr((*entry).ifa_name).to_bytes();
                        if name.starts_with(b"wlan") {
                            wifi.push(format!("http://{ip}:{PORT}"));
                        } else {
                            ips.push(format!("http://{ip}:{PORT}"));
                        }
                    }
                }
                entry = (*entry).ifa_next;
            }
            libc::freeifaddrs(first);
        }
    }
    if !wifi.is_empty() {
        ips = wifi;
    }
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        "Connect the phone to Wi-Fi".into()
    } else {
        ips.join("\n")
    }
}
fn start(mask: i32) {
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
            n.lock().unwrap().clear();
            let _advertisement = android_discovery::advertise("Phone Operator", listener.local_addr());
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
fn stop() {
    let mut current = app().lock().unwrap();
    if let Some(running) = current.running.take() {
        current.stopping = Some(running.shutdown());
    }
}
fn hub() -> Arc<Hub> {
    app().lock().unwrap().running.as_ref().unwrap().hub.clone()
}

fn operator_address() -> String {
    let current = app().lock().unwrap();
    let Some(a) = &current.running else {
        return "Server stopped".into();
    };
    let network = a.network.lock().unwrap();
    if network.is_empty() {
        addresses()
    } else {
        network.clone()
    }
}
