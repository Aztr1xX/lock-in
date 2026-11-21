//! The speed test (camera plan, step 1): times every candidate model on this computer, on the
//! CPU and on the graphics chip, and shows what each one found in the frame it was given.

use crate::machine;
use crate::runtime::{self, Engine};
use crate::vision::{self, Detection, Family, Keypoint, Manifest, ModelInfo, Output, Prepared};
use image::RgbImage;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub struct Options {
    pub models_dir: PathBuf,
    pub runs: usize,
    pub engines: Vec<Engine>,
    pub reference: Option<PathBuf>,
    pub ort: Option<PathBuf>,
    /// Picture source shown in the report ("camera" or a file name).
    pub source: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Timing {
    /// Median time for one pass, milliseconds.
    pub ms: f64,
    pub p90: f64,
    pub max: f64,
    /// CPU time one pass costs across all threads, milliseconds.
    pub cpu_ms: f64,
    /// Time to open the model.
    pub load_ms: f64,
    /// Timed passes (fewer on a slow machine).
    pub runs: usize,
    /// Whether the graphics chip's answer matched the CPU's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agrees: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Outcome {
    Ok(Timing),
    Err { error: String },
}

#[derive(Debug, Serialize)]
pub struct ModelResult {
    pub id: String,
    pub label: String,
    pub family: Family,
    pub width: u32,
    pub height: u32,
    pub mb: f64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub timing_only: bool,
    /// Median time to prepare the picture for this model, milliseconds.
    pub prep_ms: f64,
    pub engines: HashMap<&'static str, Outcome>,
    /// What it found, from the CPU run (detectors: score 0.3 and up).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub found: Vec<Detection>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keypoints: Vec<Keypoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub name: String,
    /// Whole frame + hands crop + pose, per engine: (median ms, CPU ms).
    pub engines: HashMap<&'static str, Value>,
}

/// Rounds to hundredths of a millisecond for the report.
fn r2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

fn pct(v: &[f64], p: f64) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(f64::total_cmp);
    s[((s.len() - 1) as f64 * p).round() as usize]
}

fn sha256(path: &Path) -> std::io::Result<String> {
    let mut h = Sha256::new();
    let mut f = std::fs::File::open(path)?;
    std::io::copy(&mut f, &mut h)?;
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// A model's float outputs: name, shape and values.
type RawOutputs = Vec<(String, Vec<usize>, Vec<f32>)>;

/// Runs a session once and copies out every float output.
fn infer(session: &mut ort::session::Session, p: &Prepared) -> Result<RawOutputs, String> {
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

fn as_outputs(raw: &RawOutputs) -> Vec<Output<'_>> {
    raw.iter()
        .map(|(n, s, d)| Output {
            name: n,
            shape: s.clone(),
            data: d,
        })
        .collect()
}

/// Times one model on one engine. Returns the timing and the last answer.
fn time_one(
    env: &ort::environment::Environment,
    path: &Path,
    engine: Engine,
    input: &Prepared,
    runs: usize,
) -> Result<(Timing, RawOutputs), String> {
    let t0 = Instant::now();
    let mut session = runtime::open(env, path, engine)?;
    let load_ms = t0.elapsed().as_secs_f64() * 1000.0;
    // Warm up: the first passes allocate memory and, on a graphics chip, compile shaders.
    let mut last = Vec::new();
    let mut slowest = 0f64;
    for _ in 0..3 {
        let t = Instant::now();
        last = infer(&mut session, input)?;
        slowest = slowest.max(t.elapsed().as_secs_f64() * 1000.0);
    }
    // On a slow machine (or a software graphics driver) keep each model to about 5 seconds.
    let runs = runs.min(((5000.0 / slowest.max(1.0)).ceil() as usize).max(3));
    let mut walls = Vec::with_capacity(runs);
    let cpu0 = machine::cpu_ms();
    for _ in 0..runs {
        let t = Instant::now();
        last = infer(&mut session, input)?;
        walls.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let cpu_ms = (machine::cpu_ms() - cpu0) / runs as f64;
    let timing = Timing {
        ms: r2(median(&mut walls.clone())),
        p90: r2(pct(&walls, 0.9)),
        max: r2(pct(&walls, 1.0)),
        cpu_ms: r2(cpu_ms),
        load_ms: r2(load_ms),
        runs,
        agrees: None,
    };
    Ok((timing, last))
}

/// Compares our detections with what the model's official pipeline found in the same picture.
fn compare_detections(ours: &[Detection], reference: &Value) -> Value {
    let refs: Vec<(String, f32, [f32; 4])> = reference
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            let b = d["box"].as_array()?;
            Some((
                d["cls"].as_str()?.to_string(),
                d["score"].as_f64()? as f32,
                [0, 1, 2, 3].map(|i| b[i].as_f64().unwrap_or(0.0) as f32),
            ))
        })
        .filter(|(_, s, _)| *s >= 0.5)
        .collect();
    let mut missed = Vec::new();
    for (cls, score, b) in &refs {
        let hit = ours.iter().any(|d| {
            &d.cls == cls && vision::iou(d.box_, *b) >= 0.8 && (d.score - score).abs() <= 0.1
        });
        if !hit {
            missed.push(json!({ "cls": cls, "score": score }));
        }
    }
    json!({ "matched": refs.len() - missed.len(), "total": refs.len(), "missed": missed })
}

