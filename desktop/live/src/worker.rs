//! Starting the camera worker and talking to it.
//!
//! The worker runs inside its sandbox (no network, camera or personal files). If Windows refuses
//! the sandbox it runs as a normal background process instead, which still has no network code,
//! and the app says so rather than pretending.

use lockin_capture::Frame;
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct SandboxState {
    pub on: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

enum Handle {
    Sandboxed(lockin_sandbox::Sandboxed),
    Plain(Child),
}

type Started = (
    Handle,
    Box<dyn Write + Send>,
    Box<dyn Read + Send>,
    Box<dyn Read + Send>,
    SandboxState,
);

/// A running worker. Dropping it ends the process.
pub struct Process {
    handle: Handle,
    stdin: Option<Box<dyn Write + Send>>,
    lines: Receiver<String>,
    stderr: Arc<Mutex<Vec<String>>>,
    pub sandbox: SandboxState,
}

impl Process {
    /// Starts `exe args`, letting the sandbox read the exe's own folder (its DLLs and models).
    pub fn start(exe: &Path, args: &[&str]) -> Result<Process, String> {
        let dir = exe.parent().unwrap_or(Path::new("."));
        let (handle, stdin, stdout, stderr, sandbox): Started =
            match lockin_sandbox::spawn(exe, args, dir) {
                Ok(mut c) => {
                    let (i, o, e) = (
                        c.stdin.take().ok_or("no pipe")?,
                        c.stdout.take().ok_or("no pipe")?,
                        c.stderr.take().ok_or("no pipe")?,
                    );
                    (
                        Handle::Sandboxed(c),
                        Box::new(i),
                        Box::new(o),
                        Box::new(e),
                        SandboxState {
                            on: true,
                            error: None,
                        },
                    )
                }
                Err(why) => {
                    let mut cmd = Command::new(exe);
                    cmd.args(args)
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped());
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
                        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
                    }
                    let mut c = cmd
                        .spawn()
                        .map_err(|e| format!("Couldn't start the camera worker: {e}"))?;
                    let (i, o, e) = (
                        c.stdin.take().ok_or("no pipe")?,
                        c.stdout.take().ok_or("no pipe")?,
                        c.stderr.take().ok_or("no pipe")?,
                    );
                    (
                        Handle::Plain(c),
                        Box::new(i),
                        Box::new(o),
                        Box::new(e),
                        SandboxState {
                            on: false,
                            error: Some(why),
                        },
                    )
                }
            };
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let err_lines = Arc::new(Mutex::new(Vec::new()));
        let keep = err_lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut k = keep.lock().unwrap();
                if k.len() == 20 {
                    k.remove(0);
                }
                k.push(line);
            }
        });
        Ok(Process {
            handle,
            stdin: Some(stdin),
            lines,
            stderr: err_lines,
            sandbox,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        let w = self
            .stdin
            .as_mut()
            .ok_or("the camera worker's input is closed")?;
        w.write_all(bytes)
            .and_then(|_| w.flush())
            .map_err(|_| self.why_stopped())
    }

    /// Closes the worker's input, which tells it there is nothing more.
    pub fn close_input(&mut self) {
        self.stdin = None;
    }

    /// The next JSON line, waiting at most `timeout`.
    pub fn next(&mut self, timeout: Duration) -> Result<Value, String> {
        loop {
            match self.lines.recv_timeout(timeout) {
                Ok(line) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        return Ok(v);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err("The camera worker took too long to answer".into())
                }
                Err(RecvTimeoutError::Disconnected) => return Err(self.why_stopped()),
            }
        }
    }

    /// Every remaining line until the worker exits.
    pub fn rest(&mut self) -> impl Iterator<Item = Value> + '_ {
        self.lines
            .iter()
            .filter_map(|l| serde_json::from_str(&l).ok())
    }

    fn why_stopped(&self) -> String {
        let tail: Vec<String> = self
            .stderr
            .lock()
            .unwrap()
            .iter()
            .rev()
            .take(3)
            .cloned()
            .collect();
        if tail.is_empty() {
            "The camera worker stopped".into()
        } else {
            format!("The camera worker stopped: {}", tail.join(" / "))
        }
    }

    /// Waits for the process to end; returns how it ended.
    pub fn wait(&mut self) -> String {
        match &mut self.handle {
            Handle::Sandboxed(s) => s
                .wait()
                .map(|c| format!("exit code {c}"))
                .unwrap_or_else(|e| e),
            Handle::Plain(c) => c
                .wait()
                .map(|s| s.to_string())
                .unwrap_or_else(|e| e.to_string()),
        }
    }

    /// The stderr lines kept so far (for error messages).
    pub fn stderr_tail(&self) -> String {
        self.stderr
            .lock()
            .unwrap()
            .iter()
            .rev()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(" / ")
    }

    /// CPU time the worker has used, in milliseconds (Windows only).
    pub fn cpu_ms(&self) -> Option<f64> {
        match &self.handle {
            Handle::Sandboxed(s) => s.cpu_ms(),
            #[cfg(windows)]
            Handle::Plain(c) => {
                use std::os::windows::io::AsRawHandle;
                lockin_sandbox::cpu_ms(Some(c.as_raw_handle()))
            }
            #[cfg(not(windows))]
            Handle::Plain(_) => None,
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.stdin = None;
        if let Handle::Plain(c) = &mut self.handle {
            let _ = c.kill();
            let _ = c.wait();
        }
        // A sandboxed worker ends when its job object closes (lockin-sandbox).
    }
}

