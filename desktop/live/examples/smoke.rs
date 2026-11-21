//! Local smoke test of the worker protocol: `cargo run -p lockin-live --example smoke -- WORKER MODELS CHECK`
//! (needs ORT_DYLIB_PATH on Linux). Sends a few grey frames and prints what comes back.
use lockin_capture::Frame;
use std::time::Duration;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let mut w = lockin_live::worker::Live::start(a[0].as_ref(), a[1].as_ref(), &a[2], false)
        .expect("start");
    println!("engine {} sandbox {:?}", w.engine, w.sandbox());
    let f = Frame {
        width: 640,
        height: 480,
        rgb: vec![120; 640 * 480 * 3],
    };
    for _ in 0..3 {
        let t = std::time::Instant::now();
        let v = w.look(&f, Duration::from_secs(20)).expect("look");
        println!(
            "{:.0} ms: people {} ms {}",
            t.elapsed().as_secs_f64() * 1000.0,
            v["people"],
            v["ms"]
        );
    }
}
