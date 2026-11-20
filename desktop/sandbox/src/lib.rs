//! Runs the camera worker in a Windows AppContainer, the sandbox Windows uses for Store apps.
//!
//! The container is given no capabilities at all, so Windows itself refuses the worker any
//! network connection, the camera, the microphone and the person's files. The only things it
//! can read are its own folder (the exe, ONNX Runtime and the models, granted below) and the
//! system's own files. Frames reach it through a pipe from the app, and numbers come back the
//! same way.
//!
//! Together with the worker having no network code compiled in, this means a bug or a
//! tampered model still can't send a picture anywhere.

use std::fs::File;
#[cfg(not(windows))]
use std::path::Path;

/// The container's name. Windows keeps one profile per name for each user.
pub const CONTAINER: &str = "LockIn.CameraWorker";

/// A running sandboxed process with its three pipes. Dropping it ends the process.
pub struct Sandboxed {
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    pub stderr: Option<File>,
    #[cfg(windows)]
    inner: win::Handles,
}

#[cfg(windows)]
mod win;

#[cfg(windows)]
pub use win::spawn;

/// CPU time a process has used so far (user plus kernel), in milliseconds. Pass `None` for the
/// calling process itself.
#[cfg(windows)]
pub fn cpu_ms(process: Option<std::os::windows::io::RawHandle>) -> Option<f64> {
    win::cpu_ms(process)
}

#[cfg(not(windows))]
pub fn cpu_ms(_process: Option<()>) -> Option<f64> {
    None
}

#[cfg(not(windows))]
pub fn spawn(_exe: &Path, _args: &[&str], _grant: &Path) -> Result<Sandboxed, String> {
    Err("the sandbox is Windows-only".into())
}

impl Sandboxed {
    /// CPU time the sandboxed process has used so far, in milliseconds.
    pub fn cpu_ms(&self) -> Option<f64> {
        #[cfg(windows)]
        {
            win::cpu_ms(Some(self.inner.process_handle()))
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    /// Waits for the process to end and returns its exit code.
    pub fn wait(&mut self) -> Result<u32, String> {
        #[cfg(windows)]
        {
            self.inner.wait()
        }
        #[cfg(not(windows))]
        {
            Err("not supported".into())
        }
    }
}

/// Quotes one argument the way Windows' command-line parser expects.
pub fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::quote;

    #[test]
    fn quoting() {
        assert_eq!(quote("bench"), "bench");
        assert_eq!(quote(r"C:\Program Files\Lock In\models"), r#""C:\Program Files\Lock In\models""#);
        assert_eq!(quote(r"C:\a b\"), r#""C:\a b\\""#);
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote(""), r#""""#);
    }
}

// The app waits for the worker on another thread, so a running sandbox must be sendable.
const _: fn() = || {
    fn sendable<T: Send>() {}
    sendable::<Sandboxed>();
};
