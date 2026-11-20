//! One live camera session: the camera on its thread, the worker in its sandbox, and the rules,
//! run twice a second until stopped. Everything it reports goes out through one callback.

use crate::rules::{Event, Look, PhoneSeen, Rules, Settings, State};
use crate::worker::{Live, SandboxState};
use lockin_capture::{CaptureError, Frame, Stream};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct Options {
    pub camera_id: String,
    pub camera_name: String,
    /// The worker exe and its models folder.
    pub worker: PathBuf,
    pub models: PathBuf,
    /// Which full check from the models' manifest to run.
    pub check: String,
    /// Try the graphics chip first.
    pub gpu: bool,
    pub settings: Settings,
}

/// How the session is doing, for the "does it keep running when minimised" test.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Stats {
    pub running_secs: f64,
    pub checks: u64,
    pub failed_checks: u64,
    /// Frames the camera sent (most are skipped; only the newest is checked).
    pub camera_frames: u64,
    /// Median of the recent checks' time in the worker, ms.
    pub check_ms: f64,
    /// The longest time between two finished checks, in seconds.
    pub longest_gap: f64,
    /// Time the app window was minimised or hidden while checks kept running, in seconds.
    pub hidden_secs: f64,
    /// Checks finished while the window was hidden.
    pub hidden_checks: u64,
    /// Checks per second right now (2, or 1 on a slow PC).
    pub rate: f64,
    /// Share of one CPU core the camera work used (worker plus this app), when Windows says.
    pub core_pct: Option<f64>,
    pub worker_restarts: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Update {
    Started { camera: String, engine: String, check: String, sandbox: SandboxState, width: u32, height: u32 },
    Check {
        state: State,
        stats: Stats,
        /// What the models saw: boxes and points, for the live preview.
        seen: Value,
        /// A small JPEG of the frame, base64, only while the preview is open.
        #[serde(skip_serializing_if = "Option::is_none")]
        preview: Option<String>,
        brightness: f32,
    },
    Events { events: Vec<Event> },
    /// Something went wrong. `fatal` means the session has stopped.
    Problem { message: String, fatal: bool },
    Stopped { stats: Stats },
}

