//! CI tool for the camera worker's sandbox.
//!
//!   sandbox-check probe PERSONAL_FILE
//!     Starts sandbox-probe in the sandbox and fails unless the network and the given file are
//!     blocked while the probe's own folder stays readable.
//!   sandbox-check run EXE [ARGS...]
//!     Runs EXE in the sandbox (granting its folder), passing our stdin to it and printing its
//!     output, so the camera speed test can be run exactly as the app runs it.
use std::io::{Read, Write};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("probe") => probe(args.get(1).expect("give a file the sandbox must not read")),
        Some("run") => run(&args[1..]),
        _ => {
            eprintln!("usage: sandbox-check probe FILE | run EXE [ARGS...]");
            std::process::exit(2);
        }
    }
}

fn probe(personal: &str) {
    let me = std::env::current_exe().unwrap();
    let dir = me.parent().unwrap();
    let probe = dir.join(if cfg!(windows) { "sandbox-probe.exe" } else { "sandbox-probe" });
    let mut child = lockin_sandbox::spawn(&probe, &[personal], dir).unwrap_or_else(|e| panic!("sandbox didn't start: {e}"));
    drop(child.stdin.take());
    let mut out = String::new();
    child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
    let code = child.wait().unwrap();
    println!("probe exit {code}: {out}");
    let v: serde_json::Value = serde_json::from_str(out.trim()).expect("probe printed no JSON");
    let mut ok = true;
    for (key, bad) in [("internet", "connected"), ("local", "connected"), ("personal_file", "read")] {
        let got = v[key].as_str().unwrap_or("");
        let pass = got != bad;
        println!("{}  {key}: {got}", if pass { "PASS" } else { "FAIL" });
        ok &= pass;
    }
    let own = v["own_folder"].as_str().unwrap_or("") == "listed";
    println!("{}  own folder readable", if own { "PASS" } else { "FAIL" });
    if !(ok && own) {
        std::process::exit(1);
    }
}

fn run(args: &[String]) {
    let exe = std::path::absolute(PathBuf::from(&args[0])).expect("bad program path");
    let dir = exe.parent().unwrap().to_path_buf();
    let rest: Vec<&str> = args[1..].iter().map(String::as_str).collect();
    let mut child = lockin_sandbox::spawn(&exe, &rest, &dir).unwrap_or_else(|e| panic!("sandbox didn't start: {e}"));
    let mut stdin = child.stdin.take().unwrap();
    let feeder = std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut stdin);
    });
    let mut err = child.stderr.take().unwrap();
    let errs = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let mut out = child.stdout.take().unwrap();
    let _ = std::io::copy(&mut out, &mut std::io::stdout().lock());
    let code = child.wait().unwrap();
    let _ = feeder.join();
    let e = errs.join().unwrap_or_default();
    if !e.is_empty() {
        let _ = writeln!(std::io::stderr(), "{e}");
    }
    std::process::exit(code as i32);
}
