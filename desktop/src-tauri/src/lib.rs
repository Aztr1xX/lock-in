//! Lock In desktop app, phase 0 test build.
//!
//! This build exists to prove three things on a real Windows PC before the real app is built:
//!   1. The camera and MediaPipe work inside the app's WebView2 window, without a prompt every time.
//!   2. Lock In Guard can block sites in every browser.
//!   3. Lock In Guard can close games.

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
    s.set_read_timeout(Some(Duration::from_secs(5))).ok();
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
        .invoke_handler(tauri::generate_handler![guard, guard_setup, about])
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
