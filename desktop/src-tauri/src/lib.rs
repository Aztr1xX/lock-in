//! Lock In desktop app, phase 0 test build.
//!
//! This build exists to prove three things on a real Windows PC before the real app is built:
//!   1. The camera and MediaPipe work inside the app's WebView2 window, without a prompt every time.
//!   2. Lock In Guard can block sites in every browser.
//!   3. Lock In Guard can close games.
//!
//! Camera plan step 1 adds the camera speed test, run by the separate camera worker
//! (`lockin-camera.exe`, see ../camera), which has no network code. Step 2 adds the live camera
//! check (see ../live), read by this process so it keeps going while the window is minimised.

use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, WindowEvent};

const GUARD_ADDR: &str = "127.0.0.1:47822";

/// Sends one request to the Guard and returns its reply.
#[tauri::command]
fn guard(req: Value) -> Result<Value, String> {
    let addr: SocketAddr = GUARD_ADDR.parse().unwrap();
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).map_err(|_| "not running".to_string())?;
    // Study YouTube searches load several pages, so allow them time.
    s.set_read_timeout(Some(Duration::from_secs(30))).ok();
    writeln!(s, "{req}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).map_err(|e| e.to_string())?;
    serde_json::from_str(&line).map_err(|e| format!("bad reply: {e}"))
}

/// Runs the bundled Guard with "install" or "uninstall", through the Windows admin prompt.
#[tauri::command]
async fn guard_setup(action: String) -> Result<String, String> {
    if action != "install" && action != "uninstall" {
        return Err("unknown action".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let guard = exe.with_file_name(if cfg!(windows) { "lockin-guard.exe" } else { "lockin-guard" });
    if !guard.exists() {
        return Err(format!("Guard not found next to the app ({})", guard.display()));
    }
    tauri::async_runtime::spawn_blocking(move || elevated::run(&guard, &action))
        .await
        .map_err(|e| e.to_string())?
}

/// Only one speed test at a time: it uses every core it can get.
static BENCH_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Runs the camera speed test in the camera worker. The frame (PNG bytes) arrives in memory and
/// is handed to the worker through a pipe, so it never touches the disk. Progress is sent to the
/// window as "camera-bench" events; the result comes back as the reply.
#[tauri::command]
async fn camera_bench(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    use std::sync::atomic::Ordering;
    let frame = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("The speed test needs a camera picture.".into()),
    };
    drop(request);
    let (worker, models) = live::paths(&app)?;
    if BENCH_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A speed test is already running.".into());
    }
    let result = tauri::async_runtime::spawn_blocking(move || camera_worker::bench(&app, &worker, &models, frame))
        .await
        .map_err(|e| e.to_string());
    BENCH_RUNNING.store(false, Ordering::SeqCst);
    result?
}

mod camera_worker {
    use lockin_live::worker::Process;
    use serde_json::{json, Value};
    use std::path::Path;
    use std::time::Duration;
    use tauri::Emitter;

    pub fn bench(app: &tauri::AppHandle, worker: &Path, models: &Path, frame: Vec<u8>) -> Result<Value, String> {
        let models_arg = models.to_string_lossy().to_string();
        let mut p = Process::start(worker, &["bench", "--models", &models_arg])?;
        let sandbox = json!(p.sandbox);
        p.write(&frame)?;
        p.close_input();
        let mut result: Option<Value> = None;
        let mut error: Option<String> = None;
        // The first answer can take a while (loading every model); later ones come quickly.
        match p.next(Duration::from_secs(300)) {
            Ok(v) => handle(app, v, &mut result, &mut error),
            Err(e) => error = Some(e),
        }
        for v in p.rest() {
            handle(app, v, &mut result, &mut error);
        }
        let status = p.wait();
        match (result, error) {
            (Some(mut r), _) => {
                r["sandbox"] = sandbox;
                Ok(r)
            }
            (None, Some(e)) => Err(e),
            (None, None) => {
                let tail = p.stderr_tail();
                Err(format!("The camera worker stopped ({status}){}", if tail.is_empty() { String::new() } else { format!(": {tail}") }))
            }
        }
    }

    fn handle(app: &tauri::AppHandle, v: Value, result: &mut Option<Value>, error: &mut Option<String>) {
        match v["type"].as_str() {
            Some("progress") => {
                let _ = app.emit("camera-bench", &v);
            }
            Some("result") => *result = Some(v),
            Some("error") => *error = v["message"].as_str().map(str::to_string),
            _ => {}
        }
    }
}

