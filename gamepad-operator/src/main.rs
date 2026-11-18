use clap::Parser;
use gamepad_operator::{backend, input::Source, server};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Parser, Debug)]
#[command(
    version,
    about = "Local gamepad INPUT proxy using the current tracking protocol over HTTP/WebRTC",
    long_about = "Local gamepad INPUT proxy. Linux SDL2 evdev supports mapped Xbox/PlayStation and raw-index fallback for unknown layouts. No pose, rumble or hardware outputs. Use the current viewer's signaling proxy (XR_OPERATOR_URL). Defaults select exactly one eligible gamepad; multiple gamepads require --device.",
    after_help = "Identity: only a nonzero MAC-shaped kernel input uniq is eligible for reconnect with a new capability epoch; duplicate identities are rejected. USB/receiver serials, including non-MAC uniq values copied by USB HID, use current input-slot IDs and require restart after unplug; run --list again because slot IDs may change. MAC shape is an identity heuristic, not hardware authentication; sequential devices claiming the same MAC cannot be distinguished.\nTiming: 100 Hz software observations of retained SDL state; idle is valid. Native event order drives counters. Initial held states/disconnects do not create edges. Prediction requests are advisory; actual prediction timestamps are always absent.\nBuild: Cargo bundles SDL2; a C compiler and CMake are required. Linux evdev read access is required for a physical gamepad. No permission or udev changes are performed.\nExamples:\n  gamepad-operator --list\n  gamepad-operator --device 'ID from --list'\n  gamepad-operator --synthetic --listen 127.0.0.1:8082"
)]
struct Args {
    /// Print metadata, eligibility, mapping/access diagnostics and selection IDs, then exit
    #[arg(long)]
    list: bool,
    /// Listen address for /health and /offer (port 0 allocates an unused port)
    #[arg(long, default_value = "127.0.0.1:8082")]
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
    /// Stop cleanly after this many seconds (useful for unattended validation)
    #[arg(long,value_parser=clap::value_parser!(u64).range(1..))]
    run_for: Option<u64>,
}
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = Args::parse();
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
    println!(
        "Gamepad Operator {} http://{}",
        if args.synthetic { "SYNTHETIC" } else { "SDL2" },
        listener.local_addr()?
    );
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
        backend::run_synthetic(source, stop, args.synthetic_lifecycle)
    } else {
        backend::run_sdl(source, stop, args.device, args.mappings)
    };
    shutdown.send_replace(true);
    signal.abort();
    runtime.block_on(serving)??;
    outcome.map_err(Into::into)
}
