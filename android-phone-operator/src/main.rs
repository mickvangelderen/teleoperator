//! Explicitly synthetic host source for protocol and viewer validation; never an Android sensor substitute.
use phone_operator::{
    phone::{self, Action, Hand, Hub},
    server,
};
use tokio::{net::TcpListener, sync::watch};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|s| s == "--help" || s == "-h") {
        println!(
            "phone-operator-synthetic [--port PORT]\nLoopback-only synthetic phone sensor source for validation. Default port 18083; --port 0 allocates an available port.\nCycles 2s inactive, 2s left held, 2s right held, 2s pause. No real tracking or robot output."
        );
        return Ok(());
    }
    let port = match args.as_slice() {
        [_] => 18083,
        [_, flag, value] if flag == "--port" => value.parse()?,
        _ => return Err("Use --help".into()),
    };
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    let hub = Hub::new(
        [true; 3],
        "SYNTHETIC phone validation (not physical sensors)",
    );
    let (stop, rx) = watch::channel(false);
    let source = hub.clone();
    let mut stopped = rx.clone();
    let producer = tokio::spawn(async move {
        let start = phone::now();
        let mut timer = tokio::time::interval(std::time::Duration::from_millis(10));
        let mut previous = 99;
        loop {
            tokio::select! {
                _=stopped.changed()=>break,
                _=timer.tick()=>{
                    let now=phone::now();let phase=((now-start)/2_000_000_000)%4;
                    if phase!=previous {
                        source.action(Action::Release,now);
                        if phase==3 {source.action(Action::Pause,now);} else {source.action(Action::Resume,now);source.action(Action::Focus(true),now);source.action(Action::Select(if phase==2{Hand::Right}else{Hand::Left}),now);}
                    }
                    let angle=((now-start) as f64 /1e9).sin()*0.3;
                    // Upright phone: 90deg about Android X, plus a yaw motion.
                    let s=std::f64::consts::FRAC_1_SQRT_2;
                    let q=phone::multiply([0.,0.,(angle/2.).sin(),(angle/2.).cos()],[s,0.,0.,s]);
                    source.sensor(0,now,q,now);
                    source.sensor(1,now,[0.,9.81,0.,0.],now);
                    source.sensor(2,now,[0.,angle.cos()*0.3,0.,0.],now);
                    if phase!=previous && (phase==1||phase==2){source.action(Action::Hold,now);}
                    source.tick(now);previous=phase;
                }
            }
        }
    });
    println!("SYNTHETIC phone server http://127.0.0.1:{port}");
    let serving = tokio::spawn(server::serve(listener, rx, hub));
    tokio::signal::ctrl_c().await?;
    let _ = stop.send(true);
    producer.await?;
    serving.await??;
    Ok(())
}
