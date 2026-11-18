//! Synthetic SENSOR input through the real estimator; never injects pose values.
use phone_operator::{
    displacement::GRAVITY,
    phone::{self, Action, Hand, Hub},
    server,
};
use tokio::{net::TcpListener, sync::watch};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "phone-operator-displacement-synthetic [--port PORT]\nLoopback SYNTHETIC IMU sensor input through the displacement estimator. Default18085;0 allocates a free port.\nConstant0.2m/s² local X acceleration, stationary portrait orientation,5ms sensor phase difference. Cycles inactive/left/right/pause each2s. No hardware accuracy claim."
        );
        return Ok(());
    }
    let port = match args.as_slice() {
        [_] => 18085,
        [_, flag, value] if flag == "--port" => value.parse()?,
        _ => return Err("Use --help".into()),
    };
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    let hub = Hub::displacement_at(
        [true; 3],
        "SYNTHETIC IMU displacement sensors (not physical tracking)",
        phone::now(),
    );
    let (stop, rx) = watch::channel(false);
    let source = hub.clone();
    let mut stopped = rx.clone();
    let producer = tokio::spawn(async move {
        let start = phone::now();
        let mut timer = tokio::time::interval(std::time::Duration::from_millis(10));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut previous = 99;
        loop {
            tokio::select! {_=stopped.changed()=>break,_=timer.tick()=>{
                let at=phone::now();let phase=((at-start)/2_000_000_000)%4;
                if phase!=previous {
                    source.action(Action::Release,at);
                    if phase==3 {source.action(Action::Pause,at);} else {
                        source.action(Action::Resume,at);source.action(Action::Focus(true),at);source.action(Action::Select(if phase==2 {Hand::Right}else{Hand::Left}),at);
                    }
                }
                if phase!=3 {
                    let h=std::f64::consts::FRAC_1_SQRT_2;
                    source.sensor(0,at,[h,0.,0.,h],at);
                    // First seed is simultaneous; later acceleration lies between
                    // consecutive orientations so the real bounded SLERP path runs.
                    let acceleration_at=if phase!=previous {at}else{at-5_000_000};
                    source.sensor(1,acceleration_at,[0.2,GRAVITY,0.,0.],at);
                    source.sensor(2,at,[0.,0.,0.,0.],at);
                    if phase!=previous && (phase==1||phase==2) {source.action(Action::Hold,at);}
                }
                source.tick(at);previous=phase;
            }}
        }
    });
    println!("SYNTHETIC IMU displacement server http://127.0.0.1:{port}");
    let serving = tokio::spawn(server::serve(listener, rx, hub));
    tokio::signal::ctrl_c().await?;
    let _ = stop.send(true);
    producer.await?;
    serving.await??;
    Ok(())
}
