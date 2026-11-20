//! Turning a camera frame into model input, and model output back into boxes and points.
//!
//! Each model family wants its picture prepared the way its own training pipeline did it, and
//! answers in its own layout. The speed test checks these against each model's official Python
//! pipeline (reference.json), so a mistake here shows up as a failed comparison in CI.

use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
use image::{imageops, RgbImage};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub file: String,
    pub family: Family,
    pub width: u32,
    pub height: u32,
    pub label: String,
    #[allow(dead_code)]
    pub licence: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub cpu_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    Rfdetr,
    Dfine,
    Yolo26,
    /// YOLOX (Megvii, Apache 2.0): anchor-free grid head, letterboxed BGR input.
    Yolox,
    /// NanoDet-Plus (Apache 2.0): GFL distribution head, stretched BGR input.
    Nanodet,
    Rtmpose,
}

impl Family {
    pub fn is_detector(self) -> bool {
        self != Family::Rtmpose
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Check {
    pub name: String,
    pub frame: String,
    pub hands: String,
    pub pose: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub models: Vec<ModelInfo>,
    pub checks: Vec<Check>,
    pub coco80: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Detection {
    pub cls: String,
    pub score: f32,
    /// x1, y1, x2, y2 in the original frame's pixels
    #[serde(rename = "box")]
    pub box_: [f32; 4],
}

#[derive(Debug, Clone, Serialize)]
pub struct Keypoint {
    pub x: f32,
    pub y: f32,
    pub score: f32,
}

/// A prepared input tensor plus what is needed to map answers back onto the frame.
pub struct Prepared {
    pub data: Vec<f32>,
    pub shape: [usize; 4],
    pub map: Mapping,
}

#[derive(Debug, Clone, Copy)]
pub enum Mapping {
    /// The frame was stretched to fill the input: normalised coordinates map straight back.
    Stretch { w: f32, h: f32 },
    /// The frame was scaled by `r` and centred with padding.
    Letterbox { r: f32, pad_x: f32, pad_y: f32 },
    /// A box was cut out around a person: input = (frame - centre) * s + half input size.
    Affine { cx: f32, cy: f32, s: f32, half_w: f32, half_h: f32 },
}

const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
const POSE_MEAN: [f32; 3] = [123.675, 116.28, 103.53];
const POSE_STD: [f32; 3] = [58.395, 57.12, 57.375];
/// NanoDet normalises in BGR order; these are indexed by RGB channel.
const NANODET_MEAN: [f32; 3] = [123.675, 116.28, 103.53];
const NANODET_STD: [f32; 3] = [58.395, 57.12, 57.375];

/// Scales a picture with SIMD bilinear filtering that averages over the whole source area, the
/// way the models' own (antialiased) resizing does. About ten times faster than `image`'s.
fn resize(src: &RgbImage, w: u32, h: u32) -> RgbImage {
    let mut dst = RgbImage::new(w, h);
    let opts = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Bilinear));
    Resizer::new().resize(src, &mut dst, &opts).expect("RGB to RGB resize cannot fail");
    dst
}

/// Plain bilinear sampling without averaging, like OpenCV's INTER_LINEAR, which is what the
/// YOLOX and NanoDet pipelines resize with.
fn resize_linear(src: &RgbImage, w: u32, h: u32) -> RgbImage {
    let mut dst = RgbImage::new(w, h);
    let opts = ResizeOptions::new().resize_alg(ResizeAlg::Interpolation(FilterType::Bilinear));
    Resizer::new().resize(src, &mut dst, &opts).expect("RGB to RGB resize cannot fail");
    dst
}

/// Writes an RGB picture into a 1x3xHxW float tensor, applying f(channel, value 0-255).
fn to_nchw(img: &RgbImage, f: impl Fn(usize, f32) -> f32) -> Vec<f32> {
    let (w, h) = img.dimensions();
    let plane = (w * h) as usize;
    let mut out = vec![0f32; plane * 3];
    for (i, px) in img.pixels().enumerate() {
        for c in 0..3 {
            out[c * plane + i] = f(c, px.0[c] as f32);
        }
    }
    out
}

/// Prepares a whole frame (or a crop of one) for a detector.
pub fn prepare_detector(frame: &RgbImage, m: &ModelInfo) -> Prepared {
    let (fw, fh) = frame.dimensions();
    let (w, h) = (m.width, m.height);
    let shape = [1, 3, h as usize, w as usize];
    match m.family {
        Family::Rfdetr => {
            let img = resize(frame, w, h);
            let data = to_nchw(&img, |c, v| (v / 255.0 - IMAGENET_MEAN[c]) / IMAGENET_STD[c]);
            Prepared { data, shape, map: Mapping::Stretch { w: fw as f32, h: fh as f32 } }
        }
        Family::Dfine => {
            let img = resize(frame, w, h);
            let data = to_nchw(&img, |_, v| v / 255.0);
            Prepared { data, shape, map: Mapping::Stretch { w: fw as f32, h: fh as f32 } }
        }
        Family::Yolo26 => {
            let r = (w as f32 / fw as f32).min(h as f32 / fh as f32);
            let (nw, nh) = (((fw as f32 * r).round() as u32).max(1), ((fh as f32 * r).round() as u32).max(1));
            let scaled = resize(frame, nw, nh);
            let mut canvas = RgbImage::from_pixel(w, h, image::Rgb([114, 114, 114]));
            let (px, py) = ((w - nw) / 2, (h - nh) / 2);
            imageops::replace(&mut canvas, &scaled, px as i64, py as i64);
            let data = to_nchw(&canvas, |_, v| v / 255.0);
            Prepared { data, shape, map: Mapping::Letterbox { r, pad_x: px as f32, pad_y: py as f32 } }
        }
        Family::Yolox => {
            // Scaled to fit and placed in the top-left corner, grey padding, BGR, 0 to 255.
            let r = (w as f32 / fw as f32).min(h as f32 / fh as f32);
            let (nw, nh) = (((fw as f32 * r) as u32).clamp(1, w), ((fh as f32 * r) as u32).clamp(1, h));
            let scaled = resize_linear(frame, nw, nh);
            let mut canvas = RgbImage::from_pixel(w, h, image::Rgb([114, 114, 114]));
            imageops::replace(&mut canvas, &scaled, 0, 0);
            let data = to_nchw_bgr(&canvas, |_, v| v);
            Prepared { data, shape, map: Mapping::Letterbox { r, pad_x: 0.0, pad_y: 0.0 } }
        }
        Family::Nanodet => {
            let img = resize_linear(frame, w, h);
            let data = to_nchw_bgr(&img, |c, v| (v - NANODET_MEAN[c]) / NANODET_STD[c]);
            Prepared { data, shape, map: Mapping::Stretch { w: fw as f32, h: fh as f32 } }
        }
        Family::Rtmpose => unreachable!("the pose model needs a person box"),
    }
}

/// Like `to_nchw`, but the planes go blue, green, red (OpenCV's order). `f` still gets the RGB
/// channel index.
fn to_nchw_bgr(img: &RgbImage, f: impl Fn(usize, f32) -> f32) -> Vec<f32> {
    let (w, h) = img.dimensions();
    let plane = (w * h) as usize;
    let mut out = vec![0f32; plane * 3];
    for (i, px) in img.pixels().enumerate() {
        for c in 0..3 {
            out[(2 - c) * plane + i] = f(c, px.0[c] as f32);
        }
    }
    out
}

/// Cuts out the area around a person box for the pose model, the way RTMPose was trained:
/// the box is grown by 25%, widened or heightened to the model's 3:4 shape, then scaled to fit.
/// Pixels outside the frame are black.
pub fn prepare_pose(frame: &RgbImage, m: &ModelInfo, person: [f32; 4]) -> Prepared {
    let (w, h) = (m.width as f32, m.height as f32);
    let [x1, y1, x2, y2] = person;
    let (cx, cy) = ((x1 + x2) / 2.0, (y1 + y2) / 2.0);
    // Only the width sets the scale: a box narrower than 3:4 is widened to match its height.
    let bw = ((x2 - x1) * 1.25).max((y2 - y1) * 1.25 * (w / h));
    let s = w / bw.max(1.0);
    let (half_w, half_h) = (w / 2.0, h / 2.0);
    let (fw, fh) = frame.dimensions();
    let (ow, oh) = (m.width as usize, m.height as usize);
    let plane = ow * oh;
    let mut data = vec![0f32; plane * 3];
    let raw = frame.as_raw();
    for oy in 0..oh {
        // Same sampling as OpenCV's warpAffine: output pixel (x, y) reads the frame at M^-1 (x, y).
        let sy = (oy as f32 - half_h) / s + cy;
        for ox in 0..ow {
            let sx = (ox as f32 - half_w) / s + cx;
            let mut rgb = [0f32; 3];
            let (x0, y0) = (sx.floor(), sy.floor());
            let (dx, dy) = (sx - x0, sy - y0);
            let (x0, y0) = (x0 as i64, y0 as i64);
            for (yy, wy) in [(y0, 1.0 - dy), (y0 + 1, dy)] {
                for (xx, wx) in [(x0, 1.0 - dx), (x0 + 1, dx)] {
                    if xx < 0 || yy < 0 || xx >= fw as i64 || yy >= fh as i64 {
                        continue;
                    }
                    let i = (yy as usize * fw as usize + xx as usize) * 3;
                    for c in 0..3 {
                        rgb[c] += raw[i + c] as f32 * wx * wy;
                    }
                }
            }
            for c in 0..3 {
                data[c * plane + oy * ow + ox] = (rgb[c] - POSE_MEAN[c]) / POSE_STD[c];
            }
        }
    }
    Prepared { data, shape: [1, 3, oh, ow], map: Mapping::Affine { cx, cy, s, half_w, half_h } }
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// COCO's original category ids for its 80 classes, in order. RF-DETR scores classes by these ids.
const COCO_IDS: [usize; 80] = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 31, 32, 33, 34, 35,
    36, 37, 38, 39, 40, 41, 42, 43, 44, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65,
    67, 70, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 84, 85, 86, 87, 88, 89, 90,
];

fn class_name(family: Family, idx: usize, coco80: &[String]) -> Option<String> {
    match family {
        Family::Rfdetr => COCO_IDS.iter().position(|&id| id == idx).map(|i| coco80[i].clone()),
        _ => coco80.get(idx).cloned(),
    }
}

fn to_frame(map: Mapping, b: [f32; 4], normalised: bool) -> [f32; 4] {
    match map {
        Mapping::Stretch { w, h } => {
            if normalised {
                [b[0] * w, b[1] * h, b[2] * w, b[3] * h]
            } else {
                b
            }
        }
        Mapping::Letterbox { r, pad_x, pad_y } => {
            [(b[0] - pad_x) / r, (b[1] - pad_y) / r, (b[2] - pad_x) / r, (b[3] - pad_y) / r]
        }
        Mapping::Affine { .. } => b,
    }
}

/// One output tensor: its shape and values.
pub struct Output<'a> {
    pub name: &'a str,
    pub shape: Vec<usize>,
    pub data: &'a [f32],
}

