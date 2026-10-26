// Finds you, your hands and your phone. Shared by the background worker and the
// main-thread fallback, so both see exactly the same things.
//
// Tuned for a blurred background (NVIDIA Broadcast): only sharp things on or in front
// of you count, so a blurry shape behind you can never be "your phone".

import type { HandLandmarker, ObjectDetector } from "@mediapipe/tasks-vision";

export interface Box { x: number; y: number; w: number; h: number } // 0..1 of the frame

export interface RawObject extends Box {
  label: string;
  score: number;
  dark: number; // share of dark pixels inside the box, 0..1
  sharp: number; // how sharp the box is next to you (1 = as sharp as you, low = blurred background)
  onYou: boolean; // overlaps the person box
  crop: boolean; // found in a close-up around a hand
}

export interface Found {
  objects: RawObject[];
  hands: Box[];
}

export interface Detectors { full: ObjectDetector; close: ObjectDetector; hands: HandLandmarker }

type Canvas2D = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Source = CanvasImageSource & (ImageBitmap | HTMLVideoElement);

export async function makeDetectors(base: string): Promise<Detectors> {
  const mp = await import("@mediapipe/tasks-vision");
  const fileset = await mp.FilesetResolver.forVisionTasks(base);
  // Always the CPU: on some graphics chips the GPU version quietly finds nothing at all.
  const opts = (model: string, allow: string[], max: number) => ({
    baseOptions: { modelAssetPath: `${base}/${model}`, delegate: "CPU" as const },
    runningMode: "IMAGE" as const,
    scoreThreshold: 0.25,
    categoryAllowlist: allow,
    maxResults: max,
  });
  const [full, close, hands] = await Promise.all([
    // The bigger EfficientDet: far surer about phones (0.8 vs 0.6 on Ryan's photo) and no
    // false ones on the same photo with the phone painted out. It runs in the worker, so
    // the extra time never touches the timer.
    // "person" is the best "are you at your desk" signal; remote/laptop/tv are what gets
    // mistaken for a phone (calculator, iPad), so they're found and ruled out.
    mp.ObjectDetector.createFromOptions(fileset, opts("efficientdet_lite2.tflite", ["person", "cell phone", "remote", "laptop", "tv", "book", "keyboard"], 8)),
    // Close-ups around your hands, where a phone held low is big enough to spot.
    mp.ObjectDetector.createFromOptions(fileset, opts("efficientdet_lite0.tflite", ["cell phone", "remote"], 3)),
    mp.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}/hand_landmarker.task`, delegate: "CPU" },
      runningMode: "IMAGE",
      numHands: 2,
      minHandDetectionConfidence: 0.4,
    }),
  ]);
  return { full, close, hands };
}

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

export function detectObjects(d: Detectors, src: Source, W: number, H: number, probe: Canvas2D, zoom: Canvas2D): Found {
  const pg = probe.getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
  const PW = probe.width, PH = probe.height;
  pg?.drawImage(src, 0, 0, PW, PH);
  const pixels = pg?.getImageData(0, 0, PW, PH).data;
  const lum = (i: number) => (pixels ? 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] : 0);
  const region = (b: Box) => ({
    x0: Math.max(1, Math.floor(b.x * PW)), y0: Math.max(1, Math.floor(b.y * PH)),
    x1: Math.min(PW - 1, Math.ceil((b.x + b.w) * PW)), y1: Math.min(PH - 1, Math.ceil((b.y + b.h) * PH)),
  });
  const dark = (b: Box) => {
    if (!pixels) return 1;
    const r = region(b);
    let n = 0, all = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++, all++) if (lum((y * PW + x) * 4) < 90) n++;
    return all ? n / all : 1;
  };
  // Mean edge strength (a Laplacian). Blurred background scores low, you and things in your hands high.
  const edges = (b: Box) => {
    if (!pixels) return 1;
    const r = region(b);
    let sum = 0, all = 0;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++, all++) {
        const i = (y * PW + x) * 4;
        sum += Math.abs(4 * lum(i) - lum(i - 4) - lum(i + 4) - lum(i - PW * 4) - lum(i + PW * 4));
      }
    }
    return all ? sum / all : 0;
  };

  // Hands first: they say where a phone in use would be.
  const hands: Box[] = d.hands.detect(src).landmarks.map((l) => {
    const xs = l.map((p) => p.x), ys = l.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  });

  const found: Omit<RawObject, "sharp" | "onYou">[] = [];
  for (const det of d.full.detect(src).detections) {
    const c = det.categories[0], b = det.boundingBox!;
    const box = { x: b.originX / W, y: b.originY / H, w: b.width / W, h: b.height / H };
    found.push({ ...box, label: c.categoryName, score: c.score, dark: c.categoryName === "person" ? 0 : dark(box), crop: false });
  }

  // Nothing clear in the full picture: look closely around each hand.
  if (!found.some((o) => o.label === "cell phone" && o.score >= 0.5)) {
    const zg = zoom.getContext("2d") as Ctx2D | null;
    const Z = zoom.width;
    for (const h of zg ? hands : []) {
      const side = Math.max(0.3 * Math.min(W, H), 2.2 * Math.max(h.w * W, h.h * H));
      const cx = (h.x + h.w / 2) * W, cy = (h.y + h.h / 2) * H;
      const sx = Math.max(0, Math.min(W - side, cx - side / 2)), sy = Math.max(0, Math.min(H - side, cy - side / 2));
      zg!.drawImage(src, sx, sy, side, side, 0, 0, Z, Z);
      for (const det of d.close.detect(zoom).detections) {
        const c = det.categories[0], b = det.boundingBox!;
        const box = { x: (sx + (b.originX / Z) * side) / W, y: (sy + (b.originY / Z) * side) / H, w: ((b.width / Z) * side) / W, h: ((b.height / Z) * side) / H };
        found.push({ ...box, label: c.categoryName, score: c.score, dark: dark(box), crop: true });
      }
    }
  }

  const person = found.filter((o) => o.label === "person").sort((a, b) => b.score - a.score)[0];
  const youEdges = person ? edges(person) : 0;
  const objects = found.map((o) => {
    if (o.label === "person") return { ...o, sharp: 1, onYou: true };
    const onYou = !person || overlap(o, person) > 0.5 * o.w * o.h;
    const sharp = youEdges > 0 ? edges(o) / youEdges : 1;
    return { ...o, onYou, sharp };
  });
  return { objects, hands };
}