/// The worker in live mode: one frame in, what the models saw out.
pub struct Live {
    process: Process,
    /// "gpu" or "cpu": where the models ended up running.
    pub engine: String,
    pub check: String,
}

impl Live {
    pub fn start(exe: &Path, models: &Path, check: &str, gpu: bool) -> Result<Live, String> {
        let models_arg = models.to_string_lossy().to_string();
        let mut args = vec!["run", "--models", &models_arg, "--check", check];
        if gpu {
            args.push("--gpu");
        }
        let mut process = Process::start(exe, &args)?;
        // Loading the models takes a second or two; the graphics chip can take longer the first time.
        let ready = process.next(Duration::from_secs(90))?;
        match ready["type"].as_str() {
            Some("ready") => Ok(Live {
                engine: ready["engine"].as_str().unwrap_or("cpu").to_string(),
                check: check.to_string(),
                process,
            }),
            Some("error") => Err(ready["message"]
                .as_str()
                .unwrap_or("the camera worker failed")
                .to_string()),
            _ => Err(format!("unexpected answer from the camera worker: {ready}")),
        }
    }

    pub fn sandbox(&self) -> &SandboxState {
        &self.process.sandbox
    }

    pub fn cpu_ms(&self) -> Option<f64> {
        self.process.cpu_ms()
    }

    /// Sends one frame and waits for the answer.
    pub fn look(&mut self, f: &Frame, timeout: Duration) -> Result<Value, String> {
        let mut msg = Vec::with_capacity(8 + f.rgb.len());
        msg.extend_from_slice(&f.width.to_le_bytes());
        msg.extend_from_slice(&f.height.to_le_bytes());
        msg.extend_from_slice(&f.rgb);
        self.process.write(&msg)?;
        let v = self.process.next(timeout)?;
        match v["type"].as_str() {
            Some("frame") => Ok(v),
            Some("frame_error") | Some("error") => Err(v["message"]
                .as_str()
                .unwrap_or("the models failed on a frame")
                .to_string()),
            _ => Err(format!("unexpected answer from the camera worker: {v}")),
        }
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        // A zero-width frame asks the worker to stop by itself.
        let _ = self.process.write(&[0u8; 8]);
    }
}
