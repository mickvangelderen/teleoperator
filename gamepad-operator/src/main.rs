use clap::Parser;
use gamepad_operator::{backend, input::Source, server, virtual_pose::Config};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const DEFAULT_PORT: u16 = 8080;

#[derive(Parser, Debug)]
#[command(
    version,
    about = "Share a local gamepad over HTTP/WebRTC",
    long_about = "Share a local gamepad over HTTP/WebRTC. LAN listeners advertise their signaling address via DNS-SD. Linux SDL2 evdev supports mapped Xbox/PlayStation and raw-index fallback for unknown layouts. Raw input is the default; optional --virtual-pose generates a software pose. No rumble or hardware outputs. Defaults select exactly one eligible gamepad; multiple gamepads require --device.",
    after_help = format!("Identity: only a nonzero MAC-shaped kernel input uniq is eligible for reconnect with a new capability epoch; duplicate identities are rejected. USB/receiver serials, including non-MAC uniq values copied by USB HID, use current input-slot IDs and require restart after unplug; run --list again because slot IDs may change. MAC shape is an identity heuristic, not hardware authentication; sequential devices claiming the same MAC cannot be distinguished.\nTiming: up to 100 Hz software observations of retained SDL state, aligned to compatible publication schedules; idle is valid. Native event order drives counters. Initial held states/disconnects do not create edges. Prediction requests are advisory; actual prediction timestamps are always absent.\nVirtual pose (--virtual-pose): starts PAUSED. Start/Options toggles motion; View/Back (Xbox), Share (PS4) or Create (PS5) resets position/orientation and pauses (reset wins simultaneous commands). The separate Xbox Series Share button is unused. Left stick: yaw-relative horizontal movement, up = forward. Right stick: right = yaw right, up = pitch down by default; pitch clamped to +/-90 degrees. {} Model frame: +X right, +Y up, -Z forward, origin [0,0,0], initial identity orientation; no real-world placement. Heading remains independent of pitch/roll, including vertical pitch. Virtual stick motion uses a rescaled radial deadzone of 0.15. Paused pose remains valid software state; tracked flags always false and actual prediction absent. Disconnect, missing controls or observation gaps >100 ms pause; fresh Start/Options press required to resume. New device epochs start at the origin paused. Missing mapped controls leave raw mode with a health diagnostic.\nBuild: Cargo bundles SDL2; a C compiler and CMake are required. Linux evdev read access is required for a physical gamepad. No permission or udev changes are performed.\nExamples:\n  gamepad-operator --list\n  gamepad-operator --device 'ID from --list'\n  gamepad-operator --synthetic", gamepad_operator::virtual_pose::EFFECTOR_CONTROLS)
)]
struct Args {
    /// Print metadata, eligibility, mapping/access diagnostics and selection IDs, then exit
    #[arg(long)]
    list: bool,
    /// Listen address for /health and /offer. Use 127.0.0.1:8080 for local-only access or port 0 for an allocated port
    #[arg(long, default_value_t = SocketAddr::from(([0, 0, 0, 0], DEFAULT_PORT)))]
    listen: SocketAddr,
    /// Exact identity from --list; never switches to a different identity
    #[arg(long, conflicts_with = "synthetic")]
    device: Option<String>,
    /// Optional SDL2 mappings file for a controller whose mapping is missing/wrong
    #[arg(long, conflicts_with = "synthetic")]
    mappings: Option<PathBuf>,
    /// Deterministic software gamepad, clearly labeled; opens no physical input
    #[arg(long)]
    synthetic: bool,
    /// Synthetic unplug at 6s/reconnect at 8s of each 12s cycle; closes old peers on reconnect
    #[arg(long, requires = "synthetic")]
    synthetic_lifecycle: bool,
    /// Opt in to a software model-frame pose; requires all mapped controls described below
    #[arg(long)]
    virtual_pose: bool,
    /// Base horizontal and vertical speeds with LT released, each in metres/second, range (0,10]
    #[arg(long, requires = "virtual_pose", default_value_t = Config::default().linear_metres_per_second)]
    virtual_linear_speed: f64,
    /// Base virtual yaw/pitch/roll speed with LT released in degrees/second, range (0,720]
    #[arg(long, requires = "virtual_pose", default_value_t = Config::default().angular_degrees_per_second)]
    virtual_angular_speed: f64,
    /// Pushing the right stick up pitches the virtual pose down when true
    #[arg(long, requires = "virtual_pose", action = clap::ArgAction::Set, default_value_t = Config::default().invert_pitch)]
    virtual_invert_pitch: bool,
    /// Script all virtual controls over 10s cycles, including explicit enable/reset presses (software only)
    #[arg(long, requires_all = ["synthetic", "virtual_pose"])]
    synthetic_virtual_demo: bool,
    /// Stop cleanly after this many seconds (useful for unattended validation)
    #[arg(long,value_parser=clap::value_parser!(u64).range(1..))]
    run_for: Option<u64>,
}
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = Args::parse();
    let virtual_config = args.virtual_pose.then_some(Config {
        linear_metres_per_second: args.virtual_linear_speed,
        angular_degrees_per_second: args.virtual_angular_speed,
        invert_pitch: args.virtual_invert_pitch,
    });
    if let Some(config) = virtual_config
        && let Err(message) = config.validate()
    {
        use clap::CommandFactory;
        Args::command()
            .error(clap::error::ErrorKind::ValueValidation, message)
            .exit();
    }
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("gamepad_operator=info"),
    )
    .init();
    if args.list {
        if args.synthetic {
            println!(
                "{}",
                serde_json::to_string_pretty(&backend::synthetic_device())?
            );
        } else {
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &backend::Sdl::new(args.mappings.as_deref())?.list()?
                )?
            );
        }
        return Ok(());
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let source = Arc::new(Source::default());
    let stop = Arc::new(AtomicBool::new(false));
    let (shutdown, rx) = tokio::sync::watch::channel(false);
    let listener = runtime.block_on(tokio::net::TcpListener::bind(args.listen))?;
    let address = listener.local_addr()?;
    let mut viewer_target = address;
    if address.ip().is_unspecified() {
        viewer_target.set_ip(if address.is_ipv4() {
            std::net::Ipv4Addr::LOCALHOST.into()
        } else {
            std::net::Ipv6Addr::LOCALHOST.into()
        });
    }
    println!(
        "Gamepad Operator {} http://{viewer_target}",
        if args.synthetic { "SYNTHETIC" } else { "SDL2" },
    );
    let _advertisement = desktop_discovery::advertise(&listener, "Gamepad Operator");
    if viewer_target == SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)) {
        eprintln!("From the viewer directory, run: pnpm dev");
    } else {
        eprintln!(
            "From the viewer directory, run: XR_OPERATOR_URL=http://{viewer_target} pnpm dev"
        );
    }
    let serving_stop = stop.clone();
    let serving_source = source.clone();
    let serving = runtime.spawn(async move {
        let result = server::serve(listener, rx, serving_source).await;
        serving_stop.store(true, Ordering::Relaxed);
        result
    });
    let stopping = stop.clone();
    let signal=runtime.spawn(async move {
        #[cfg(unix)]
        let mut terminate=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _=tokio::signal::ctrl_c()=>{},
            _=async {#[cfg(unix)] {terminate.recv().await;} #[cfg(not(unix))] std::future::pending::<()>().await;}=>{},
            _=async {if let Some(seconds)=args.run_for {tokio::time::sleep(Duration::from_secs(seconds)).await;}else{std::future::pending::<()>().await;}}=>{},
        }
        stopping.store(true,Ordering::Relaxed);
    });
    // SDL remains on the main OS thread; the runtime handles network I/O separately.
    let outcome = if args.synthetic {
        backend::run_synthetic(
            source,
            stop,
            args.synthetic_lifecycle,
            virtual_config,
            args.synthetic_virtual_demo,
        )
    } else {
        backend::run_sdl(source, stop, args.device, args.mappings, virtual_config)
    };
    shutdown.send_replace(true);
    signal.abort();
    runtime.block_on(serving)??;
    outcome.map_err(Into::into)
}
