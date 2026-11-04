use android_activity::{AndroidApp, InputStatus, MainEvent, PollEvent};

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

    let mut running = true;
    while running {
        // Block until Android has work; there is no XR frame loop yet.
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
    log::info!("Rust activity stopped");
}
