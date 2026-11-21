//! Your own test clips (camera plan, step 3).
//!
//! A hidden screen walks you through short clips: phone in hand, phone on the desk, reading the
//! iPad, leaving, covering the camera, and so on. Each clip is saved as JPEG frames, two a second
//! (the rate the live check runs at), in a folder on this PC, and never leaves it. The app then
//! plays the clips through the same models and rules as the live check and shows only numbers:
//! did it flag the phone when it should, and stay quiet when it should.

use crate::rules::{Event, Health, Look, Rules, Settings};
use lockin_capture::Frame;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FPS: f64 = 2.0;

/// What a clip should and shouldn't trigger. `None` means "not judged by this clip".
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Expect {
    pub phone: Option<bool>,
    pub away: Option<bool>,
    pub unclear: Option<bool>,
    pub sip: Option<bool>,
    pub interrupted: Option<bool>,
    /// Slumped compared with your "Sitting normally" clip (judged only when that one is recorded).
    pub slump: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Spec {
    pub id: &'static str,
    pub title: &'static str,
    /// What to do while it records.
    pub how: &'static str,
    pub secs: u32,
    pub expect: Expect,
}

const fn e(
    phone: Option<bool>,
    away: Option<bool>,
    unclear: Option<bool>,
    sip: Option<bool>,
    interrupted: Option<bool>,
) -> Expect {
    Expect {
        phone,
        away,
        unclear,
        sip,
        interrupted,
        slump: None,
    }
}
/// The same, with a posture expectation.
const fn p(x: Expect, slump: bool) -> Expect {
    Expect {
        slump: Some(slump),
        ..x
    }
}
const Y: Option<bool> = Some(true);
const N: Option<bool> = Some(false);
const X: Option<bool> = None;

/// The clips, in the order the screen asks for them.
pub const SPECS: &[Spec] = &[
    Spec { id: "phone-hand", title: "Phone in your hand", how: "Hold your phone and use it the way you normally would, scrolling or typing.", secs: 20, expect: e(Y, N, N, X, N) },
    Spec { id: "phone-low", title: "Phone held low", how: "Use your phone low down, near the desk edge or in your lap.", secs: 20, expect: e(Y, N, X, X, N) },
    Spec { id: "phone-desk", title: "Phone on the desk", how: "Put your phone on the desk next to you and don't touch it. Hands on the desk or keyboard.", secs: 20, expect: p(e(N, N, N, X, N), false) },
    Spec { id: "ipad-read", title: "Reading your iPad", how: "Read on your iPad the way you study, looking down at it.", secs: 60, expect: p(e(N, N, N, X, N), false) },
    Spec { id: "ipad-write", title: "Writing on your iPad", how: "Write or draw on your iPad with the pencil.", secs: 40, expect: p(e(N, N, N, X, N), false) },
    Spec { id: "ipad-hold", title: "Holding your iPad up", how: "Hold your iPad up in both hands, like reading in bed.", secs: 20, expect: e(N, N, X, X, N) },
    Spec { id: "drink", title: "Having a drink", how: "Take a sip from a cup or bottle two or three times, putting it down in between.", secs: 25, expect: e(N, N, N, Y, N) },
    Spec { id: "sit-well", title: "Sitting normally", how: "Sit the way you do when you're focused and comfortable. The posture clips are judged against this one.", secs: 30, expect: e(N, N, N, X, N) },
    Spec { id: "slouch", title: "Slouching", how: "Slouch the way you do when you're tired.", secs: 30, expect: p(e(N, N, X, X, N), true) },
    Spec { id: "lean-in", title: "Leaning in close", how: "Lean in close to the screen, like reading small text.", secs: 20, expect: p(e(N, N, X, X, N), true) },
    Spec { id: "leave", title: "Leaving and coming back", how: "Stand up and walk out of view. Come back after about 25 seconds and sit down.", secs: 50, expect: e(N, Y, N, X, N) },
    Spec { id: "lean-out", title: "Leaning out of view", how: "Lean out of view to grab something, and be back within 10 seconds.", secs: 20, expect: e(N, N, N, X, N) },
    Spec { id: "someone", title: "Someone walks past", how: "Have someone walk behind you once. Skip this one if nobody's around.", secs: 20, expect: e(N, N, N, X, N) },
    Spec { id: "dim", title: "Dim room", how: "Turn the main light off or down, and study as normal.", secs: 20, expect: e(N, N, N, X, N) },
    Spec { id: "cover", title: "Covering the camera", how: "Cover the camera with your hand for about 8 seconds, then uncover it.", secs: 20, expect: e(N, N, Y, X, N) },
];

pub fn spec(id: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.id == id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meta {
    pub id: String,
    pub camera: String,
    pub recorded_at: u64,
    pub frames: usize,
    pub width: u32,
    pub height: u32,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Records one clip into `root/<id>/`, replacing an older recording of it. `frame` gives the
/// newest camera frame; it is called twice a second. `progress(done, total)` after each frame.
/// Returns early, keeping nothing, if `stop` says so.
pub fn record(
    root: &Path,
    spec: &Spec,
    camera: &str,
    mut frame: impl FnMut() -> Result<Frame, String>,
    mut progress: impl FnMut(usize, usize),
    stop: &dyn Fn() -> bool,
) -> Result<Meta, String> {
    let total = (spec.secs as f64 * FPS) as usize;
    let tmp = root.join(format!(".{}-recording", spec.id));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Couldn't make the clips folder: {e}"))?;
    let start = std::time::Instant::now();
    let (mut w, mut h) = (0, 0);
    for i in 0..total {
        let due = start + std::time::Duration::from_secs_f64(i as f64 / FPS);
        while std::time::Instant::now() < due {
            if stop() {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err("Stopped".into());
            }
            std::thread::sleep(
                (due - std::time::Instant::now()).min(std::time::Duration::from_millis(50)),
            );
        }
        let f = frame()?;
        (w, h) = (f.width, f.height);
        let img = image::RgbImage::from_raw(f.width, f.height, f.rgb).ok_or("bad frame")?;
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92)
            .encode_image(&img)
            .map_err(|e| e.to_string())?;
        std::fs::write(tmp.join(format!("{i:04}.jpg")), out)
            .map_err(|e| format!("Couldn't save a frame: {e}"))?;
        progress(i + 1, total);
    }
    let meta = Meta {
        id: spec.id.to_string(),
        camera: camera.to_string(),
        recorded_at: now(),
        frames: total,
        width: w,
        height: h,
    };
    std::fs::write(
        tmp.join("clip.json"),
        serde_json::to_vec_pretty(&meta).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let dst = root.join(spec.id);
    let _ = std::fs::remove_dir_all(&dst);
    std::fs::rename(&tmp, &dst).map_err(|e| e.to_string())?;
    Ok(meta)
}

/// The clips recorded so far.
pub fn list(root: &Path) -> Vec<Meta> {
    let mut out: Vec<Meta> = SPECS
        .iter()
        .filter_map(|s| std::fs::read(root.join(s.id).join("clip.json")).ok())
        .filter_map(|b| serde_json::from_slice(&b).ok())
        .collect();
    out.sort_by_key(|m| SPECS.iter().position(|s| s.id == m.id));
    out
}

/// Deletes one clip, or all of them with `None`.
pub fn delete(root: &Path, id: Option<&str>) -> Result<(), String> {
    let targets: Vec<PathBuf> = match id {
        Some(id) if spec(id).is_some() => vec![root.join(id)],
        Some(_) => return Err("no such clip".into()),
        None => SPECS.iter().map(|s| root.join(s.id)).collect(),
    };
    for t in targets {
        if t.exists() {
            std::fs::remove_dir_all(&t).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The frames of one clip, in order.
pub fn frames(root: &Path, id: &str) -> Result<Vec<Frame>, String> {
    let dir = root.join(id);
    let meta: Meta =
        serde_json::from_slice(&std::fs::read(dir.join("clip.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    (0..meta.frames)
        .map(|i| {
            let img = image::load_from_memory(
                &std::fs::read(dir.join(format!("{i:04}.jpg"))).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?
            .to_rgb8();
            Ok(Frame {
                width: img.width(),
                height: img.height(),
                rgb: img.into_raw(),
            })
        })
        .collect()
}

/// How one clip went for one detector.
#[derive(Debug, Clone, Serialize)]
pub struct ClipScore {
    pub id: String,
    pub passed: bool,
    /// What the rules flagged during the clip.
    pub phone: bool,
    pub away: bool,
    pub unclear: bool,
    pub sip: bool,
    pub interrupted: bool,
    /// Slumped compared with your "Sitting normally" clip, when that one is recorded.
    pub slump: Option<bool>,
    /// Share of frames with a phone at a hand (what the detector itself saw, before the rules).
    pub phone_frames: f64,
    /// Share of frames where you were seen (person box or shoulders).
    pub seen_frames: f64,
    pub frames: usize,
    /// Which expectations failed, in words.
    pub misses: Vec<String>,
}

/// How you normally sit, from the "Sitting normally" clip's looks.
pub fn normal_from(looks: &[Look]) -> Option<crate::posture::Sample> {
    let poses: Vec<_> = looks.iter().filter_map(|l| l.pose).collect();
    if poses.len() < 10 {
        return None;
    }
    crate::posture::normal_of(&poses)
}

/// Whether a clip shows a slump against `normal`: the smoothed posture is off in at least half
/// of the clear checks in its second half (the first half is for settling into it). Clips are too
/// short for the live check's 3 minutes, so this judges the same measures without the wait.
fn slumped(looks: &[Look], normal: &crate::posture::Sample) -> bool {
    let mut sm = crate::posture::Smoother::default();
    let judged: Vec<bool> = looks
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            let s = sm.push(l.pose);
            (i * 2 >= looks.len() && l.pose.is_some())
                .then(|| s.is_some_and(|s| !crate::posture::slumps(&s, normal).is_empty()))
        })
        .collect();
    !judged.is_empty() && judged.iter().filter(|&&b| b).count() * 2 >= judged.len()
}

/// Plays one clip's looks through fresh rules and judges them against the clip's expectations.
/// `normal`: how you sit normally (from the "Sitting normally" clip), for the posture clips.
pub fn judge(
    spec: &Spec,
    looks: &[Look],
    settings: Settings,
    normal: Option<&crate::posture::Sample>,
) -> ClipScore {
    let mut rules = Rules::new(settings);
    let (mut phone, mut away, mut unclear, mut sip, mut interrupted) =
        (false, false, false, false, false);
    for l in looks {
        for ev in rules.update(l) {
            match ev {
                Event::PhoneStart { .. } => phone = true,
                Event::Away { .. } => away = true,
                Event::Health { health, .. } if health != Health::Ok => unclear = true,
                Event::Sip { .. } => sip = true,
                Event::InterruptStart { .. } => interrupted = true,
                _ => {}
            }
        }
    }
    let n = looks.len().max(1) as f64;
    let phone_frames = looks
        .iter()
        .filter(|l| {
            l.phone
                .is_some_and(|p| p.near_wrist && p.score >= settings.phone_score)
        })
        .count() as f64
        / n;
    let seen_frames = looks.iter().filter(|l| l.person || l.shoulders).count() as f64 / n;
    let mut misses = Vec::new();
    let mut check = |want: Option<bool>, got: bool, yes: &str, no: &str| {
        if let Some(w) = want {
            if w != got {
                misses.push(if w { yes.to_string() } else { no.to_string() });
            }
        }
    };
    let x = spec.expect;
    let slump = normal.map(|n| slumped(looks, n));
    if let Some(got) = slump {
        check(
            x.slump,
            got,
            "missed the slump",
            "said you were slumped when you weren't",
        );
    }
    check(
        x.phone,
        phone,
        "missed the phone",
        "flagged a phone that wasn't in your hand",
    );
    check(
        x.away,
        away,
        "didn't notice you leave",
        "said you left when you didn't",
    );
    check(
        x.unclear,
        unclear,
        "didn't notice the camera was covered",
        "said the camera was covered or frozen when it wasn't",
    );
    check(
        x.sip,
        sip,
        "missed the drink",
        "saw a drink that wasn't there",
    );
    check(
        x.interrupted,
        interrupted,
        "missed the interruption",
        "said you were interrupted",
    );
    ClipScore {
        id: spec.id.to_string(),
        slump,
        passed: misses.is_empty(),
        phone,
        away,
        unclear,
        sip,
        interrupted,
        phone_frames,
        seen_frames,
        frames: looks.len(),
        misses,
    }
}

/// Turns a clip's frames into looks with `look` (the models), adding brightness and frame
/// change the way the live check does.
pub fn looks(
    frames: &[Frame],
    mut look: impl FnMut(&Frame) -> Result<serde_json::Value, String>,
) -> Result<Vec<Look>, String> {
    let mut out = Vec::with_capacity(frames.len());
    for (i, f) in frames.iter().enumerate() {
        let v = look(f)?;
        let change = if i == 0 {
            255.0
        } else {
            f.difference(&frames[i - 1])
        };
        out.push(crate::session::to_look(
            i as f64 / FPS,
            &v,
            (f.width, f.height),
            f.brightness(),
            change,
        ));
    }
    Ok(out)
}

/// One detector's results over every recorded clip.
#[derive(Debug, Clone, Serialize)]
pub struct CheckScore {
    pub check: String,
    pub engine: String,
    pub clips: Vec<ClipScore>,
    /// Median time for one check, in ms.
    pub check_ms: f64,
}

/// Plays every recorded clip through the sandboxed worker with each of `checks`.
/// `progress(check, clip, done, total)` after each clip; returning false stops.
pub fn score(
    root: &Path,
    worker: &Path,
    models: &Path,
    checks: &[String],
    gpu: bool,
    settings: Settings,
    mut progress: impl FnMut(&str, &str, usize, usize) -> bool,
) -> Result<Vec<CheckScore>, String> {
    let recorded = list(root);
    if recorded.is_empty() {
        return Err("Record a clip first.".into());
    }
    let mut out = Vec::new();
    for check in checks {
        let mut live = crate::worker::Live::start(worker, models, check, gpu)?;
        let mut times = Vec::new();
        let mut played = Vec::new();
        for (i, m) in recorded.iter().enumerate() {
            let Some(spec) = spec(&m.id) else { continue };
            let f = frames(root, &m.id)?;
            let l = looks(&f, |fr| {
                let t = std::time::Instant::now();
                let v = live.look(fr, std::time::Duration::from_secs(10));
                times.push(t.elapsed().as_secs_f64() * 1000.0);
                v
            })?;
            played.push((spec, l));
            if !progress(check, &m.id, i + 1, recorded.len()) {
                return Err("Stopped".into());
            }
        }
        let normal = played
            .iter()
            .find(|(s, _)| s.id == "sit-well")
            .and_then(|(_, l)| normal_from(l));
        let clips: Vec<ClipScore> = played
            .iter()
            .map(|(spec, l)| judge(spec, l, settings, normal.as_ref()))
            .collect();
        times.sort_by(f64::total_cmp);
        let check_ms = times.get(times.len() / 2).copied().unwrap_or(0.0);
        out.push(CheckScore {
            check: check.clone(),
            engine: live.engine.clone(),
            clips,
            check_ms,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::PhoneSeen;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lockin-clips-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn records_lists_reads_and_deletes() {
        let root = tmp("record");
        let spec = Spec {
            id: "phone-desk",
            title: "t",
            how: "h",
            secs: 1,
            expect: Expect::default(),
        };
        let mut n = 0u8;
        let meta = record(
            &root,
            &spec,
            "Cam",
            || {
                n += 40;
                Ok(Frame {
                    width: 8,
                    height: 6,
                    rgb: vec![n; 8 * 6 * 3],
                })
            },
            |_, _| {},
            &|| false,
        )
        .unwrap();
        assert_eq!(meta.frames, 2);
        assert_eq!(list(&root).len(), 1);
        let f = frames(&root, "phone-desk").unwrap();
        assert_eq!(f.len(), 2);
        assert!(f[1].brightness() > f[0].brightness());
        delete(&root, None).unwrap();
        assert!(list(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stopping_keeps_nothing() {
        let root = tmp("stop");
        let spec = Spec {
            id: "leave",
            title: "t",
            how: "h",
            secs: 5,
            expect: Expect::default(),
        };
        let r = record(
            &root,
            &spec,
            "Cam",
            || {
                Ok(Frame {
                    width: 2,
                    height: 2,
                    rgb: vec![9; 12],
                })
            },
            |_, _| {},
            &|| true,
        );
        assert!(r.is_err());
        assert!(list(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn judging_against_expectations() {
        let me = |t: f64, phone: bool| Look {
            t,
            people: 1,
            person: true,
            shoulders: true,
            brightness: 120.0,
            change: 3.0,
            phone: phone.then_some(PhoneSeen {
                score: 0.8,
                near_wrist: true,
                long_side_shoulders: Some(0.5),
            }),
            ..Default::default()
        };
        let hand = spec("phone-hand").unwrap();
        let caught: Vec<Look> = (0..40).map(|i| me(i as f64 / 2.0, true)).collect();
        let s = judge(hand, &caught, Settings::default(), None);
        assert!(
            s.passed && s.phone && (s.phone_frames - 1.0).abs() < 1e-9,
            "{s:?}"
        );
        let missed: Vec<Look> = (0..40).map(|i| me(i as f64 / 2.0, false)).collect();
        let s = judge(hand, &missed, Settings::default(), None);
        assert!(!s.passed && s.misses == vec!["missed the phone".to_string()]);
        let ipad = spec("ipad-read").unwrap();
        assert!(
            !judge(ipad, &caught, Settings::default(), None).passed,
            "a phone flagged while reading the iPad is a fail"
        );
    }

    #[test]
    fn posture_clips_are_judged_against_sitting_normally() {
        use crate::posture::Sample;
        let at = |t: f64, pose: Sample| Look {
            t,
            people: 1,
            person: true,
            shoulders: true,
            brightness: 120.0,
            change: 3.0,
            pose: Some(pose),
            ..Default::default()
        };
        let good = Sample {
            w: 0.31,
            y: 0.62,
            neck: Some(0.66),
            tilt: 0.0,
        };
        let slouch = Sample {
            w: 0.31,
            y: 0.75,
            neck: Some(0.4),
            tilt: 0.0,
        };
        let normal = normal_from(
            &(0..60)
                .map(|i| at(i as f64 / 2.0, good))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let clip = |pose| {
            (0..60)
                .map(|i| at(i as f64 / 2.0, pose))
                .collect::<Vec<_>>()
        };
        let s = judge(
            spec("slouch").unwrap(),
            &clip(slouch),
            Settings::default(),
            Some(&normal),
        );
        assert!(s.passed && s.slump == Some(true), "{s:?}");
        let s = judge(
            spec("ipad-read").unwrap(),
            &clip(good),
            Settings::default(),
            Some(&normal),
        );
        assert!(s.passed && s.slump == Some(false), "{s:?}");
        let s = judge(
            spec("ipad-read").unwrap(),
            &clip(slouch),
            Settings::default(),
            Some(&normal),
        );
        assert!(
            !s.passed && s.misses == vec!["said you were slumped when you weren't".to_string()]
        );
        // Without a "Sitting normally" clip, posture isn't judged.
        assert_eq!(
            judge(
                spec("slouch").unwrap(),
                &clip(good),
                Settings::default(),
                None
            )
            .slump,
            None
        );
    }

    #[test]
    fn every_clip_is_long_enough_for_its_rule() {
        for s in SPECS {
            if s.expect.away == Some(true) {
                assert!(
                    s.secs >= 40,
                    "{} too short to be away for 15 s and back",
                    s.id
                );
            }
            assert!(spec(s.id).is_some());
        }
    }
}