/// Reads a detector's answer. Every query and class pair above `min_score` becomes a detection,
/// which is how RF-DETR and D-FINE's own post-processing works.
pub fn decode_detector(m: &ModelInfo, outs: &[Output], map: Mapping, min_score: f32, coco80: &[String]) -> Vec<Detection> {
    let mut found = Vec::new();
    match m.family {
        Family::Rfdetr | Family::Dfine => {
            // Boxes are the output whose last size is 4; class scores are the other one.
            let Some(boxes) = outs.iter().find(|o| o.shape.last() == Some(&4)) else { return found };
            let Some(logits) = outs.iter().find(|o| o.shape.last() != Some(&4)) else { return found };
            let q = boxes.shape[boxes.shape.len() - 2];
            let c = *logits.shape.last().unwrap();
            for i in 0..q {
                let [cx, cy, w, h] = [0, 1, 2, 3].map(|k| boxes.data[i * 4 + k]);
                let b = to_frame(map, [cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0], true);
                for k in 0..c {
                    let s = sigmoid(logits.data[i * c + k]);
                    if s >= min_score {
                        if let Some(cls) = class_name(m.family, k, coco80) {
                            found.push(Detection { cls, score: s, box_: b });
                        }
                    }
                }
            }
        }
        Family::Yolo26 => {
            // End-to-end head: up to 300 rows of x1, y1, x2, y2, score, class in input pixels.
            let Some(o) = outs.first() else { return found };
            let cols = *o.shape.last().unwrap();
            if cols != 6 {
                return found; // not the NMS-free head this decoder reads
            }
            for row in o.data.chunks_exact(cols) {
                if row[4] >= min_score {
                    if let Some(cls) = class_name(m.family, row[5] as usize, coco80) {
                        found.push(Detection { cls, score: row[4], box_: to_frame(map, [row[0], row[1], row[2], row[3]], false) });
                    }
                }
            }
        }
        Family::Yolox => {
            // One row per grid cell over strides 8, 16 and 32: cx, cy, w, h as offsets from the
            // cell, objectness, then 80 class scores (already squashed to 0..1).
            let Some(o) = outs.first() else { return found };
            let cols = *o.shape.last().unwrap();
            let classes = cols.saturating_sub(5);
            let (iw, ih) = (m.width as usize, m.height as usize);
            let mut row = 0;
            for stride in [8usize, 16, 32] {
                let (gw, gh) = (iw / stride, ih / stride);
                for gy in 0..gh {
                    for gx in 0..gw {
                        let Some(r) = o.data.get(row * cols..(row + 1) * cols) else { return nms(found, 0.45) };
                        row += 1;
                        let obj = r[4];
                        if obj < min_score {
                            continue;
                        }
                        let s = stride as f32;
                        let (cx, cy) = ((r[0] + gx as f32) * s, (r[1] + gy as f32) * s);
                        let (bw, bh) = (r[2].exp() * s, r[3].exp() * s);
                        let b = to_frame(map, [cx - bw / 2.0, cy - bh / 2.0, cx + bw / 2.0, cy + bh / 2.0], false);
                        for k in 0..classes {
                            let score = obj * r[5 + k];
                            if score >= min_score {
                                if let Some(cls) = class_name(m.family, k, coco80) {
                                    found.push(Detection { cls, score, box_: b });
                                }
                            }
                        }
                    }
                }
            }
            return nms(found, 0.45);
        }
        Family::Nanodet => {
            // One row per centre point over strides 8, 16, 32 and 64: 80 class scores, then
            // for each side (left, top, right, bottom) 8 logits over distances 0..7 strides.
            let Some(o) = outs.first() else { return found };
            let cols = *o.shape.last().unwrap();
            let bins = 8;
            let classes = cols.saturating_sub(4 * bins);
            let (iw, ih) = (m.width as f32, m.height as f32);
            let mut row = 0;
            for stride in [8usize, 16, 32, 64] {
                let (gw, gh) = ((m.width as usize).div_ceil(stride), (m.height as usize).div_ceil(stride));
                for gy in 0..gh {
                    for gx in 0..gw {
                        let Some(r) = o.data.get(row * cols..(row + 1) * cols) else { return nms(found, 0.6) };
                        row += 1;
                        let best = r[..classes].iter().fold(0f32, |a, &b| a.max(b));
                        if best < min_score {
                            continue;
                        }
                        let s = stride as f32;
                        let (px, py) = (gx as f32 * s, gy as f32 * s);
                        let d: [f32; 4] = std::array::from_fn(|side| expected_bin(&r[classes + side * bins..classes + (side + 1) * bins]) * s);
                        let b = [
                            (px - d[0]).clamp(0.0, iw) / iw,
                            (py - d[1]).clamp(0.0, ih) / ih,
                            (px + d[2]).clamp(0.0, iw) / iw,
                            (py + d[3]).clamp(0.0, ih) / ih,
                        ];
                        let b = to_frame(map, b, true);
                        for (k, &score) in r[..classes].iter().enumerate() {
                            if score >= min_score {
                                if let Some(cls) = class_name(m.family, k, coco80) {
                                    found.push(Detection { cls, score, box_: b });
                                }
                            }
                        }
                    }
                }
            }
            return nms(found, 0.6);
        }
        Family::Rtmpose => {}
    }
    found.sort_by(|a, b| b.score.total_cmp(&a.score));
    found
}

