//! Live mode: the app sends camera frames and gets back what the models saw in each one.
//!
//! Input on stdin, repeated: width (u32, little-endian), height (u32), then width x height x 3
//! bytes of RGB. A width of 0 means stop. Output on stdout: one JSON line per frame.
//!
//! Each frame gets one detector pass over the whole picture, the pose model on the biggest
//! person, and a second detector pass on a crop around the wrists (or the lower half of the
//! person when the wrists aren't visible), which is where a phone actually is.

use crate::runtime::{self, Engine};
use crate::vision::{self, Detection, Keypoint, Manifest, ModelInfo};
use image::{imageops, RgbImage};
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::time::Instant;

/// COCO keypoint order: 9 and 10 are the wrists, 5 and 6 the shoulders.
const LEFT_WRIST: usize = 9;
const RIGHT_WRIST: usize = 10;

pub struct Models {
    detector: (ModelInfo, ort::session::Session),
    hands: (ModelInfo, ort::session::Session),
    pose: (ModelInfo, ort::session::Session),
    coco80: Vec<String>,
    pub engine: Engine,
}

fn find<'a>(m: &'a Manifest, id: &str) -> Result<&'a ModelInfo, String> {
    m.models
        .iter()
        .find(|x| x.id == id)
        .ok_or_else(|| format!("model {id} isn't in the manifest"))
}

