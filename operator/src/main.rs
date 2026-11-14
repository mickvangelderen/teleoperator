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
    println!("XR Operator signaling: http://{}", listener.local_addr()?);
    let (stop, shutdown) = tokio::sync::watch::channel(false);
    let hub = xr_operator::tracking::Hub::new(if synthetic { "synthetic" } else { "none" });
    if synthetic {
        tokio::spawn(xr_operator::tracking::synthetic(
            hub.clone(),
            shutdown.clone(),
        ));
    }
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = stop.send(true);
    });
    let recordings =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.artifacts/operator-recordings");
    xr_operator::server::serve(listener, shutdown, hub, recordings).await
}
