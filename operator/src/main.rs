#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let synthetic = match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [] => false,
        [flag] if flag == "--synthetic-tracking" => true,
        [flag] if flag == "--help" || flag == "-h" => {
            println!(
                "XR Operator desktop protocol server

Usage: xr-operator-server [--synthetic-tracking]

Options:
  --synthetic-tracking  Generate tracking data without a headset
  -h, --help           Show this help

Environment:
  XR_OPERATOR_BIND     Listening address (default: 127.0.0.1:8080)

Without --synthetic-tracking, no tracking data is acquired."
            );
            return Ok(());
        }
        _ => return Err("Unknown arguments; run xr-operator-server --help for usage".into()),
    };
    let address = std::env::var("XR_OPERATOR_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    let bound = listener.local_addr()?;
    if bound.ip().is_unspecified() {
        println!("XR Operator signaling listening on {bound}");
    } else {
        println!("XR Operator signaling: http://{bound}");
    }
    #[cfg(not(target_os = "android"))]
    let _advertisement = desktop_discovery::advertise(&listener, "XR Operator");
    let (stop, shutdown) = tokio::sync::watch::channel(false);
    let hub = xr_operator::tracking::Hub::new(if synthetic { "synthetic" } else { "none" });
    if synthetic {
        tokio::spawn(xr_operator::tracking::synthetic(
            hub.clone(),
            shutdown.clone(),
        ));
    }
    tokio::spawn(async move {
        #[cfg(unix)]
        let terminate = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut signal) => {
                    signal.recv().await;
                }
                Err(_) => std::future::pending().await,
            }
        };
        #[cfg(not(unix))]
        let terminate = std::future::pending::<()>();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate => {},
        }
        let _ = stop.send(true);
    });
    xr_operator::server::serve(listener, shutdown, hub).await
}
