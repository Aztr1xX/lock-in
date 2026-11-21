//! Local check of the clip recorder and scorer: records a clip from `frame.png`, then scores it.
//! cargo run -p lockin-live --example score -- <worker exe> <models dir> <check> <frame.png>
use lockin_capture::Frame;
use lockin_live::clips;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let img = image::open(&a[3]).unwrap().to_rgb8();
    let frame = Frame {
        width: img.width(),
        height: img.height(),
        rgb: img.into_raw(),
    };
    let root = std::env::temp_dir().join("lockin-score-example");
    let spec = clips::spec("phone-desk").unwrap();
    let short = clips::Spec {
        secs: 3,
        ..spec.clone()
    };
    clips::record(
        &root,
        &short,
        "Example",
        || Ok(frame.clone()),
        |d, t| eprintln!("recorded {d}/{t}"),
        &|| false,
    )
    .unwrap();
    let out = clips::score(
        &root,
        a[0].as_ref(),
        a[1].as_ref(),
        &[a[2].clone()],
        false,
        Default::default(),
        |c, id, d, t| {
            eprintln!("scored {c} {id} {d}/{t}");
            true
        },
    )
    .unwrap();
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    let _ = std::fs::remove_dir_all(&root);
}