/// The live camera check (camera plan, step 2): the camera is read by this process, frames go to
/// the sandboxed worker, and the results go to the window as "camera-live" events. It keeps
/// running with the window minimised or hidden in the tray.
mod live {
    use lockin_capture::CameraInfo;
    use lockin_live::peek::{self, Peek};
    use lockin_live::rules::Settings;
    use lockin_live::session::{Options, Session};
    use serde::Deserialize;
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tauri::{Emitter, Manager};

    static SESSION: Mutex<Option<Session>> = Mutex::new(None);
    static PEEK: Mutex<Option<Peek>> = Mutex::new(None);
    /// Whether the window is minimised or hidden in the tray. Kept up to date from window events
    /// on the main thread, so the camera thread never has to ask the window (and wait on it).
    pub static HIDDEN: AtomicBool = AtomicBool::new(false);

    pub fn paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let worker = exe.with_file_name(if cfg!(windows) { "lockin-camera.exe" } else { "lockin-camera" });
        let models = app.path().resource_dir().map_err(|e| e.to_string())?.join("models");
        if !worker.exists() || !models.join("manifest.json").exists() {
            return Err("The camera models aren't installed. Reinstall Lock In from the latest release.".into());
        }
        Ok((worker, models))
    }

    #[tauri::command]
    pub fn camera_list() -> Result<Value, String> {
        let all = lockin_capture::list().map_err(|e| e.to_string())?;
        let safe = peek::safe_to_open(&all);
        Ok(json!(all
            .iter()
            .map(|c| json!({ "name": c.name, "id": c.id, "broadcast": peek::is_broadcast(&c.name), "auto": safe.contains(c) }))
            .collect::<Vec<_>>()))
    }

    /// The full checks whose models are all installed, fastest-first as listed in the manifest.
    #[tauri::command]
    pub fn camera_checks(app: tauri::AppHandle) -> Result<Value, String> {
        let (_, models) = paths(&app)?;
        let m: Value = serde_json::from_slice(&std::fs::read(models.join("manifest.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let have = |id: &str| m["models"].as_array().into_iter().flatten().find(|x| x["id"] == id).and_then(|x| x["file"].as_str()).is_some_and(|f| models.join(f).exists());
        let ok: Vec<&str> = m["checks"].as_array().into_iter().flatten().filter(|c| ["frame", "hands", "pose"].iter().all(|k| c[k].as_str().is_some_and(|id| have(id)))).filter_map(|c| c["name"].as_str()).collect();
        Ok(json!(ok))
    }

    #[derive(Deserialize)]
    pub struct Start {
        camera_id: String,
        camera_name: String,
        check: String,
        gpu: bool,
        phone: bool,
    }

    #[tauri::command]
    pub async fn camera_live_start(app: tauri::AppHandle, opts: Start) -> Result<(), String> {
        let (worker, models) = paths(&app)?;
        // One camera user at a time: the picker lets go first.
        PEEK.lock().unwrap().take();
        tauri::async_runtime::spawn_blocking(move || {
            let mut slot = SESSION.lock().unwrap();
            slot.take(); // stops a running session (and waits for its camera to close)
            let o = Options {
                camera_id: opts.camera_id,
                camera_name: opts.camera_name,
                worker,
                models,
                check: opts.check,
                gpu: opts.gpu,
                settings: Settings { phone: opts.phone, ..Settings::default() },
            };
            let emitter = app.clone();
            let hidden = || HIDDEN.load(Ordering::Relaxed);
            *slot = Some(Session::start(o, move |u| { let _ = emitter.emit("camera-live", &u); }, hidden));
        })
        .await
        .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn camera_live_stop() -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(|| {
            SESSION.lock().unwrap().take();
        })
        .await
        .map_err(|e| e.to_string())
    }

    // These two are async so they run off the main thread: the lock can be held for a moment
    // while a session stops.
    #[tauri::command]
    pub async fn camera_live_preview(on: bool) -> Result<(), String> {
        if let Some(s) = SESSION.lock().unwrap().as_ref() {
            s.set_preview(on);
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn camera_live_running() -> Result<bool, String> {
        Ok(SESSION.lock().unwrap().as_ref().is_some_and(Session::is_running))
    }

    /// Starts the picker's live tiles for these cameras (ids from camera_list). Stops a running
    /// live check first, since both would want the camera.
    #[tauri::command]
    pub async fn camera_peek_start(app: tauri::AppHandle, ids: Vec<String>, check: Option<String>) -> Result<(), String> {
        let all = lockin_capture::list().map_err(|e| e.to_string())?;
        let cams: Vec<CameraInfo> = all.into_iter().filter(|c| ids.contains(&c.id)).collect();
        let worker = match (paths(&app), check) {
            (Ok((w, m)), Some(c)) => Some((w, m, c)),
            _ => None,
        };
        tauri::async_runtime::spawn_blocking(move || {
            SESSION.lock().unwrap().take();
            let mut slot = PEEK.lock().unwrap();
            slot.take();
            let emitter = app.clone();
            *slot = Some(Peek::start(cams, worker, move |t| { let _ = emitter.emit("camera-peek", &t); }));
        })
        .await
        .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn camera_peek_stop() -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(|| {
            PEEK.lock().unwrap().take();
        })
        .await
        .map_err(|e| e.to_string())
    }

    pub fn window_changed(w: &tauri::Window) {
        HIDDEN.store(w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true), Ordering::Relaxed);
    }
}

#[tauri::command]
fn about(app: tauri::AppHandle) -> Value {
    serde_json::json!({
        "app": app.package_info().version.to_string(),
        "webview": tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        "os": std::env::consts::OS,
    })
}

#[cfg(windows)]
mod elevated {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn run(exe: &Path, arg: &str) -> Result<String, String> {
        let verb = wide("runas".as_ref());
        let file = wide(exe.as_os_str());
        let params = wide(arg.as_ref());
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        unsafe {
            ShellExecuteExW(&mut info).map_err(|_| "The admin prompt was cancelled.".to_string())?;
            if info.hProcess.is_invalid() {
                return Err("Could not start the Guard installer.".into());
            }
            let waited = WaitForSingleObject(info.hProcess, 60_000);
            let mut code = 1u32;
            let _ = GetExitCodeProcess(info.hProcess, &mut code);
            let _ = CloseHandle(info.hProcess);
            if waited != WAIT_OBJECT_0 {
                return Err("The Guard installer took too long.".into());
            }
            if code == 0 {
                Ok(format!("{arg} done"))
            } else {
                Err(format!("{arg} failed (code {code}). Details are in C:\\ProgramData\\LockIn\\guard.log"))
            }
        }
    }
}

#[cfg(not(windows))]
mod elevated {
    pub fn run(_exe: &std::path::Path, _arg: &str) -> Result<String, String> {
        Err("The Guard only installs on Windows.".into())
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        live::HIDDEN.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Brings the window to the front when a round closes an app, so the person sees why.
/// Windows often refuses plain focus requests from background apps, so the window is kept on
/// top for a moment as well.
#[tauri::command]
fn bring_forward(app: tauri::AppHandle) {
    show_main(&app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(true);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            let _ = w.set_always_on_top(false);
        });
    }
}

pub fn run() {
    tauri::Builder::default()
        // Updates: the app checks GitHub for a newer signed version and installs it itself.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // The camera is allowed for the app's own window without asking every time.
        // The microphone and everything else keep the normal behaviour.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Camera => PermissionResponse::Allow,
            PermissionKind::Microphone => PermissionResponse::Deny,
            _ => PermissionResponse::Default,
        })
        .invoke_handler(tauri::generate_handler![
            guard,
            guard_setup,
            about,
            bring_forward,
            camera_bench,
            live::camera_list,
            live::camera_checks,
            live::camera_live_start,
            live::camera_live_stop,
            live::camera_live_preview,
            live::camera_live_running,
            live::camera_peek_start,
            live::camera_peek_stop
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Open Lock In", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Lock In (in development)")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "show" => show_main(app),
                    // Quitting ends the camera worker too (its job object closes with the app).
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        // Closing the window hides it to the tray, the way the real app will behave.
        .on_window_event(|window, ev| match ev {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
                live::HIDDEN.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            WindowEvent::Resized(_) | WindowEvent::Focused(_) | WindowEvent::Moved(_) => live::window_changed(window),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Lock In");
}
