//! Lock In desktop app, phase 0 test build.
//!
//! This build exists to prove three things on a real Windows PC before the real app is built:
//!   1. The camera and MediaPipe work inside the app's WebView2 window, without a prompt every time.
//!   2. Lock In Guard can block sites in every browser.
//!   3. Lock In Guard can close games.
//!
//! Camera plan step 1 adds the camera speed test, run by the separate camera worker
//! (`lockin-camera.exe`, see ../camera), which has no network code.

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
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let worker = exe.with_file_name(if cfg!(windows) { "lockin-camera.exe" } else { "lockin-camera" });
    let models = app.path().resource_dir().map_err(|e| e.to_string())?.join("models");
    if !worker.exists() || !models.join("manifest.json").exists() {
        return Err("The camera models aren't installed. Reinstall Lock In from the latest release.".into());
    }
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
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::path::Path;
    use std::process::{Command, Stdio};
    use tauri::Emitter;

    type Pipes = (Box<dyn Write + Send>, Box<dyn Read + Send>, Box<dyn Read + Send>);

    /// Starts the worker inside its sandbox (no network, camera or personal files). If Windows
    /// refuses the sandbox, it runs as a normal background process instead, which still has no
    /// network code, and the result says so.
    fn start(worker: &Path, models: &Path) -> Result<(Pipes, Box<dyn FnOnce() -> String + Send>, Value), String> {
        let models_arg = models.to_string_lossy().to_string();
        let dir = worker.parent().unwrap_or(Path::new("."));
        match lockin_sandbox::spawn(worker, &["bench", "--models", &models_arg], dir) {
            Ok(mut child) => {
                let pipes: Pipes = (
                    Box::new(child.stdin.take().ok_or("no pipe")?),
                    Box::new(child.stdout.take().ok_or("no pipe")?),
                    Box::new(child.stderr.take().ok_or("no pipe")?),
                );
                let wait = Box::new(move || child.wait().map(|c| format!("exit code {c}")).unwrap_or_else(|e| e));
                Ok((pipes, wait, json!({ "on": true })))
            }
            Err(why) => {
                let mut cmd = Command::new(worker);
                cmd.arg("bench").arg("--models").arg(models).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                    cmd.creation_flags(CREATE_NO_WINDOW);
                }
                let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the camera worker: {e}"))?;
                let pipes: Pipes = (
                    Box::new(child.stdin.take().ok_or("no pipe")?),
                    Box::new(child.stdout.take().ok_or("no pipe")?),
                    Box::new(child.stderr.take().ok_or("no pipe")?),
                );
                let wait = Box::new(move || child.wait().map(|s| s.to_string()).unwrap_or_else(|e| e.to_string()));
                Ok((pipes, wait, json!({ "on": false, "error": why })))
            }
        }
    }

    pub fn bench(app: &tauri::AppHandle, worker: &Path, models: &Path, frame: Vec<u8>) -> Result<Value, String> {
        let ((mut stdin, stdout, mut stderr), wait, sandbox) = start(worker, models)?;
        std::thread::spawn(move || {
            let _ = stdin.write_all(&frame);
        });
        let errs = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });
        let mut result: Option<Value> = None;
        let mut error: Option<String> = None;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            match v["type"].as_str() {
                Some("progress") => {
                    let _ = app.emit("camera-bench", &v);
                }
                Some("result") => result = Some(v),
                Some("error") => error = v["message"].as_str().map(str::to_string),
                _ => {}
            }
        }
        let status = wait();
        let stderr = errs.join().unwrap_or_default();
        match (result, error) {
            (Some(mut r), _) => {
                r["sandbox"] = sandbox;
                Ok(r)
            }
            (None, Some(e)) => Err(e),
            (None, None) => {
                let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
                Err(format!("The camera worker stopped ({status}){}", if tail.is_empty() { String::new() } else { format!(": {tail}") }))
            }
        }
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
        .invoke_handler(tauri::generate_handler![guard, guard_setup, about, bring_forward, camera_bench])
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
        .on_window_event(|window, ev| {
            if let WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Lock In");
}
