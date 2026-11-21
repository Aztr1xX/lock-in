//! Posture, from the front (camera plan: posture on RTMPose-s). Ported from the web app's v7
//! (src/lib/posture.ts), which has been in use without complaints.
//!
//! A webcam can't see your spine, so this watches the things that change when you slump, all
//! measured against how you normally sit:
//!   - sinking: your shoulders drop lower in the picture
//!   - leaning in: your shoulders get wider (you're closer to the screen)
//!   - neck: your ears sink down toward your shoulders (head pushed forward)
//!   - leaning sideways: your shoulder line tilts
//!
//! Every length is divided by your shoulder width, so it doesn't matter how far the camera is.
//! Looking down at your iPad tilts your head, which barely moves your ears, so studying on the
//! iPad isn't mistaken for a slouch.

use serde::{Deserialize, Serialize};

/// One look at how you're sitting. Lengths are in shoulder widths, except `w` (share of the
/// frame's width) and `y` (share of its height).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    pub w: f32,
    pub y: f32,
    /// Ear line to shoulder line, in shoulder widths (None: ears not seen).
    pub neck: Option<f32>,
    /// Shoulder line angle, degrees.
    pub tilt: f32,
}

/// Your normal: a handful of numbers, never a picture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Baseline {
    #[serde(flatten)]
    pub s: Sample,
    pub camera: String,
    /// Seconds since 1970.
    pub at: u64,
    /// Set on purpose with "This is how I sit", not learned.
    #[serde(default)]
    pub set: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Slump {
    Sinking,
    LeaningIn,
    Neck,
    LeaningSideways,
}

// How far from your normal counts. Generous on purpose: it's meant to catch a real slump that
// sticks, not every shift in your chair. (v7's values.)
const LEAN: f32 = 1.15; // shoulders this much wider than normal (15% closer)
const SINK: f32 = 0.2; // shoulders this many shoulder widths lower
const NECK: f32 = 0.72; // ear-to-shoulder gap down to this share of normal
const TILT: f32 = 10.0; // degrees more tilt than normal

/// Checked once a second; a nudge after 3 minutes of steady slump, at most every 10 minutes.
pub const CHECK_EVERY: f64 = 1.0;
pub const NUDGE_AFTER: f64 = 180.0;
pub const NUDGE_COOLDOWN: f64 = 600.0;
/// A session learns its own normal from its first minute of clear sightings.
const LEARN_SAMPLES: usize = 60;

// RTMPose (COCO order): ears 3 and 4, shoulders 5 and 6.
const L_EAR: usize = 3;
const R_EAR: usize = 4;
const L_SHOULDER: usize = 5;
const R_SHOULDER: usize = 6;
const SHOULDER_SCORE: f32 = 0.5;
const EAR_SCORE: f32 = 0.4;

/// Reads one pose: keypoints as (x, y, score) in frame pixels. None when your shoulders aren't
/// both clear, or you're side-on or far away.
pub fn measure(kp: &[[f32; 3]], frame_w: f32, frame_h: f32) -> Option<Sample> {
    let at = |i: usize, min: f32| {
        kp.get(i)
            .filter(|p| p[2] >= min)
            .map(|p| (p[0] / frame_w, p[1] / frame_h))
    };
    let (ls, rs) = (
        at(L_SHOULDER, SHOULDER_SCORE)?,
        at(R_SHOULDER, SHOULDER_SCORE)?,
    );
    let w = (ls.0 - rs.0).hypot(ls.1 - rs.1);
    if w < 0.05 {
        return None;
    }
    let y = (ls.1 + rs.1) / 2.0;
    let neck = match (at(L_EAR, EAR_SCORE), at(R_EAR, EAR_SCORE)) {
        (Some(l), Some(r)) => Some((y - (l.1 + r.1) / 2.0) / w),
        (Some(e), None) | (None, Some(e)) => Some((y - e.1) / w),
        (None, None) => None,
    };
    // Mirror-proof angle: always measured left to right in the picture.
    let (a, b) = if ls.0 < rs.0 { (ls, rs) } else { (rs, ls) };
    let tilt = (b.1 - a.1).atan2(b.0 - a.0).to_degrees();
    Some(Sample { w, y, neck, tilt })
}

fn median(mut v: Vec<f32>) -> Option<f32> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f32::total_cmp);
    Some(v[v.len() / 2])
}