pub struct Session {
    stop: Arc<AtomicBool>,
    preview: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Session {
    /// Starts the session on its own thread. `hidden` says whether the app window is
    /// minimised or hidden right now.
    pub fn start(opts: Options, mut on_update: impl FnMut(Update) + Send + 'static, hidden: impl Fn() -> bool + Send + 'static) -> Session {
        let stop = Arc::new(AtomicBool::new(false));
        let preview = Arc::new(AtomicBool::new(false));
        let (s, p) = (stop.clone(), preview.clone());
        let thread = std::thread::Builder::new()
            .name("camera-check".into())
            .spawn(move || {
                let stats = run(&opts, &s, &p, &mut on_update, &hidden);
                on_update(Update::Stopped { stats });
            })
            .ok();
        Session { stop, preview, thread }
    }

    /// Turns the live preview pictures on or off (off when nobody is looking, to save work).
    pub fn set_preview(&self, on: bool) {
        self.preview.store(on, Ordering::SeqCst);
    }

    pub fn is_running(&self) -> bool {
        self.thread.as_ref().is_some_and(|t| !t.is_finished())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

const FRAME_TIMEOUT: Duration = Duration::from_secs(2);
const LOOK_TIMEOUT: Duration = Duration::from_secs(10);
/// Over this, a check is slow enough to drop to one a second (camera plan).
const SLOW_MS: f64 = 150.0;
const MAX_RESTARTS: u32 = 3;

fn run(opts: &Options, stop: &AtomicBool, preview: &AtomicBool, emit: &mut dyn FnMut(Update), hidden: &dyn Fn() -> bool) -> Stats {
    let mut stats = Stats { rate: 2.0, ..Stats::default() };
    let stream = match Stream::open(&opts.camera_id, 640, 480) {
        Ok(s) => s,
        Err(e) => {
            emit(Update::Problem { message: e.to_string(), fatal: true });
            return stats;
        }
    };
    let mut worker = match Live::start(&opts.worker, &opts.models, &opts.check, opts.gpu) {
        Ok(w) => w,
        Err(e) => {
            emit(Update::Problem { message: e, fatal: true });
            return stats;
        }
    };
    let first = stream.frame(Duration::from_secs(5)).ok();
    emit(Update::Started {
        camera: opts.camera_name.clone(),
        engine: worker.engine.clone(),
        check: worker.check.clone(),
        sandbox: worker.sandbox().clone(),
        width: first.as_ref().map_or(0, |f| f.width),
        height: first.as_ref().map_or(0, |f| f.height),
    });

    let mut rules = Rules::new(opts.settings);
    let start = Instant::now();
    let mut prev: Option<Frame> = first;
    let mut recent_ms: Vec<f64> = Vec::new();
    let mut last_done = Instant::now();
    let mut next = Instant::now();
    let cpu_start = cpu_total(&worker);
    let mut cpu_mark = (Instant::now(), cpu_start);

    while !stop.load(Ordering::SeqCst) {
        // Wait for the next tick in small steps so stopping is quick.
        while Instant::now() < next {
            if stop.load(Ordering::SeqCst) {
                return finish(stats, start);
            }
            std::thread::sleep((next - Instant::now()).min(Duration::from_millis(50)));
        }
        let interval = Duration::from_secs_f64(1.0 / stats.rate);
        next += interval;
        if Instant::now() > next {
            next = Instant::now() + interval; // fell behind (slow PC or the PC slept): don't race
        }
        let t = start.elapsed().as_secs_f64();
        let was_hidden = hidden();

        let frame = match stream.frame(FRAME_TIMEOUT) {
            Ok(f) => f,
            Err(CaptureError::Frozen) => {
                let ev = rules.camera_stalled(t);
                if !ev.is_empty() {
                    emit(Update::Events { events: ev });
                }
                stats.failed_checks += 1;
                continue;
            }
            Err(e) => {
                emit(Update::Problem { message: e.to_string(), fatal: true });
                return finish(stats, start);
            }
        };
        let brightness = frame.brightness();
        let change = prev.as_ref().map_or(255.0, |p| frame.difference(p));

        let began = Instant::now();
        let seen = match worker.look(&frame, LOOK_TIMEOUT) {
            Ok(v) => v,
            Err(e) => {
                stats.failed_checks += 1;
                if stats.worker_restarts >= MAX_RESTARTS {
                    emit(Update::Problem { message: format!("{e}. Stopped the camera check after {MAX_RESTARTS} restarts."), fatal: true });
                    return finish(stats, start);
                }
                emit(Update::Problem { message: format!("{e}. Restarting it."), fatal: false });
                stats.worker_restarts += 1;
                drop(worker);
                worker = match Live::start(&opts.worker, &opts.models, &opts.check, opts.gpu) {
                    Ok(w) => w,
                    Err(e) => {
                        emit(Update::Problem { message: e, fatal: true });
                        return finish(stats, start);
                    }
                };
                continue;
            }
        };
        let took = began.elapsed().as_secs_f64() * 1000.0;

        let look = to_look(t, &seen, brightness, change);
        let events = rules.update(&look);
        if !events.is_empty() {
            emit(Update::Events { events });
        }

        // ---- stats ----
        stats.checks += 1;
        let gap = last_done.elapsed().as_secs_f64();
        if stats.checks > 1 {
            stats.longest_gap = stats.longest_gap.max(gap);
        }
        last_done = Instant::now();
        if was_hidden && hidden() {
            stats.hidden_secs += gap.min(5.0);
            stats.hidden_checks += 1;
        }
        recent_ms.push(took);
        if recent_ms.len() > 20 {
            recent_ms.remove(0);
        }
        stats.check_ms = median(&recent_ms);
        stats.rate = if recent_ms.len() >= 6 && stats.check_ms > SLOW_MS { 1.0 } else { 2.0 };
        stats.camera_frames = stream.frames_seen();
        if cpu_mark.0.elapsed() >= Duration::from_secs(10) {
            if let (Some(a), Some(b)) = (cpu_mark.1, cpu_total(&worker)) {
                let wall = cpu_mark.0.elapsed().as_secs_f64() * 1000.0;
                stats.core_pct = Some(((b - a) / wall * 100.0).max(0.0));
            }
            cpu_mark = (Instant::now(), cpu_total(&worker));
        }
        stats.running_secs = start.elapsed().as_secs_f64();

        let picture = preview.load(Ordering::SeqCst).then(|| jpeg(&frame)).flatten();
        emit(Update::Check { state: rules.state(), stats: stats.clone(), seen: trim(seen), preview: picture, brightness });
        prev = Some(frame);
    }
    finish(stats, start)
}

fn finish(mut stats: Stats, start: Instant) -> Stats {
    stats.running_secs = start.elapsed().as_secs_f64();
    stats
}

/// Worker plus this app's CPU time so far, in ms (the app does the camera reading).
fn cpu_total(w: &Live) -> Option<f64> {
    #[cfg(windows)]
    let own = lockin_sandbox::cpu_ms(None);
    #[cfg(not(windows))]
    let own: Option<f64> = None;
    Some(w.cpu_ms()? + own?)
}

fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(f64::total_cmp);
    s.get(s.len() / 2).copied().unwrap_or(0.0)
}

/// Reads the worker's answer for the rules.
pub fn to_look(t: f64, v: &Value, brightness: f32, change: f32) -> Look {
    let num = |x: &Value| x.as_f64().map(|f| f as f32);
    let kp = v["keypoints"].as_array();
    let point_ok = |i: usize| kp.and_then(|k| k.get(i)).and_then(|p| p.get(2)).and_then(Value::as_f64).is_some_and(|s| s >= 0.3);
    let phone = v.get("phone").filter(|p| !p.is_null()).map(|p| PhoneSeen {
        score: num(&p["score"]).unwrap_or(0.0),
        near_wrist: p["near_wrist"].as_bool().unwrap_or(false),
        long_side_shoulders: num(&p["long_side_shoulders"]),
    });
    Look {
        t,
        people: v["people"].as_u64().unwrap_or(0) as u32,
        person: !v["person"].is_null(),
        shoulders: point_ok(5) && point_ok(6),
        phone,
        drink_at_hand: v["drink"]["near_wrist"].as_bool().unwrap_or(false),
        brightness,
        change,
    }
}

/// Only what the preview draws.
fn trim(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.remove("type");
    }
    v
}

/// A 320 px wide JPEG of the frame, base64, for the preview. Made in memory only.
fn jpeg(f: &Frame) -> Option<String> {
    use base64::Engine;
    let img = image::RgbImage::from_raw(f.width, f.height, f.rgb.clone())?;
    let w = 320u32.min(f.width);
    let h = (f.height as f64 * w as f64 / f.width as f64).round() as u32;
    let small = image::imageops::resize(&img, w, h.max(1), image::imageops::FilterType::Triangle);
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 70).encode_image(&small).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_worker_answer() {
        let v = json!({
            "type": "frame", "people": 1, "person": [1, 2, 3, 4],
            "phone": { "score": 0.8, "box": [0, 0, 1, 1], "near_wrist": true, "long_side_shoulders": 0.5 },
            "drink": null,
            "keypoints": [[0,0,0.9],[0,0,0.9],[0,0,0.9],[0,0,0.9],[0,0,0.9],[1,1,0.8],[2,2,0.2]],
        });
        let l = to_look(3.0, &v, 100.0, 2.0);
        assert_eq!(l.people, 1);
        assert!(l.person);
        assert!(!l.shoulders, "right shoulder too unsure");
        let p = l.phone.unwrap();
        assert!(p.near_wrist && (p.score - 0.8).abs() < 1e-6 && p.long_side_shoulders == Some(0.5));
        assert!(!l.drink_at_hand);
        let none = to_look(0.0, &json!({ "people": 0, "person": null, "phone": null }), 0.0, 0.0);
        assert!(!none.person && none.phone.is_none());
    }

    #[test]
    fn preview_is_a_small_jpeg() {
        let f = Frame { width: 640, height: 480, rgb: vec![128; 640 * 480 * 3] };
        let b = jpeg(&f).unwrap();
        assert!(b.len() < 20_000, "{}", b.len());
    }
}
