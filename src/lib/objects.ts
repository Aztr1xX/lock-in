// Object detection (person, phone and the things that look like phones). Shared by the
// background worker and the main-thread fallback, so both find exactly the same things.

import type { ObjectDetector } from "@mediapipe/tasks-vision";

export interface RawObject {
  x: number; y: number; w: number; h: number; // 0..1 of the frame
  label: string;
  score: number;
  dark: number; // share of dark pixels inside the box, 0..1
  crop: boolean; // found in a close-up around a hand
}

export interface Crop { x: number; y: number; side: number } // 0..1 of frame width/height; side is in pixels of the source

export interface Detectors { full: ObjectDetector; hands: ObjectDetector }

type Canvas2D = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Source = CanvasImageSource & (ImageBitmap | HTMLVideoElement);

export async function makeDetectors(base: string): Promise<Detectors> {
  const mp = await import("@mediapipe/tasks-vision");
  const fileset = await mp.FilesetResolver.forVisionTasks(base);
  // Always the CPU: on some graphics chips the GPU version quietly finds nothing at all.
  const opts = (allow: string[], max: number) => ({
    baseOptions: { modelAssetPath: `${base}/efficientdet_lite0.tflite`, delegate: "CPU" as const },
    runningMode: "IMAGE" as const,
    scoreThreshold: 0.25,
    categoryAllowlist: allow,
    maxResults: max,
  });
  const [full, hands] = await Promise.all([
    // "person" is the most reliable "are you at your desk" signal. The rest get mistaken
    // for phones, so they're looked for too and ruled out.
    mp.ObjectDetector.createFromOptions(fileset, opts(["person", "cell phone", "remote", "laptop", "tv", "book", "keyboard"], 8)),
    // Close-ups around the hands, where a phone is big enough to spot.
    mp.ObjectDetector.createFromOptions(fileset, opts(["cell phone", "remote"], 3)),
  ]);
  return { full, hands };
}

export function detectObjects(d: Detectors, src: Source, W: number, H: number, crops: Crop[], probe: Canvas2D, zoom: Canvas2D): RawObject[] {
  const pg = probe.getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
  pg?.drawImage(src, 0, 0, probe.width, probe.height);
  const dark = (b: { x: number; y: number; w: number; h: number }) => {
    if (!pg) return 1;
    const px = pg.getImageData(
      Math.max(0, Math.floor(b.x * probe.width)), Math.max(0, Math.floor(b.y * probe.height)),
      Math.max(1, Math.round(b.w * probe.width)), Math.max(1, Math.round(b.h * probe.height)),
    ).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] < 90) n++;
    return n / (px.length / 4);
  };

  const out: RawObject[] = [];
  for (const det of d.full.detect(src).detections) {
    const c = det.categories[0], b = det.boundingBox!;
    const box = { x: b.originX / W, y: b.originY / H, w: b.width / W, h: b.height / H };
    out.push({ ...box, label: c.categoryName, score: c.score, dark: c.categoryName === "person" ? 0 : dark(box), crop: false });
  }
  if (out.some((o) => o.label === "cell phone" && o.score >= 0.3)) return out;

  const zg = zoom.getContext("2d") as Ctx2D | null;
  if (!zg) return out;
  const Z = zoom.width;
  for (const cr of crops) {
    const side = cr.side;
    const sx = Math.max(0, Math.min(W - side, cr.x * W - side / 2));
    const sy = Math.max(0, Math.min(H - side, cr.y * H - side / 2));
    zg.drawImage(src, sx, sy, side, side, 0, 0, Z, Z);
    for (const det of d.hands.detect(zoom).detections) {
      const c = det.categories[0], b = det.boundingBox!;
      const box = { x: (sx + (b.originX / Z) * side) / W, y: (sy + (b.originY / Z) * side) / H, w: ((b.width / Z) * side) / W, h: ((b.height / Z) * side) / H };
      out.push({ ...box, label: c.categoryName, score: c.score, dark: dark(box), crop: true });
    }
  }
  return out;
}