/// Your normal from a run of samples: the middle value of each measure.
pub fn normal_of(samples: &[Sample]) -> Option<Sample> {
    let necks: Vec<f32> = samples.iter().filter_map(|s| s.neck).collect();
    Some(Sample {
        w: median(samples.iter().map(|s| s.w).collect())?,
        y: median(samples.iter().map(|s| s.y).collect())?,
        neck: if necks.len() * 2 >= samples.len() {
            median(necks)
        } else {
            None
        },
        tilt: median(samples.iter().map(|s| s.tilt).collect())?,
    })
}

/// Which ways you're slumped compared with your normal. Empty when you're fine.
pub fn slumps(s: &Sample, b: &Sample) -> Vec<Slump> {
    let mut out = Vec::new();
    if s.y - b.y > SINK * b.w {
        out.push(Slump::Sinking);
    }
    if s.w > b.w * LEAN {
        out.push(Slump::LeaningIn);
    }
    if let (Some(n), Some(bn)) = (s.neck, b.neck) {
        if bn > 0.15 && n < bn * NECK {
            out.push(Slump::Neck);
        }
    }
    if (s.tilt - b.tilt).abs() > TILT {
        out.push(Slump::LeaningSideways);
    }
    out
}

/// Smooths the samples, so one jumpy frame never counts.
#[derive(Debug, Default)]
pub struct Smoother {
    s: Option<Sample>,
}

impl Smoother {
    const K: f32 = 0.35;
    pub fn push(&mut self, n: Option<Sample>) -> Option<Sample> {
        let Some(n) = n else { return self.s };
        let k = Self::K;
        self.s = Some(match self.s {
            None => n,
            Some(p) => Sample {
                w: p.w + k * (n.w - p.w),
                y: p.y + k * (n.y - p.y),
                neck: match (p.neck, n.neck) {
                    (Some(a), Some(b)) => Some(a + k * (b - a)),
                    (a, b) => b.or(a),
                },
                tilt: p.tilt + k * (n.tilt - p.tilt),
            },
        });
        self.s
    }
}

/// What the posture check is doing now.
#[derive(Debug, Clone, Serialize, Default)]
pub struct PostureState {
    /// Still learning how you normally sit.
    pub learning: bool,
    pub slumps: Vec<Slump>,
    /// How long you've been slumped, in seconds.
    pub slumped_for: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PostureEvent {
    /// A nudge: slumped this way for NUDGE_AFTER seconds.
    Slump { at: f64, slumps: Vec<Slump> },
    /// This session's normal, learned or set, for the app to remember.
    Normal { at: f64, normal: Sample, set: bool },
}

/// The posture check over a session.
#[derive(Debug, Default)]
pub struct Posture {
    smoother: Smoother,
    normal: Option<Sample>,
    learned: bool,
    learning: Vec<Sample>,
    last_check: Option<f64>,
    slumped_since: Option<f64>,
    last_nudge: Option<f64>,
    current: Vec<Slump>,
    latest: Option<Sample>,
}

impl Posture {
    /// `saved`: your remembered normal for this camera, if there is one. The session still learns
    /// its own (to remember), but judges against the remembered one meanwhile.
    pub fn new(saved: Option<Sample>) -> Posture {
        Posture {
            normal: saved,
            ..Default::default()
        }
    }

    pub fn state(&self, t: f64) -> PostureState {
        PostureState {
            learning: self.normal.is_none(),
            slumps: self.current.clone(),
            slumped_for: self.slumped_since.map_or(0.0, |s| t - s),
        }
    }

    /// "This is how I sit": your normal becomes how you're sitting now.
    pub fn set_here(&mut self, t: f64) -> Option<PostureEvent> {
        let s = self.latest?;
        self.normal = Some(s);
        self.learned = true;
        self.slumped_since = None;
        self.current.clear();
        Some(PostureEvent::Normal {
            at: t,
            normal: s,
            set: true,
        })
    }