/// The expected value of a softmax over distance bins 0, 1, 2, ...
fn expected_bin(logits: &[f32]) -> f32 {
    let max = logits.iter().fold(f32::MIN, |a, &b| a.max(b));
    let (mut sum, mut weighted) = (0f32, 0f32);
    for (i, &l) in logits.iter().enumerate() {
        let e = (l - max).exp();
        sum += e;
        weighted += e * i as f32;
    }
    weighted / sum
}

/// Keeps the best box of each overlapping group, class by class, the way the grid detectors'
/// own pipelines do. Returns them best first.
fn nms(mut found: Vec<Detection>, threshold: f32) -> Vec<Detection> {
    found.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for d in found {
        if !kept.iter().any(|k| k.cls == d.cls && iou(k.box_, d.box_) > threshold) {
            kept.push(d);
        }
    }
    kept
}

/// Reads RTMPose's answer: for each of the 17 points, the most likely column and row
/// (at twice the input resolution), mapped back onto the frame.
pub fn decode_pose(outs: &[Output], map: Mapping) -> Vec<Keypoint> {
    let Mapping::Affine { cx, cy, s, half_w, half_h } = map else { return vec![] };
    let Some(sx) = outs.iter().find(|o| o.name.contains('x')) else { return vec![] };
    let Some(sy) = outs.iter().find(|o| o.name.contains('y')) else { return vec![] };
    let k = sx.shape[sx.shape.len() - 2];
    let (wx, wy) = (*sx.shape.last().unwrap(), *sy.shape.last().unwrap());
    let argmax = |row: &[f32]| row.iter().enumerate().fold((0usize, f32::MIN), |b, (i, &v)| if v > b.1 { (i, v) } else { b });
    (0..k)
        .map(|j| {
            let (ix, vx) = argmax(&sx.data[j * wx..(j + 1) * wx]);
            let (iy, vy) = argmax(&sy.data[j * wy..(j + 1) * wy]);
            let (px, py) = (ix as f32 / 2.0, iy as f32 / 2.0);
            Keypoint { x: (px - half_w) / s + cx, y: (py - half_h) / s + cy, score: (vx + vy) / 2.0 }
        })
        .collect()
}