fn compare_pose(ours: &[Keypoint], reference: &Value) -> Value {
    let Some(r) = reference.as_array().and_then(|a| a.first()) else {
        return Value::Null;
    };
    let Some(kps) = r["keypoints"].as_array() else {
        return Value::Null;
    };
    let b = r["box"]
        .as_array()
        .map(|b| b[3].as_f64().unwrap_or(1.0) - b[1].as_f64().unwrap_or(0.0))
        .unwrap_or(1.0) as f32;
    let mut worst = 0f32;
    let mut used = 0;
    for (k, ours) in kps.iter().zip(ours) {
        let (x, y, s) = (
            k[0].as_f64().unwrap_or(0.0) as f32,
            k[1].as_f64().unwrap_or(0.0) as f32,
            k[2].as_f64().unwrap_or(0.0) as f32,
        );
        if s < 0.5 {
            continue;
        }
        used += 1;
        worst = worst.max(((ours.x - x).powi(2) + (ours.y - y).powi(2)).sqrt() / b.max(1.0));
    }
    // Within 3% of the person's height counts as the same point.
    json!({ "points": used, "worst_share_of_height": worst, "ok": used > 0 && worst <= 0.03 })
}

fn agrees(cpu: &[Detection], gpu: &[Detection]) -> bool {
    match (cpu.first(), gpu.first()) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.cls == b.cls
                && (a.score - b.score).abs() <= 0.05
                && vision::iou(a.box_, b.box_) >= 0.9
        }
        _ => false,
    }
}