    pub fn update(&mut self, t: f64, sample: Option<Sample>) -> Vec<PostureEvent> {
        let mut out = Vec::new();
        if self.last_check.is_some_and(|last| t - last < CHECK_EVERY) {
            return out;
        }
        self.last_check = Some(t);
        let Some(s) = self.smoother.push(sample).filter(|_| sample.is_some()) else {
            // Not seen clearly: a slump can't be judged, and doesn't keep counting.
            self.slumped_since = None;
            self.current.clear();
            return out;
        };
        self.latest = Some(s);
        if !self.learned {
            self.learning.push(s);
            if self.learning.len() >= LEARN_SAMPLES {
                self.learned = true;
                let n = normal_of(&self.learning);
                self.learning.clear();
                if let Some(n) = n {
                    // A remembered normal stays in charge for this session; this one is kept for next time.
                    self.normal.get_or_insert(n);
                    out.push(PostureEvent::Normal {
                        at: t,
                        normal: n,
                        set: false,
                    });
                }
            }
        }
        let Some(normal) = self.normal else {
            return out;
        };
        self.current = slumps(&s, &normal);
        if self.current.is_empty() {
            self.slumped_since = None;
            return out;
        }
        let since = *self.slumped_since.get_or_insert(t);
        let cooled = self.last_nudge.is_none_or(|n| t - n >= NUDGE_COOLDOWN);
        if t - since >= NUDGE_AFTER && cooled {
            self.last_nudge = Some(t);
            out.push(PostureEvent::Slump {
                at: t,
                slumps: self.current.clone(),
            });
        }
        out
    }
}

/// Your remembered normals, per camera, kept in a small file by the app. As in v7: the normal is
/// the middle of your last few sessions, a slouchy start never becomes "normal" on its own, a
/// normal set with the button stays until you set a new one, and moving the camera starts over.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Saved {
    pub list: Vec<Baseline>,
}

const KEEP: usize = 5;

/// Is this the same setup (camera not moved)?
fn same_setup(a: &Sample, b: &Sample) -> bool {
    (a.w / b.w - 1.0).abs() < 0.3 && (a.y - b.y).abs() < 0.15
}

impl Saved {
    /// Your normal for this camera, if there is one.
    pub fn normal(&self, camera: &str) -> Option<Sample> {
        let mine: Vec<&Baseline> = self.list.iter().filter(|b| b.camera == camera).collect();
        if let Some(set) = mine.iter().find(|b| b.set) {
            return Some(set.s);
        }
        normal_of(&mine.iter().map(|b| b.s).collect::<Vec<_>>())
    }

