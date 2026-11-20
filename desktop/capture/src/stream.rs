//! A camera read on its own thread, always holding the newest frame.
//!
//! The checks only want two frames a second, but a camera keeps sending 15 to 30. Reading on
//! demand would hand over a frame that has been waiting in a queue; instead this thread takes
//! every frame as it arrives (cheap: it is only kept, not converted) and converts the newest one
//! when asked. If no frame arrives in time the camera has frozen, which the health check reports.

use crate::{CaptureError, Frame, Source, Stopper};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Reply = Sender<Result<Frame, CaptureError>>;

pub struct Stream {
    requests: Sender<Reply>,
    stop: Arc<AtomicBool>,
    stopper: Arc<Mutex<Option<Box<dyn Stopper>>>>,
    frames: Arc<AtomicU64>,
    failed: Arc<Mutex<Option<CaptureError>>>,
}

impl Stream {
    /// Opens the camera with this id on a new thread and starts reading it.
    pub fn open(id: &str, width: u32, height: u32) -> Result<Stream, CaptureError> {
        let id = id.to_string();
        Stream::start(move || {
            let cam = crate::Camera::open(&id, width, height)?;
            #[cfg(windows)]
            let stop: Option<Box<dyn Stopper>> = Some(Box::new(cam.shutdown_handle()));
            #[cfg(not(windows))]
            let stop: Option<Box<dyn Stopper>> = None;
            Ok((cam, stop))
        })
    }

    /// Runs `open` on a new thread (the camera's objects stay on the thread that made them) and
    /// keeps grabbing frames from what it returns.
    pub fn start<S, F>(open: F) -> Result<Stream, CaptureError>
    where
        S: Source,
        F: FnOnce() -> Result<(S, Option<Box<dyn Stopper>>), CaptureError> + Send + 'static,
    {
        let (requests, rx) = channel::<Reply>();
        let (ready_tx, ready_rx) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopper: Arc<Mutex<Option<Box<dyn Stopper>>>> = Arc::new(Mutex::new(None));
        let frames = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(Mutex::new(None));
        let (t_stop, t_stopper, t_frames, t_failed) = (stop.clone(), stopper.clone(), frames.clone(), failed.clone());
        std::thread::Builder::new()
            .name("camera".into())
            .spawn(move || {
                let mut source = match open() {
                    Ok((s, h)) => {
                        *t_stopper.lock().unwrap() = h;
                        let _ = ready_tx.send(Ok(()));
                        s
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                let error = read(&mut source, &rx, &t_stop, &t_frames);
                if let Some(e) = &error {
                    *t_failed.lock().unwrap() = Some(e.clone());
                }
                // Anyone still waiting hears why.
                while let Ok(reply) = rx.try_recv() {
                    let _ = reply.send(Err(error.clone().unwrap_or(CaptureError::Other("the camera was closed".into()))));
                }
                // `source` drops here, on its own thread, which releases the camera.
            })
            .map_err(|e| CaptureError::Other(e.to_string()))?;
        match ready_rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(())) => Ok(Stream { requests, stop, stopper, frames, failed }),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                Err(CaptureError::Busy("the camera took too long to open".into()))
            }
        }
    }

    /// The newest frame. Waits at most `timeout` for one to arrive; after that the camera is
    /// treated as frozen.
    pub fn frame(&self, timeout: Duration) -> Result<Frame, CaptureError> {
        if let Some(e) = self.failed.lock().unwrap().clone() {
            return Err(e);
        }
        let (tx, rx) = channel();
        if self.requests.send(tx).is_err() {
            return Err(self.failed.lock().unwrap().clone().unwrap_or(CaptureError::Other("the camera was closed".into())));
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(RecvTimeoutError::Timeout) => Err(CaptureError::Frozen),
            Err(RecvTimeoutError::Disconnected) => Err(self.failed.lock().unwrap().clone().unwrap_or(CaptureError::Frozen)),
        }
    }

    /// How many frames the camera has sent since it opened.
    pub fn frames_seen(&self) -> u64 {
        self.frames.load(Ordering::Relaxed)
    }
}

fn read<S: Source>(source: &mut S, rx: &Receiver<Reply>, stop: &AtomicBool, frames: &AtomicU64) -> Option<CaptureError> {
    while !stop.load(Ordering::SeqCst) {
        if let Err(e) = source.grab() {
            return (!stop.load(Ordering::SeqCst)).then_some(e);
        }
        frames.fetch_add(1, Ordering::Relaxed);
        while let Ok(reply) = rx.try_recv() {
            let _ = reply.send(source.latest());
        }
    }
    None
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(s) = self.stopper.lock().unwrap().as_ref() {
            s.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// A pretend camera: 50 frames a second whose first byte counts up, until it "freezes".
    struct Fake {
        n: u8,
        freeze_after: u8,
    }

    impl Source for Fake {
        fn grab(&mut self) -> Result<(), CaptureError> {
            if self.n >= self.freeze_after {
                std::thread::sleep(Duration::from_secs(3600));
            }
            std::thread::sleep(Duration::from_millis(20));
            self.n += 1;
            Ok(())
        }
        fn latest(&self) -> Result<Frame, CaptureError> {
            Ok(Frame { width: 1, height: 1, rgb: vec![self.n, 0, 0] })
        }
    }

    #[test]
    fn hands_over_the_newest_frame() {
        let s = Stream::start(|| Ok((Fake { n: 0, freeze_after: 255 }, None))).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let a = s.frame(Duration::from_secs(1)).unwrap().rgb[0];
        assert!(a >= 10, "should have skipped ahead, got frame {a}");
        std::thread::sleep(Duration::from_millis(200));
        let b = s.frame(Duration::from_secs(1)).unwrap().rgb[0];
        assert!(b >= a + 5, "{a} then {b}");
        assert!(s.frames_seen() >= b as u64);
    }

    #[test]
    fn a_stuck_camera_reads_as_frozen() {
        let s = Stream::start(|| Ok((Fake { n: 0, freeze_after: 3 }, None))).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        let t = Instant::now();
        assert!(matches!(s.frame(Duration::from_millis(300)), Err(CaptureError::Frozen)));
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn open_errors_come_back() {
        let r = Stream::start(|| Err::<(Fake, Option<Box<dyn Stopper>>), _>(CaptureError::NotFound));
        assert!(matches!(r, Err(CaptureError::NotFound)));
    }
}
