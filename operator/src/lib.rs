pub mod body;
#[cfg(target_os = "android")]
mod egl;
pub mod inputs;
pub mod protocol;
pub mod server;
pub mod streams;
pub mod tracking;
#[cfg(target_os = "android")]
mod xr;
#[cfg(target_os = "android")]
mod xr_body;
#[cfg(target_os = "android")]
mod xr_inputs;

#[cfg(target_os = "android")]
use android_activity::{AndroidApp, InputStatus, MainEvent, PollEvent};

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
fn android_main(app: AndroidApp) {
    android_logger::init_once(
        android_logger::Config::default()
            .with_tag("xr-operator")
            .with_max_level(log::LevelFilter::Info),
    );
    log::info!(
        "Rust activity started; version={}",
        env!("CARGO_PKG_VERSION")
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("Network runtime");
    let (stop, shutdown) = tokio::sync::watch::channel(false);
    let hub = crate::tracking::Hub::new("openxr");
    let server_hub = hub.clone();
    let server = runtime.spawn(async move {
        match tokio::net::TcpListener::bind("0.0.0.0:8080").await {
            Ok(listener) => {
                if let Err(error) = crate::server::serve(listener, shutdown, server_hub).await {
                    log::error!("Server stopped: {error}");
                }
            }
            Err(error) => log::error!("Could not listen on port 8080: {error}"),
        }
    });
    let mut running = match crate::xr::run(&app, hub) {
        Ok(()) => false,
        Err(error) => {
            log::error!("OpenXR stopped: {error}");
            true
        }
    };
    while running {
        // Keep signaling available after an XR initialization failure.
        app.poll_events(None, |event| {
            if let PollEvent::Main(event) = event {
                match event {
                    MainEvent::Resume { .. } => log::info!("Activity resumed"),
                    MainEvent::Pause => log::info!("Activity paused"),
                    MainEvent::InitWindow { .. } => log::info!("Native window available"),
                    MainEvent::TerminateWindow { .. } => log::info!("Native window removed"),
                    MainEvent::InputAvailable => match app.input_events_iter() {
                        Ok(mut events) => while events.next(|_| InputStatus::Unhandled) {},
                        Err(error) => log::error!("Could not drain input events: {error}"),
                    },
                    MainEvent::Destroy => running = false,
                    _ => {}
                }
            }
        });
    }
    let _ = stop.send(true);
    runtime.block_on(async {
        let _ = server.await;
    });
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    log::info!("Rust activity stopped");
}