    /// Remembers one session's normal.
    pub fn remember(&mut self, b: Baseline) {
        let (mine, others): (Vec<Baseline>, Vec<Baseline>) =
            self.list.drain(..).partition(|x| x.camera == b.camera);
        let set = mine.iter().find(|x| x.set).cloned();
        let mine = if b.set {
            vec![b]
        } else if let Some(set) = set {
            if same_setup(&set.s, &b.s) {
                vec![set]
            } else {
                vec![b]
            }
        } else {
            let mut keep: Vec<Baseline> = mine
                .into_iter()
                .filter(|x| same_setup(&x.s, &b.s))
                .collect();
            keep.push(b);
            let n = keep.len().saturating_sub(KEEP);
            keep.split_off(n)
        };
        let n = others.len().saturating_sub(10);
        self.list = others.into_iter().skip(n).chain(mine).collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pose with shoulders `w` apart at height `y` (pixels in a 640x480 frame) and ears `neck` above.
    fn pose(w: f32, y: f32, neck: f32, tilt_px: f32) -> Vec<[f32; 3]> {
        let mut kp = vec![[0.0, 0.0, 0.0]; 17];
        kp[L_SHOULDER] = [320.0 + w / 2.0, y + tilt_px, 0.9];
        kp[R_SHOULDER] = [320.0 - w / 2.0, y - tilt_px, 0.9];
        kp[L_EAR] = [340.0, y - neck, 0.8];
        kp[R_EAR] = [300.0, y - neck, 0.8];
        kp
    }

    fn sample(w: f32, y: f32, neck: f32, tilt: f32) -> Sample {
        measure(&pose(w, y, neck, tilt), 640.0, 480.0).unwrap()
    }

    #[test]
    fn measures_in_shoulder_widths() {
        let s = sample(200.0, 300.0, 100.0, 0.0);
        assert!((s.w - 200.0 / 640.0).abs() < 1e-5);
        assert!((s.y - 300.0 / 480.0).abs() < 1e-5);
        // Ears 100 px above in a 480 px frame, shoulders 200 px wide in a 640 px one.
        assert!((s.neck.unwrap() - (100.0 / 480.0) / (200.0 / 640.0)).abs() < 1e-4);
        assert!(s.tilt.abs() < 1e-3);
        // Mirrored the same way round.
        let mut m = pose(200.0, 300.0, 100.0, 10.0);
        m.swap(L_SHOULDER, R_SHOULDER);
        assert!(
            (measure(&m, 640.0, 480.0).unwrap().tilt - sample(200.0, 300.0, 100.0, 10.0).tilt)
                .abs()
                < 1e-3
        );
        // A shoulder not seen clearly: nothing to judge.
        let mut hidden = pose(200.0, 300.0, 100.0, 0.0);
        hidden[R_SHOULDER][2] = 0.2;
        assert!(measure(&hidden, 640.0, 480.0).is_none());
    }

    #[test]
    fn slumps_against_your_normal() {
        let n = sample(200.0, 300.0, 100.0, 0.0);
        assert!(
            slumps(&sample(205.0, 305.0, 95.0, 2.0), &n).is_empty(),
            "small shifts are fine"
        );
        assert_eq!(
            slumps(&sample(240.0, 300.0, 100.0, 0.0), &n),
            vec![Slump::LeaningIn]
        );
        assert_eq!(
            slumps(&sample(200.0, 350.0, 100.0, 0.0), &n),
            vec![Slump::Sinking]
        );
        assert_eq!(
            slumps(&sample(200.0, 300.0, 60.0, 0.0), &n),
            vec![Slump::Neck]
        );
        assert_eq!(
            slumps(&sample(200.0, 300.0, 100.0, 25.0), &n),
            vec![Slump::LeaningSideways]
        );
    }

    #[test]
    fn learns_then_nudges_after_three_minutes_and_cools_down() {
        let mut p = Posture::new(None);
        let good = sample(200.0, 300.0, 100.0, 0.0);
        let slouch = sample(200.0, 360.0, 60.0, 0.0);
        let mut t = 0.0;
        let mut events = Vec::new();
        for _ in 0..60 {
            events.extend(p.update(t, Some(good)));
            t += 1.0;
        }
        assert!(
            matches!(events.as_slice(), [PostureEvent::Normal { set: false, .. }]),
            "{events:?}"
        );
        assert!(!p.state(t).learning);
        events.clear();
        // Slumped from now on: one nudge at 3 minutes, the next only after the 10 minute cooldown.
        let from = t;
        for _ in 0..900 {
            events.extend(p.update(t, Some(slouch)));
            t += 1.0;
        }
        let at: Vec<f64> = events
            .iter()
            .filter_map(|e| {
                if let PostureEvent::Slump { at, .. } = e {
                    Some(*at - from)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(at.len(), 2, "{at:?}");
        assert!((NUDGE_AFTER..NUDGE_AFTER + 10.0).contains(&at[0]), "{at:?}");
        assert!(at[1] - at[0] >= NUDGE_COOLDOWN);
        // Sitting up resets the clock.
        for _ in 0..10 {
            p.update(t, Some(good));
            t += 1.0;
        }
        assert_eq!(p.state(t).slumped_for, 0.0);
    }

    #[test]
    fn looking_down_at_the_ipad_is_not_a_slump() {
        // Head tipped down: the nose drops a lot, ears only a little, shoulders stay put.
        let n = sample(200.0, 300.0, 100.0, 0.0);
        assert!(slumps(&sample(200.0, 302.0, 85.0, 1.0), &n).is_empty());
    }

    #[test]
    fn this_is_how_i_sit() {
        let mut p = Posture::new(Some(sample(200.0, 300.0, 100.0, 0.0)));
        let now = sample(240.0, 350.0, 90.0, 0.0);
        p.update(0.0, Some(now));
        assert!(!p.state(0.0).slumps.is_empty());
        assert!(matches!(
            p.set_here(1.0),
            Some(PostureEvent::Normal { set: true, .. })
        ));
        p.update(2.0, Some(now));
        assert!(p.state(2.0).slumps.is_empty());
    }

    #[test]
    fn remembered_normals() {
        let b = |cam: &str, w: f32, set: bool| Baseline {
            s: sample(w, 300.0, 100.0, 0.0),
            camera: cam.into(),
            at: 0,
            set,
        };
        let mut saved = Saved::default();
        for w in [200.0, 204.0, 198.0, 202.0, 206.0, 210.0] {
            saved.remember(b("cam", w, false));
        }
        assert_eq!(saved.list.len(), KEEP, "the last 5 sessions");
        assert!((saved.normal("cam").unwrap().w - 204.0 / 640.0).abs() < 1e-5);
        // Moved the camera much closer: start over from this session.
        saved.remember(b("cam", 320.0, false));
        assert_eq!(saved.list.len(), 1);
        // Set with the button: stays, even through other sessions.
        saved.remember(b("cam", 300.0, true));
        saved.remember(b("cam", 310.0, false));
        assert!(saved.list[0].set && (saved.normal("cam").unwrap().w - 300.0 / 640.0).abs() < 1e-5);
        assert!(saved.normal("other").is_none());
    }
}