impl Models {
    /// Opens the three models of one check from the manifest. Tries the graphics chip first
    /// when asked, and falls back to the CPU.
    pub fn open(
        dir: &Path,
        check: &str,
        prefer_gpu: bool,
        ort_path: Option<&Path>,
    ) -> Result<(Models, ort::environment::Environment), String> {
        let manifest: Manifest = serde_json::from_slice(
            &std::fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let c = manifest
            .checks
            .iter()
            .find(|c| c.name == check)
            .ok_or_else(|| format!("no check named {check}"))?;
        let env = runtime::load(ort_path)?;
        // On the CPU, one thread: the small detectors barely get faster with more (CI: 30 ms on one
        // core against 21 ms on four) but use more CPU time in total, and studying comes first.
        let engines: &[Engine] = if prefer_gpu {
            &[Engine::Gpu, Engine::Cpu1]
        } else {
            &[Engine::Cpu1]
        };
        let mut last_err = String::new();
        for &engine in engines {
            let open = |id: &str| -> Result<(ModelInfo, ort::session::Session), String> {
                let m = find(&manifest, id)?.clone();
                let e = if engine.is_gpu() && m.cpu_only {
                    Engine::Cpu
                } else {
                    engine
                };
                let s = runtime::open(&env, &dir.join(&m.file), e)?;
                Ok((m, s))
            };
            match (|| Ok::<_, String>((open(&c.frame)?, open(&c.hands)?, open(&c.pose)?)))() {
                Ok((detector, hands, pose)) => {
                    let coco80 = manifest.coco80.clone();
                    return Ok((
                        Models {
                            detector,
                            hands,
                            pose,
                            coco80,
                            engine,
                        },
                        env,
                    ));
                }
                Err(e) => last_err = e,
            }
        }
        Err(last_err)
    }

    fn detect(&mut self, which: Which, img: &RgbImage) -> Result<Vec<Detection>, String> {
        let (info, session) = match which {
            Which::Frame => (&self.detector.0, &mut self.detector.1),
            Which::Hands => (&self.hands.0, &mut self.hands.1),
        };
        let input = vision::prepare_detector(img, info);
        let raw = infer(session, &input)?;
        let outs: Vec<vision::Output> = raw
            .iter()
            .map(|(n, s, d)| vision::Output {
                name: n,
                shape: s.clone(),
                data: d,
            })
            .collect();
        Ok(vision::decode_detector(
            info,
            &outs,
            input.map,
            0.25,
            &self.coco80,
        ))
    }

    fn pose(&mut self, img: &RgbImage, person: [f32; 4]) -> Result<Vec<Keypoint>, String> {
        let input = vision::prepare_pose(img, &self.pose.0, person);
        let raw = infer(&mut self.pose.1, &input)?;
        let outs: Vec<vision::Output> = raw
            .iter()
            .map(|(n, s, d)| vision::Output {
                name: n,
                shape: s.clone(),
                data: d,
            })
            .collect();
        Ok(vision::decode_pose(&outs, input.map))
    }

    /// Looks at one frame.
    pub fn look(&mut self, frame: &RgbImage) -> Result<Value, String> {
        let t0 = Instant::now();
        let found = self.detect(Which::Frame, frame)?;
        let t_detect = t0.elapsed().as_secs_f64() * 1000.0;

        let people: Vec<&Detection> = found
            .iter()
            .filter(|d| d.cls == "person" && d.score >= 0.45)
            .collect();
        let biggest = people
            .iter()
            .max_by(|a, b| area(a.box_).total_cmp(&area(b.box_)))
            .map(|d| d.box_);

        let t1 = Instant::now();
        let keypoints = match biggest {
            Some(b) => self.pose(frame, b)?,
            None => Vec::new(),
        };
        let t_pose = t1.elapsed().as_secs_f64() * 1000.0;

        // The closer look: around the wrists when the pose model sees them, else the lower half
        // of the person, else skipped.
        let t2 = Instant::now();
        let wrists: Vec<&Keypoint> = [LEFT_WRIST, RIGHT_WRIST]
            .iter()
            .filter_map(|&i| keypoints.get(i))
            .filter(|k| k.score >= 0.3)
            .collect();
        let crop_box = hands_box(frame, biggest, &wrists);
        let mut close: Vec<Detection> = Vec::new();
        if let Some(cb) = crop_box {
            let crop = imageops::crop_imm(
                frame,
                cb[0] as u32,
                cb[1] as u32,
                (cb[2] - cb[0]) as u32,
                (cb[3] - cb[1]) as u32,
            )
            .to_image();
            close = self.detect(Which::Hands, &crop)?;
            for d in &mut close {
                d.box_ = [
                    d.box_[0] + cb[0],
                    d.box_[1] + cb[1],
                    d.box_[2] + cb[0],
                    d.box_[3] + cb[1],
                ];
            }
        }
        let t_hands = t2.elapsed().as_secs_f64() * 1000.0;

        let best = |cls: &[&str]| -> Option<&Detection> {
            found
                .iter()
                .chain(close.iter())
                .filter(|d| cls.contains(&d.cls.as_str()))
                .max_by(|a, b| a.score.total_cmp(&b.score))
        };
        let tablet = best(&["tablet"]);
        // Lock In's own detector knows tablets: an iPad can score as both, and then the stronger
        // tablet box wins, so reading your iPad never counts as your phone.
        let phone = best(&["cell phone"])
            .filter(|p| !tablet.is_some_and(|t| t.score > p.score && covers(t.box_, p.box_)));
        let drink = best(&["cup", "bottle", "wine glass"]);
        let shoulder_w = shoulder_width(&keypoints);
        let near_wrist = |b: [f32; 4]| {
            let reach = shoulder_w.unwrap_or(80.0) * 0.6;
            wrists.iter().any(|w| {
                w.x >= b[0] - reach
                    && w.x <= b[2] + reach
                    && w.y >= b[1] - reach
                    && w.y <= b[3] + reach
            })
        };

        Ok(json!({
            "type": "frame",
            "people": people.len(),
            "person": biggest,
            "phone": phone.map(|d| json!({ "score": d.score, "box": d.box_, "near_wrist": near_wrist(d.box_), "long_side_shoulders": shoulder_w.map(|s| long_side(d.box_) / s) })),
            "tablet": tablet.map(|d| json!({ "score": d.score, "box": d.box_ })),
            "drink": drink.map(|d| json!({ "score": d.score, "box": d.box_, "near_wrist": near_wrist(d.box_) })),
            "keypoints": keypoints.iter().map(|k| [round1(k.x), round1(k.y), (k.score * 100.0).round() / 100.0]).collect::<Vec<_>>(),
            "hands_box": crop_box,
            "ms": { "detect": round1(t_detect as f32), "pose": round1(t_pose as f32), "hands": round1(t_hands as f32) },
        }))
    }
}

#[derive(Clone, Copy)]
enum Which {
    Frame,
    Hands,
}

type RawOutputs = Vec<(String, Vec<usize>, Vec<f32>)>;

fn infer(session: &mut ort::session::Session, p: &vision::Prepared) -> Result<RawOutputs, String> {
    let input = session.inputs()[0].name().to_string();
    let tensor =
        ort::value::Tensor::from_array((p.shape, p.data.clone())).map_err(|e| e.to_string())?;
    let outputs = session
        .run(ort::inputs![input => tensor])
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (name, value) in outputs.iter() {
        if let Ok((shape, data)) = value.try_extract_tensor::<f32>() {
            out.push((
                name.to_string(),
                shape.iter().map(|&d| d.max(0) as usize).collect(),
                data.to_vec(),
            ));
        }
    }
    Ok(out)
}

fn round1(x: f32) -> f32 {
    (x * 10.0).round() / 10.0
}

fn area(b: [f32; 4]) -> f32 {
    (b[2] - b[0]).max(0.0) * (b[3] - b[1]).max(0.0)
}

fn long_side(b: [f32; 4]) -> f32 {
    (b[2] - b[0]).max(b[3] - b[1])
}

/// Distance between the shoulders, the ruler for sizes: a "phone" longer than about
/// 1.1 shoulder widths is really a tablet.
fn shoulder_width(k: &[Keypoint]) -> Option<f32> {
    let (l, r) = (k.get(5)?, k.get(6)?);
    (l.score >= 0.3 && r.score >= 0.3)
        .then(|| ((l.x - r.x).powi(2) + (l.y - r.y).powi(2)).sqrt())
        .filter(|w| *w > 10.0)
}

/// The square to look at more closely for a phone, in frame pixels, clamped to the frame.
pub fn hands_box(
    frame: &RgbImage,
    person: Option<[f32; 4]>,
    wrists: &[&Keypoint],
) -> Option<[f32; 4]> {
    let (fw, fh) = (frame.width() as f32, frame.height() as f32);
    let (cx, cy, side) = if !wrists.is_empty() {
        let cx = wrists.iter().map(|w| w.x).sum::<f32>() / wrists.len() as f32;
        let cy = wrists.iter().map(|w| w.y).sum::<f32>() / wrists.len() as f32;
        let spread = if wrists.len() == 2 {
            (wrists[0].x - wrists[1].x)
                .abs()
                .max((wrists[0].y - wrists[1].y).abs())
        } else {
            0.0
        };
        let base = person.map(|p| (p[2] - p[0]) * 0.6).unwrap_or(fw * 0.3);
        (cx, cy, (spread + base * 0.8).max(base))
    } else {
        let p = person?;
        let h = p[3] - p[1];
        (
            (p[0] + p[2]) / 2.0,
            p[1] + h * 0.75,
            (p[2] - p[0]).max(h * 0.5),
        )
    };
    let side = side.min(fw).min(fh).max(64.0);
    let x1 = (cx - side / 2.0).clamp(0.0, (fw - side).max(0.0));
    let y1 = (cy - side / 2.0).clamp(0.0, (fh - side).max(0.0));
    Some([
        x1.floor(),
        y1.floor(),
        (x1 + side).min(fw).floor(),
        (y1 + side).min(fh).floor(),
    ])
}

/// Reads frames from stdin until told to stop, answering each one on stdout.
pub fn serve(models: &mut Models, emit: &mut dyn FnMut(Value)) -> Result<(), String> {
    let mut stdin = std::io::stdin().lock();
    let mut header = [0u8; 8];
    loop {
        if stdin.read_exact(&mut header).is_err() {
            return Ok(()); // the app went away
        }
        let w = u32::from_le_bytes(header[0..4].try_into().unwrap());
        let h = u32::from_le_bytes(header[4..8].try_into().unwrap());
        if w == 0 {
            return Ok(());
        }
        if w > 4096 || h > 4096 {
            return Err(format!("frame too big: {w}x{h}"));
        }
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        stdin
            .read_exact(&mut rgb)
            .map_err(|e| format!("frame cut short: {e}"))?;
        let frame = RgbImage::from_raw(w, h, rgb).ok_or("bad frame")?;
        match models.look(&frame) {
            Ok(v) => emit(v),
            Err(e) => emit(json!({ "type": "frame_error", "message": e })),
        }
    }
}

/// Whether box `a` covers most of box `b` (the same object found twice, once by the closer look).
fn covers(a: [f32; 4], b: [f32; 4]) -> bool {
    let inter =
        (a[2].min(b[2]) - a[0].max(b[0])).max(0.0) * (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let area = (b[2] - b[0]) * (b[3] - b[1]);
    area > 0.0 && inter / area >= 0.6
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_stronger_tablet_box_hides_the_phone_inside_it() {
        assert!(super::covers(
            [0.0, 0.0, 100.0, 100.0],
            [10.0, 10.0, 60.0, 60.0]
        ));
        assert!(!super::covers(
            [0.0, 0.0, 100.0, 100.0],
            [90.0, 90.0, 140.0, 140.0]
        ));
        assert!(!super::covers([0.0, 0.0, 10.0, 10.0], [5.0, 5.0, 5.0, 5.0]));
    }
    use super::*;

    #[test]
    fn hands_box_follows_the_wrists_and_stays_in_frame() {
        let frame = RgbImage::new(640, 480);
        let w1 = Keypoint {
            x: 300.0,
            y: 400.0,
            score: 0.9,
        };
        let w2 = Keypoint {
            x: 360.0,
            y: 410.0,
            score: 0.9,
        };
        let b = hands_box(&frame, Some([200.0, 50.0, 440.0, 480.0]), &[&w1, &w2]).unwrap();
        assert!(b[0] <= 300.0 && b[2] >= 360.0 && b[1] <= 400.0 && b[3] <= 480.0 && b[3] >= 410.0);
        assert!((b[2] - b[0] - (b[3] - b[1])).abs() <= 1.0, "square");
    }

    #[test]
    fn hands_box_without_wrists_uses_lower_body() {
        let frame = RgbImage::new(640, 480);
        let b = hands_box(&frame, Some([200.0, 0.0, 440.0, 480.0]), &[]).unwrap();
        assert!(b[1] > 100.0, "lower part of the person: {b:?}");
        assert!(hands_box(&frame, None, &[]).is_none());
    }
}
