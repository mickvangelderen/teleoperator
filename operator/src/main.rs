#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let address = std::env::var("XR_OPERATOR_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("XR Operator signaling: http://{}", listener.local_addr()?);
    let (stop, shutdown) = tokio::sync::watch::channel(false);
    let synthetic = match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [] => false,
        [flag] if flag == "--synthetic-tracking" => true,
        _ => return Err("Usage: xr-operator-server [--synthetic-tracking]".into()),
    };
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
    xr_operator::server::serve(listener, shutdown, hub).await
}
