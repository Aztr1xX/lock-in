//! Lock In Guard
//!
//! A tiny background service that does the two jobs a normal app can't:
//!   1. Blocks sites in every browser by writing them into the Windows hosts file during a round.
//!      Blocked names point back at the Guard, so it can see each attempt and tell the app.
//!   2. Closes games, including ones a normal app isn't allowed to touch.
//!
//! The app talks to it with one JSON line per connection on 127.0.0.1:47822.
//! Blocking always ends on time on its own, even if the app is closed or crashes.
//!
//! Usage:
//!   lockin-guard install     copy to Program Files, register and start the service (needs admin)
//!   lockin-guard uninstall   stop and remove the service, clean the hosts file (needs admin)
//!   lockin-guard run         run in the foreground, for testing
//!   lockin-guard service     what Windows runs; not for people

mod browsers;
mod hosts;
mod sni;

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Release builds stamp the app's version in, so the app can tell when the installed Guard is out of date.
pub const VERSION: &str = match option_env!("LOCKIN_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};
pub const CONTROL_ADDR: &str = "127.0.0.1:47822";
/// No single block can last longer than this, so a bad request can never lock you out for long.
const MAX_BLOCK_MIN: f64 = 240.0;
const MAX_ATTEMPTS: usize = 200;

// ---------- state ----------

#[derive(Default, Serialize, Deserialize, Clone)]
struct Saved {
    hosts: Vec<String>,
    /// Unix seconds when blocking ends. 0 = not blocking.
    until: u64,
    /// Registry values the browser layer added, so they are always removed again.
    #[serde(default)]
    touched: Vec<String>,
    /// Which extra layers took (Chrome, Edge, Firewall...), for the app to show.
    #[serde(default)]
    layers: Vec<String>,
}

#[derive(Serialize, Clone)]
struct Attempt {
    host: String,
    at: u64,
}

#[derive(Default)]
struct State {
    saved: Saved,
    attempts: Vec<Attempt>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(State::default()))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCKIN_GUARD_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("ProgramData").map(|p| PathBuf::from(p).join("LockIn")))
        .unwrap_or_else(|| std::env::temp_dir().join("LockIn"));
    let _ = std::fs::create_dir_all(&base);
    base
}

pub fn log(msg: &str) {
    let path = data_dir().join("guard.log");
    // Keep the log small: start over past 256 KB.
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", now(), msg);
    }
    if std::env::var_os("LOCKIN_GUARD_VERBOSE").is_some() {
        eprintln!("{msg}");
    }
}

fn save(s: &Saved) {
    if let Ok(json) = serde_json::to_string(s) {
        let _ = std::fs::write(data_dir().join("guard.json"), json);
    }
}

