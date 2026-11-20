//! The camera picker's live tiles: a small moving picture from each camera, and whether the
//! models can see a person in it, so the right camera is obvious.
//!
//! NVIDIA Broadcast needs the webcam to itself: opening the webcam directly, even for a moment,
//! knocks Broadcast off its source and it shows a crossed-out camera. So while a camera called
//! NVIDIA Broadcast is plugged in, only Broadcast is opened, unless the person asks for another.

use crate::session::jpeg;
use crate::worker::Live;
use lockin_capture::{CameraInfo, Stream};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub fn is_broadcast(name: &str) -> bool {
    name.to_lowercase().contains("nvidia broadcast")
}

/// Which cameras the picker may open by itself.
pub fn safe_to_open(all: &[CameraInfo]) -> Vec<CameraInfo> {
    if all.iter().any(|c| is_broadcast(&c.name)) {
        all.iter().filter(|c| is_broadcast(&c.name)).cloned().collect()
    } else {
        all.to_vec()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Tile {
    Picture { id: String, jpeg: String },
    /// Whether the models see a person in this camera's picture.
    Sees { id: String, person: bool },
    Problem { id: String, message: String },
}

pub struct Peek {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Peek {
    /// Opens each camera and sends a tile picture about four times a second. If a worker is
    /// given, each picture is also checked for a person every two seconds.
    pub fn start(cameras: Vec<CameraInfo>, worker: Option<(PathBuf, PathBuf, String)>, mut on_tile: impl FnMut(Tile) + Send + 'static) -> Peek {
        let stop = Arc::new(AtomicBool::new(false));
        let s = stop.clone();
        let thread = std::thread::Builder::new()
            .name("camera-picker".into())
            .spawn(move || {
                let mut open: Vec<(CameraInfo, Stream)> = Vec::new();
                for c in cameras {
                    match Stream::open(&c.id, 640, 480) {
                        Ok(st) => open.push((c, st)),
                        Err(e) => on_tile(Tile::Problem { id: c.id.clone(), message: e.to_string() }),
                    }
                }
                let mut models = worker.and_then(|(exe, dir, check)| Live::start(&exe, &dir, &check, false).ok());
                let mut last_look = Instant::now() - Duration::from_secs(10);
                while !s.load(Ordering::SeqCst) {
                    let look_now = last_look.elapsed() >= Duration::from_secs(2);
                    for (c, st) in &open {
                        match st.frame(Duration::from_millis(1500)) {
                            Ok(f) => {
                                if let Some(j) = jpeg(&f) {
                                    on_tile(Tile::Picture { id: c.id.clone(), jpeg: j });
                                }
                                if look_now {
                                    if let Some(m) = models.as_mut() {
                                        if let Ok(v) = m.look(&f, Duration::from_secs(10)) {
                                            on_tile(Tile::Sees { id: c.id.clone(), person: !v["person"].is_null() });
                                        }
                                    }
                                }
                            }
                            Err(e) => on_tile(Tile::Problem { id: c.id.clone(), message: e.to_string() }),
                        }
                    }
                    if look_now {
                        last_look = Instant::now();
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                // Streams and the worker drop here, so every camera light goes off.
            })
            .ok();
        Peek { stop, thread }
    }
}

impl Drop for Peek {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cam(name: &str) -> CameraInfo {
        CameraInfo { name: name.into(), id: name.into() }
    }

    #[test]
    fn broadcast_is_the_only_camera_opened_when_present() {
        let all = vec![cam("Integrated Camera"), cam("NVIDIA Broadcast"), cam("OBS Virtual Camera")];
        let names: Vec<String> = safe_to_open(&all).into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["NVIDIA Broadcast"]);
        let all = vec![cam("Integrated Camera"), cam("Logitech C920")];
        assert_eq!(safe_to_open(&all).len(), 2);
    }
}