pub fn run(opts: &Options, frame: RgbImage, emit: &mut dyn FnMut(Value)) -> Result<Value, String> {
    let manifest_path = opts.models_dir.join("manifest.json");
    let manifest: Manifest = serde_json::from_slice(
        &std::fs::read(&manifest_path).map_err(|e| format!("{}: {e}", manifest_path.display()))?,
    )
    .map_err(|e| format!("manifest.json: {e}"))?;
    let reference: Value = match &opts.reference {
        Some(p) => {
            serde_json::from_slice(&std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?)
                .map_err(|e| e.to_string())?
        }
        None => Value::Null,
    };

    // Only the models shipped on this computer are timed (YOLO26n is only timed in CI).
    let models: Vec<&ModelInfo> = manifest
        .models
        .iter()
        .filter(|m| opts.models_dir.join(&m.file).exists())
        .collect();
    if models.is_empty() {
        return Err("No camera models found".into());
    }
    for m in &models {
        let p = opts.models_dir.join(&m.file);
        let ok = std::fs::metadata(&p)
            .map(|md| md.len() == m.bytes)
            .unwrap_or(false)
            && sha256(&p).map(|h| h == m.sha256).unwrap_or(false);
        if !ok {
            return Err(format!("{} is damaged; reinstall Lock In", m.file));
        }
    }

    let env = runtime::load(opts.ort.as_deref())?;
    let total: usize = models
        .iter()
        .map(|m| {
            opts.engines
                .iter()
                .filter(|e| !(e.is_gpu() && m.cpu_only))
                .count()
        })
        .sum();
    let mut step = 0;
    let mut gpu_missing: Option<String> = None;
    let mut person: Option<[f32; 4]> = None;
    let mut results: Vec<ModelResult> = Vec::new();

    // Detectors first, so the pose model gets a real person box from the frame.
    let mut ordered = models.clone();
    ordered.sort_by_key(|m| !m.family.is_detector());

    for m in ordered {
        let path = opts.models_dir.join(&m.file);
        let detector = m.family.is_detector();
        let box_ = person.unwrap_or_else(|| {
            // Nobody found yet: the middle of the frame, so the pose model still gets timed.
            let (w, h) = (frame.width() as f32, frame.height() as f32);
            [w * 0.2, h * 0.1, w * 0.8, h * 0.95]
        });
        let prepare = |f: &RgbImage| {
            if detector {
                vision::prepare_detector(f, m)
            } else {
                vision::prepare_pose(f, m, box_)
            }
        };
        let mut preps: Vec<f64> = (0..5)
            .map(|_| {
                let t = Instant::now();
                let _ = prepare(&frame);
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        let input = prepare(&frame);

        let mut r = ModelResult {
            id: m.id.clone(),
            label: m.label.clone(),
            family: m.family,
            width: m.width,
            height: m.height,
            mb: (m.bytes as f64 / 1e6 * 10.0).round() / 10.0,
            timing_only: m.timing_only,
            prep_ms: r2(median(&mut preps)),
            engines: HashMap::new(),
            found: Vec::new(),
            keypoints: Vec::new(),
            reference: None,
        };
        let mut cpu_found: Option<Vec<Detection>> = None;

        for &engine in &opts.engines {
            if engine.is_gpu() && m.cpu_only {
                continue;
            }
            step += 1;
            emit(
                json!({ "type": "progress", "step": step, "total": total, "model": m.label, "size": m.width, "engine": engine.key(), "where": engine.describe() }),
            );
            if engine.is_gpu() {
                if let Some(e) = &gpu_missing {
                    r.engines
                        .insert(engine.key(), Outcome::Err { error: e.clone() });
                    continue;
                }
            }
            match time_one(&env, &path, engine, &input, opts.runs) {
                Ok((mut timing, raw)) => {
                    let outs = as_outputs(&raw);
                    if detector {
                        let found =
                            vision::decode_detector(m, &outs, input.map, 0.3, &manifest.coco80);
                        match &cpu_found {
                            None => {
                                if person.is_none() {
                                    person =
                                        found.iter().find(|d| d.cls == "person").map(|d| d.box_);
                                }
                                cpu_found = Some(found.clone());
                                r.found = found;
                            }
                            Some(cpu) => timing.agrees = Some(agrees(cpu, &found)),
                        }
                    } else if r.keypoints.is_empty() {
                        r.keypoints = vision::decode_pose(&outs, input.map);
                    }
                    r.engines.insert(engine.key(), Outcome::Ok(timing));
                }
                Err(e) => {
                    if engine.is_gpu() && gpu_missing.is_none() {
                        // The graphics chip failing to open is a property of this computer, not
                        // of one model: don't try it again for every model.
                        gpu_missing = Some(format!("graphics chip not usable: {e}"));
                    }
                    r.engines.insert(engine.key(), Outcome::Err { error: e });
                }
            }
        }

        if let Some(rf) = reference.get(&m.id) {
            r.reference = Some(if detector {
                compare_detections(&r.found, rf)
            } else {
                compare_pose(&r.keypoints, rf)
            });
        }
        results.push(r);
    }

    // A full check is the whole frame, the hands crop and the pose model, plus preparing each picture.
    let by_id: HashMap<&str, &ModelResult> = results.iter().map(|r| (r.id.as_str(), r)).collect();
    let mut checks = Vec::new();
    for c in &manifest.checks {
        let parts = [&c.frame, &c.hands, &c.pose];
        let Some(rs) = parts
            .iter()
            .map(|id| by_id.get(id.as_str()).copied())
            .collect::<Option<Vec<_>>>()
        else {
            continue;
        };
        let mut engines = HashMap::new();
        for &engine in &opts.engines {
            let mut ms = 0.0;
            let mut cpu = 0.0;
            let mut ok = true;
            for r in &rs {
                // An 8-bit model has no graphics-chip run; its CPU number stands in.
                let key = if engine.is_gpu() && !r.engines.contains_key(engine.key()) {
                    Engine::Cpu.key()
                } else {
                    engine.key()
                };
                match r.engines.get(key) {
                    Some(Outcome::Ok(t)) => {
                        ms += t.ms + r.prep_ms;
                        cpu += t.cpu_ms + r.prep_ms;
                    }
                    _ => ok = false,
                }
            }
            if ok {
                engines.insert(engine.key(), json!({ "ms": (ms * 10.0).round() / 10.0, "cpu_ms": (cpu * 10.0).round() / 10.0 }));
            }
        }
        checks.push(CheckResult {
            name: c.name.clone(),
            engines,
        });
    }

    Ok(json!({
        "type": "result",
        "machine": machine::describe(),
        "frame": { "width": frame.width(), "height": frame.height(), "source": opts.source },
        "runs": opts.runs,
        "models": results,
        "checks": checks,
    }))
}
