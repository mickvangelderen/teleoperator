//! Deterministic synthetic AR-source motion, NOT camera input or accuracy evidence.
use phone_operator::{
    phone::{self, Action, Hand, Hub},
    server,
    spatial::{Frame, Pose},
};
use tokio::{net::TcpListener, sync::watch};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|s| s == "--help" || s == "-h") {
        println!(
            "phone-operator-spatial-synthetic [--port PORT]\nLoopback SYNTHETIC AR spatial fixture; default 18084, 0 allocates a free port.\n30ms synthetic camera frames, 10ms polls/raw IMU. Cycles inactive/left/right/paused every 2s. No physical camera, spatial accuracy or robot actuation."
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
        let mut previous = 99;
        let mut cached: Option<Frame> = None;
        loop {
            tokio::select! {_=stopped.changed()=>break,_=timer.tick()=>{
                let at=phone::now();let phase=((at-start)/2_000_000_000)%4;
                if phase!=previous {
                    source.action(Action::Release,at);
                    if phase==3 { source.action(Action::Pause,at); } else {
                        source.action(Action::Resume,at);source.action(Action::Focus(true),at);
                        source.action(Action::Select(if phase==2 {Hand::Right}else{Hand::Left}),at);source.action(Action::Recenter,at);
                    }
                    cached=None;
                }
                if phase!=3 {
                    if cached.is_none_or(|f|at-(f.timestamp as u64)>=30_000_000) {
                        let t=(at-start) as f64/1e9;let yaw=0.3*t.sin();
                        cached=Some(Frame{generation:source.spatial_context().0,timestamp:at as i64,metadata_timestamp:Some(at as i64),realtime:true,query_started:at,query_finished:at,
                            tracking:true,sensor:Pose{position:[0.25*t.sin(),0.2+0.05*(t*0.7).cos(),-0.3],orientation:[0.,(yaw/2.).sin(),0.,(yaw/2.).cos()]},anchor:Some(Pose::IDENTITY),created_origin:source.spatial_context().2});
                    }
                    let mut f=cached.unwrap();f.query_started=at;f.query_finished=at;source.spatial_frame(f);
                    source.sensor(1,at,[0.,9.81,0.,0.],at);source.sensor(2,at,[0.,0.3,0.,0.],at);
                    if phase!=previous && (phase==1||phase==2) {source.action(Action::Hold,at);}
                }
                source.tick(at);previous=phase;
            }}
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