fn load() -> Saved {
    std::fs::read_to_string(data_dir().join("guard.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

// ---------- blocking ----------

fn start_block(names: &[String], minutes: f64) -> Result<Saved, String> {
    let list = hosts::expand(names);
    if list.is_empty() {
        return Err("no valid site names".into());
    }
    let minutes = minutes.clamp(0.1, MAX_BLOCK_MIN);
    // A new block replaces the old one completely.
    let old = std::mem::take(&mut state().lock().unwrap().saved.touched);
    browsers::clear(&old);
    hosts::write_block(&hosts_names(&list))?;
    hosts::flush_dns();
    let (touched, layers) = browsers::apply(&list);
    let mut st = state().lock().unwrap();
    st.saved = Saved { hosts: list, until: now() + (minutes * 60.0).round() as u64, touched, layers };
    save(&st.saved);
    log(&format!("block {} names for {minutes} min, layers: hosts {}", st.saved.hosts.len(), st.saved.layers.join(" ")));
    Ok(st.saved.clone())
}

/// What goes in the hosts file: the blocked sites plus the secure DNS resolvers.
fn hosts_names(sites: &[String]) -> Vec<String> {
    let mut all = sites.to_vec();
    all.extend(browsers::DOH_HOSTS.iter().map(|s| s.to_string()));
    all
}

fn stop_block(why: &str) {
    let touched = std::mem::take(&mut state().lock().unwrap().saved.touched);
    browsers::clear(&touched);
    if let Err(e) = hosts::clear_block() {
        log(&format!("could not clean hosts file: {e}"));
    }
    hosts::flush_dns();
    let mut st = state().lock().unwrap();
    if st.saved.until != 0 {
        log(&format!("unblock ({why})"));
    }
    st.saved = Saved::default();
    save(&st.saved);
}

fn is_blocked(host: &str) -> bool {
    let st = state().lock().unwrap();
    st.saved.until > now() && st.saved.hosts.iter().any(|h| h == host)
}

fn record_attempt(host: String) {
    let mut st = state().lock().unwrap();
    // One entry per site every 10 s, so a page with many requests counts once.
    let t = now();
    if st.attempts.iter().rev().take(20).any(|a| a.host == host && t.saturating_sub(a.at) < 10) {
        return;
    }
    st.attempts.push(Attempt { host, at: t });
    let n = st.attempts.len();
    if n > MAX_ATTEMPTS {
        st.attempts.drain(0..n - MAX_ATTEMPTS);
    }
}

/// Ends blocking on time, whether or not the app is still running.
fn ticker(stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Relaxed) {
        let due = {
            let st = state().lock().unwrap();
            st.saved.until != 0 && now() >= st.saved.until
        };
        if due {
            stop_block("time is up");
        }
        thread::sleep(Duration::from_secs(1));
    }
}

// ---------- games ----------

#[derive(Serialize)]
struct Proc {
    pid: u32,
    name: String,
    path: String,
}

/// Folders games are installed into by the big launchers.
const GAME_DIRS: &[&str] = &[
    "\\steamapps\\common\\",
    "\\epic games\\",
    "\\riot games\\",
    "\\battle.net\\",
    "\\ea games\\",
    "\\ubisoft game launcher\\games\\",
    "\\xboxgames\\",
    "\\gog galaxy\\games\\",
];

/// Launchers and helpers that live in those folders but aren't games.
const NOT_GAMES: &[&str] = &[
    "steam.exe", "steamwebhelper.exe", "epicgameslauncher.exe", "epicwebhelper.exe",
    "riotclientservices.exe", "riotclientux.exe", "riotclientuxrender.exe", "riotclientcrashhandler.exe",
    "battle.net.exe", "agent.exe", "eadesktop.exe", "upc.exe", "crashreporter.exe", "unitycrashhandler64.exe",
];

fn processes() -> sysinfo::System {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys
}

fn running_games() -> Vec<Proc> {
    let sys = processes();
    let mut out = vec![];
    for (pid, p) in sys.processes() {
        let Some(exe) = p.exe() else { continue };
        let path = exe.to_string_lossy().to_string();
        let low = path.to_lowercase();
        let name = p.name().to_string_lossy().to_string();
        if GAME_DIRS.iter().any(|d| low.contains(d)) && !NOT_GAMES.contains(&name.to_lowercase().as_str()) {
            out.push(Proc { pid: pid.as_u32(), name, path });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn kill_by_name(names: &[String]) -> Vec<Proc> {
    let want: Vec<String> = names.iter().map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty()).collect();
    let sys = processes();
    let mut killed = vec![];
    for (pid, p) in sys.processes() {
        let name = p.name().to_string_lossy().to_string();
        if want.contains(&name.to_lowercase()) && p.kill() {
            killed.push(Proc {
                pid: pid.as_u32(),
                name,
                path: p.exe().map(|e| e.to_string_lossy().to_string()).unwrap_or_default(),
            });
        }
    }
    if !killed.is_empty() {
        log(&format!("closed {} process(es)", killed.len()));
    }
    killed
}

// ---------- control protocol ----------

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Req {
    Status,
    Block { hosts: Vec<String>, minutes: f64 },
    Unblock,
    Kill { names: Vec<String> },
    Games,
}

fn handle(req: Req) -> serde_json::Value {
    use serde_json::json;
    match req {
        Req::Status => {
            let st = state().lock().unwrap();
            let blocking = st.saved.until > now();
            json!({
                "ok": true,
                "version": VERSION,
                "blocking": blocking,
                "hosts": if blocking { st.saved.hosts.clone() } else { vec![] },
                "secondsLeft": st.saved.until.saturating_sub(now()),
                "attempts": st.attempts,
                "sinkhole": sinkhole_ports(),
                "layers": if blocking { st.saved.layers.clone() } else { vec![] },
                // False if something (usually antivirus) took the block back out of the hosts file.
                "hostsOk": !blocking || hosts::has_block(),
            })
        }
        Req::Block { hosts, minutes } => match start_block(&hosts, minutes) {
            Ok(s) => json!({ "ok": true, "hosts": s.hosts, "secondsLeft": s.until.saturating_sub(now()) }),
            Err(e) => json!({ "ok": false, "error": e }),
        },
        Req::Unblock => {
            stop_block("asked by app");
            json!({ "ok": true })
        }
        Req::Kill { names } => json!({ "ok": true, "killed": kill_by_name(&names) }),
        Req::Games => json!({ "ok": true, "games": running_games() }),
    }
}

fn serve_control(stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut line = String::new();
    // One line, at most 64 KB. Anything that isn't a JSON object (a browser poking the port) is dropped.
    if reader.by_ref().take(64 * 1024).read_line(&mut line).is_err() || !line.trim_start().starts_with('{') {
        return;
    }
    let reply = match serde_json::from_str::<Req>(line.trim()) {
        Ok(req) => handle(req),
        Err(e) => serde_json::json!({ "ok": false, "error": format!("bad request: {e}") }),
    };
    let mut out = stream;
    let _ = writeln!(out, "{reply}");
}

fn control_server() {
    match TcpListener::bind(CONTROL_ADDR) {
        Ok(l) => {
            for s in l.incoming().flatten() {
                thread::spawn(move || serve_control(s));
            }
        }
        Err(e) => log(&format!("control port busy: {e}")),
    }
}

// ---------- sinkhole: where blocked sites land ----------

static SINK_PORTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn sinkhole_ports() -> Vec<String> {
    SINK_PORTS.lock().unwrap().clone()
}

const BLOCKED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Blocked by Lock In</title>\
<body style=\"font:18px system-ui;background:#f3ead8;color:#2c3a2a;display:grid;place-items:center;height:100vh;margin:0\">\
<div style=\"text-align:center\"><h1 style=\"font-weight:600\">Locked in.</h1><p>This site is off until your round ends.</p></div>";

fn serve_sink(mut stream: TcpStream, tls: bool) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).unwrap_or(0);
    let data = &buf[..n];
    let host = if tls { sni::server_name(data) } else { sni::http_host(data) };
    if let Some(h) = host {
        if is_blocked(&h) {
            record_attempt(h);
        }
    }
    if !tls {
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
            BLOCKED_PAGE.len(),
            BLOCKED_PAGE
        );
    }
    // For HTTPS we just close: the browser shows its own "can't reach this site" page.
}

fn sinkhole(addr: &'static str, tls: bool) {
    match TcpListener::bind(addr) {
        Ok(l) => {
            SINK_PORTS.lock().unwrap().push(addr.to_string());
            for s in l.incoming().flatten() {
                thread::spawn(move || serve_sink(s, tls));
            }
        }
        Err(e) => log(&format!("sinkhole {addr} not available: {e}")),
    }
}

// ---------- running ----------

/// Starts every worker thread. Returns a flag that stops the ticker.
pub fn start_workers() -> Arc<AtomicBool> {
    // Pick up where we left off after a restart or crash.
    let saved = load();
    if saved.until > now() {
        state().lock().unwrap().saved = saved.clone();
        let _ = hosts::write_block(&hosts_names(&saved.hosts));
        hosts::flush_dns();
        log("resumed a block after restart");
    } else {
        state().lock().unwrap().saved = saved;
        stop_block("startup clean");
    }
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    thread::spawn(move || ticker(s2));
    thread::spawn(control_server);
    for (addr, tls) in [("127.0.0.1:80", false), ("127.0.0.1:443", true), ("[::1]:80", false), ("[::1]:443", true)] {
        thread::spawn(move || sinkhole(addr, tls));
    }
    log(&format!("guard {VERSION} started"));
    stop
}

pub fn shutdown(stop: &AtomicBool) {
    stop.store(true, Ordering::Relaxed);
    stop_block("guard stopping");
    log("guard stopped");
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    let result: Result<(), String> = match arg.as_str() {
        "run" => {
            let stop = start_workers();
            println!("Lock In Guard {VERSION} running on {CONTROL_ADDR}. Press Ctrl+C to stop.");
            loop {
                thread::sleep(Duration::from_secs(3600));
                if stop.load(Ordering::Relaxed) {
                    break;
                }
            }
            Ok(())
        }
        #[cfg(windows)]
        "service" => service::run(),
        #[cfg(windows)]
        "install" => service::install(),
        #[cfg(windows)]
        "uninstall" => service::uninstall(),
        _ => {
            println!("Lock In Guard {VERSION}\nusage: lockin-guard install | uninstall | run");
            Ok(())
        }
    };
    if let Err(e) = result {
        log(&format!("error: {e}"));
        eprintln!("{e}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod service {
    use super::*;
    use std::ffi::OsString;
    use std::sync::mpsc;
    use windows_service::service::{
        ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode, ServiceInfo,
        ServiceStartType, ServiceState, ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
    use windows_service::{define_windows_service, service_dispatcher};

    pub const NAME: &str = "LockInGuard";

    define_windows_service!(ffi_service_main, service_main);

    pub fn run() -> Result<(), String> {
        service_dispatcher::start(NAME, ffi_service_main).map_err(|e| e.to_string())
    }

    fn service_main(_args: Vec<OsString>) {
        if let Err(e) = run_service() {
            log(&format!("service failed: {e}"));
        }
    }

    fn status(state: ServiceState) -> ServiceStatus {
        ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: if state == ServiceState::Running {
                ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
            } else {
                ServiceControlAccept::empty()
            },
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(5),
            process_id: None,
        }
    }

    fn run_service() -> windows_service::Result<()> {
        let (tx, rx) = mpsc::channel();
        let handler = move |ev| match ev {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let handle = service_control_handler::register(NAME, handler)?;
        handle.set_service_status(status(ServiceState::Running))?;
        let stop = start_workers();
        let _ = rx.recv();
        handle.set_service_status(status(ServiceState::StopPending))?;
        shutdown(&stop);
        handle.set_service_status(status(ServiceState::Stopped))?;
        Ok(())
    }

    fn install_dir() -> PathBuf {
        let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
        pf.join("Lock In Guard")
    }

    fn wait_for(svc: &windows_service::service::Service, want: ServiceState) {
        for _ in 0..50 {
            if svc.query_status().map(|s| s.current_state == want).unwrap_or(true) {
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    /// Copies the Guard to Program Files (so only admins can change the file Windows runs as SYSTEM),
    /// then registers and starts it. Running it again updates an existing install.
    pub fn install() -> Result<(), String> {
        let e = |x: windows_service::Error| x.to_string();
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)
            .map_err(|x| format!("needs admin: {x}"))?;
        let access = ServiceAccess::QUERY_STATUS | ServiceAccess::START | ServiceAccess::STOP | ServiceAccess::CHANGE_CONFIG;
        let existing = manager.open_service(NAME, access).ok();
        if let Some(svc) = &existing {
            let _ = svc.stop();
            wait_for(svc, ServiceState::Stopped);
        }
        let dir = install_dir();
        std::fs::create_dir_all(&dir).map_err(|x| x.to_string())?;
        let dest = dir.join("lockin-guard.exe");
        let me = std::env::current_exe().map_err(|x| x.to_string())?;
        if me != dest {
            std::fs::copy(&me, &dest).map_err(|x| format!("copy failed: {x}"))?;
        }
        let info = ServiceInfo {
            name: NAME.into(),
            display_name: "Lock In Guard".into(),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: dest,
            launch_arguments: vec!["service".into()],
            dependencies: vec![],
            account_name: None, // LocalSystem
            account_password: None,
        };
        let svc = match existing {
            Some(svc) => {
                svc.change_config(&info).map_err(e)?;
                svc
            }
            None => manager.create_service(&info, access).map_err(e)?,
        };
        let _ = svc.set_description("Blocks distracting sites and closes games during Lock In focus rounds.");
        svc.start::<&str>(&[]).map_err(e)?;
        wait_for(&svc, ServiceState::Running);
        println!("Lock In Guard installed and running.");
        Ok(())
    }

    pub fn uninstall() -> Result<(), String> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|x| format!("needs admin: {x}"))?;
        let svc = manager
            .open_service(NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE)
            .map_err(|x| x.to_string())?;
        let _ = svc.stop();
        wait_for(&svc, ServiceState::Stopped);
        svc.delete().map_err(|x| x.to_string())?;
        // Belt and braces: the hosts file is clean even if the service never got to stop itself.
        browsers::clear(&load().touched);
        save(&Saved::default());
        let _ = hosts::clear_block();
        hosts::flush_dns();
        println!("Lock In Guard removed.");
        Ok(())
    }
}
