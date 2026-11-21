//! Lock In camera worker.
//!
//! Runs the camera models on pictures it is handed and answers with numbers only. It has no
//! network code and opens no files except its own models and ONNX Runtime.
//!
//! Usage:
//!   lockin-camera bench --models DIR [--runs N] [--engines cpu1,cpu,gpu,gpu-low]
//!                       [--image FILE] [--reference FILE] [--ort FILE]
//!     Speed test. Without --image, the picture (PNG or JPEG bytes) is read from stdin, so a
//!     camera frame never has to be written to disk.
//!   lockin-camera run --models DIR --check NAME [--gpu] [--ort FILE]
//!     Live mode: raw frames in on stdin, what the models saw out on stdout (see run.rs).
//!
//! Output is JSON, one object per line, on stdout.

mod bench;
mod machine;
mod run;
mod runtime;
mod vision;

use runtime::Engine;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;

fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn fail(msg: impl Into<String>) -> ! {
    emit(json!({ "type": "error", "message": msg.into() }));
    std::process::exit(1);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    match args.first().map(String::as_str) {
        Some("bench") => {}
        Some("run") => {
            let dir = flag("--models")
                .map(PathBuf::from)
                .unwrap_or_else(|| runtime::beside_exe("models"));
            let check = flag("--check").unwrap_or_else(|| fail("--check NAME is required"));
            let ort = flag("--ort").map(PathBuf::from);
            let (mut models, _env) = run::Models::open(
                &dir,
                &check,
                args.iter().any(|a| a == "--gpu"),
                ort.as_deref(),
            )
            .unwrap_or_else(|e| fail(e));
            emit(json!({ "type": "ready", "check": check, "engine": models.engine.key() }));
            if let Err(e) = run::serve(&mut models, &mut emit) {
                fail(e);
            }
            return;
        }
        _ => fail(
            "usage: lockin-camera bench --models DIR ... | run --models DIR --check NAME [--gpu]",
        ),
    }

    let models_dir = flag("--models")
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime::beside_exe("models"));
    let runs = flag("--runs")
        .and_then(|s| s.parse().ok())
        .unwrap_or(20usize)
        .clamp(3, 500);
    let engines: Vec<Engine> = match flag("--engines") {
        Some(list) => list
            .split(',')
            .map(|k| {
                Engine::from_key(k.trim()).unwrap_or_else(|| fail(format!("unknown engine {k}")))
            })
            .collect(),
        None if cfg!(windows) => Engine::ALL.to_vec(),
        None => vec![Engine::Cpu1, Engine::Cpu],
    };

    let (bytes, source) = match flag("--image") {
        Some(f) => (
            std::fs::read(&f).unwrap_or_else(|e| fail(format!("{f}: {e}"))),
            f,
        ),
        None => {
            let mut b = Vec::new();
            std::io::stdin()
                .read_to_end(&mut b)
                .unwrap_or_else(|e| fail(format!("reading the picture: {e}")));
            (b, "camera".to_string())
        }
    };
    let frame = image::load_from_memory(&bytes)
        .unwrap_or_else(|e| fail(format!("not a picture: {e}")))
        .to_rgb8();
    drop(bytes);

    let opts = bench::Options {
        models_dir,
        runs,
        engines,
        reference: flag("--reference").map(PathBuf::from),
        ort: flag("--ort").map(PathBuf::from),
        source,
    };
    match bench::run(&opts, frame, &mut emit) {
        Ok(result) => emit(result),
        Err(e) => fail(e),
    }
}