pub fn iou(a: [f32; 4], b: [f32; 4]) -> f32 {
    let ix = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let iy = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let inter = ix * iy;
    let area = |r: [f32; 4]| (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0);
    inter / (area(a) + area(b) - inter).max(1e-6)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(family: Family, w: u32, h: u32) -> ModelInfo {
        ModelInfo {
            id: "t".into(),
            file: "t.onnx".into(),
            family,
            width: w,
            height: h,
            label: "t".into(),
            licence: "x".into(),
            bytes: 0,
            sha256: String::new(),
            cpu_only: false,
        }
    }

    #[test]
    fn letterbox_maps_back() {
        let frame = RgbImage::new(640, 480);
        let p = prepare_detector(&frame, &info(Family::Yolo26, 416, 416));
        // 640x480 scaled to 416x312, padded 52 px top and bottom.
        let Mapping::Letterbox { r, pad_x, pad_y } = p.map else { panic!() };
        assert!((r - 0.65).abs() < 1e-6 && pad_x == 0.0 && pad_y == 52.0);
        let b = to_frame(p.map, [0.0, 52.0, 416.0, 364.0], false);
        assert!(b.iter().zip([0.0, 0.0, 640.0, 480.0]).all(|(a, e)| (a - e).abs() < 0.5));
    }

    #[test]
    fn pose_crop_centres_the_box() {
        let mut frame = RgbImage::new(200, 200);
        frame.put_pixel(100, 100, image::Rgb([255, 255, 255]));
        let m = info(Family::Rtmpose, 192, 256);
        let p = prepare_pose(&frame, &m, [80.0, 60.0, 120.0, 140.0]);
        // The box centre (100, 100) lands on the middle of the input.
        let Mapping::Affine { cx, cy, s, half_w, half_h } = p.map else { panic!() };
        let (ix, iy) = ((100.0 - cx) * s + half_w, (100.0 - cy) * s + half_h);
        assert!((ix - 96.0).abs() < 1e-3 && (iy - 128.0).abs() < 1e-3);
        let plane = 192 * 256;
        assert!(p.data[plane + 128 * 192 + 96] > 0.0, "white pixel should be bright after normalising");
    }

    #[test]
    fn rfdetr_classes_use_coco_ids() {
        let coco80: Vec<String> = (0..80).map(|i| format!("c{i}")).collect();
        assert_eq!(class_name(Family::Rfdetr, 1, &coco80).as_deref(), Some("c0"));
        assert_eq!(class_name(Family::Rfdetr, 77, &coco80).as_deref(), Some("c67"));
        assert_eq!(class_name(Family::Rfdetr, 12, &coco80), None);
        assert_eq!(class_name(Family::Dfine, 67, &coco80).as_deref(), Some("c67"));
    }

    #[test]
    fn decodes_query_detector() {
        let coco80: Vec<String> = (0..80).map(|i| format!("c{i}")).collect();
        let m = info(Family::Dfine, 416, 416);
        let boxes = [0.5, 0.5, 0.2, 0.4, 0.1, 0.1, 0.1, 0.1];
        let logits: Vec<f32> = (0..160).map(|i| if i == 0 { 3.0 } else { -9.0 }).collect();
        let outs = [
            Output { name: "logits", shape: vec![1, 2, 80], data: &logits },
            Output { name: "pred_boxes", shape: vec![1, 2, 4], data: &boxes },
        ];
        let d = decode_detector(&m, &outs, Mapping::Stretch { w: 100.0, h: 200.0 }, 0.3, &coco80);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].cls, "c0");
        assert!(d[0].box_.iter().zip([40.0, 60.0, 60.0, 140.0]).all(|(a, e)| (a - e).abs() < 1e-3));
    }

    #[test]
    fn grid_detectors_keep_one_box_per_object() {
        let d = |cls: &str, score: f32, x: f32| Detection { cls: cls.into(), score, box_: [x, 0.0, x + 100.0, 100.0] };
        let kept = nms(vec![d("person", 0.6, 5.0), d("person", 0.9, 0.0), d("cup", 0.5, 0.0), d("person", 0.7, 300.0)], 0.45);
        let got: Vec<(&str, f32)> = kept.iter().map(|k| (k.cls.as_str(), k.score)).collect();
        assert_eq!(got, vec![("person", 0.9), ("person", 0.7), ("cup", 0.5)]);
        assert!((expected_bin(&[0.0, 0.0]) - 0.5).abs() < 1e-6);
        assert!((expected_bin(&[-50.0, -50.0, 10.0]) - 2.0).abs() < 1e-3);
    }

    #[test]
    fn bgr_planes() {
        let img = RgbImage::from_pixel(1, 1, image::Rgb([10, 20, 30]));
        assert_eq!(to_nchw_bgr(&img, |_, v| v), vec![30.0, 20.0, 10.0]);
    }
}
