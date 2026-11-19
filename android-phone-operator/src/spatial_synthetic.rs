//! Deterministic synthetic AR-source motion, NOT camera input or accuracy evidence.
use phone_operator::{
    phone::{self, Action, Hub},
    server,
    spatial::{Frame, FrameAnchor, Pose},
};
use tokio::{net::TcpListener, sync::watch};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|s| s == "--help" || s == "-h") {
        println!(
            "phone-operator-spatial-synthetic [--port PORT]\nLoopback SYNTHETIC AR spatial fixture; default 18084, 0 allocates a free port.\n30ms synthetic camera frames, 10ms polls/raw IMU. Cycles controls every 2s. No physical camera, spatial accuracy or robot actuation."
        );
        return Ok(());
    }
    let port = match args.as_slice() {
        [_] => 18084,
        [_, flag, value] if flag == "--port" => value.parse()?,
        _ => return Err("Use --help".into()),
    };
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    let hub = Hub::spatial_at(
        [true; 3],
        "SYNTHETIC AR spatial validation (not physical tracking)",
        phone::now(),
    );
    let (stop, rx) = watch::channel(false);
    let source = hub.clone();
    let mut stopped = rx.clone();
    let producer = tokio::spawn(async move {
        let start = phone::now();
        let mut timer = tokio::time::interval(std::time::Duration::from_millis(10));
        source.action(Action::Resume, start);
        source.action(Action::Focus(true), start);
        let mut previous = 99;
        let mut cached: Option<Frame> = None;
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                _ = timer.tick() => {}
            }
            let at = phone::now();
            let phase = ((at - start) / 2_000_000_000) % 4;
            if phase != previous {
                source.action(Action::SetInput(if phase < 2 { -7 } else { 42 }), at);
                source.action(Action::SetTrigger([0., 0.25, 0.75, 1.][phase as usize]), at);
                source.action(
                    if phase == 1 || phase == 2 {
                        Action::Hold
                    } else {
                        Action::Release
                    },
                    at,
                );
            }
            if cached.is_none_or(|f| at - f.query_finished >= 30_000_000) {
                let elapsed = at - start;
                let t = elapsed as f64 / 1e9;
                let yaw = 0.3 * t.sin();
                let (generation, _, request) = source.spatial_context();
                // Briefly lose camera tracking during each hold, retaining the reference.
                let dropout = (800_000_000..1_000_000_000).contains(&(elapsed % 2_000_000_000));
                cached = Some(Frame {
                    generation,
                    timestamp: elapsed as i64 + 1, // distinct SDK time base
                    metadata_timestamp: Some(at as i64),
                    realtime: true,
                    query_started: at,
                    query_finished: at,
                    tracking: if dropout {
                        Err("Synthetic camera paused")
                    } else {
                        Ok(())
                    },
                    sensor: Pose {
                        position: [0.25 * t.sin(), 0.2 + 0.05 * (t * 0.7).cos(), -0.3],
                        orientation: [0., (yaw / 2.).sin(), 0., (yaw / 2.).cos()],
                    },
                    anchor: if request.is_some() {
                        FrameAnchor::Tracking(Pose::IDENTITY)
                    } else {
                        FrameAnchor::Missing
                    },
                });
            }
            let mut f = cached.unwrap();
            f.query_started = at;
            f.query_finished = at;
            source.spatial_frame(f);
            let yaw = 0.3 * ((at - start) as f64 / 1e9).sin();
            let h = std::f64::consts::FRAC_1_SQRT_2;
            let imu = phone::multiply([0., 0., (yaw / 2.).sin(), (yaw / 2.).cos()], [h, 0., 0., h]);
            source.sensor(0, at, imu, at);
            source.sensor(1, at, [0., 9.81, 0., 0.], at);
            source.sensor(2, at, [0., 0.3, 0., 0.], at);
            source.tick(at);
            previous = phase;
        }
    });
    println!("SYNTHETIC AR spatial server http://127.0.0.1:{port}");
    let serving = tokio::spawn(server::serve(listener, rx, hub));
    tokio::signal::ctrl_c().await?;
    let _ = stop.send(true);
    producer.await?;
    serving.await??;
    Ok(())
}
