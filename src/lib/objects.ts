// Finds you, your hands and your phone. Shared by the background worker and the
// main-thread fallback, so both see exactly the same things.
//
// Tuned for a blurred background (NVIDIA Broadcast): only sharp things on or in front
// of you count, so a blurry shape behind you can never be "your phone".
//
// How it looks (tested on 494 real photos of people with phones, iPads, laptops and
// calculators, see the pull request):
//   1. The whole picture, to find you.
//   2. A zoomed-in look at your chest, lap and hands area. Phones are small, and this
//      second look alone finds about 1 in 8 more of them, with no extra false ones.
//   3. Close-ups around each hand, if neither look found a clear phone.

import type { HandLandmarker, ObjectDetector } from "@mediapipe/tasks-vision";

export interface Box { x: number; y: number; w: number; h: number } // 0..1 of the frame

export interface RawObject extends Box {
  label: string;
  score: number;
  dark: number; // share of dark pixels inside the box, 0..1
  light: number; // share of light pixels inside the box, 0..1
  sharp: number; // how sharp the box is next to you (1 = as sharp as you, low = blurred background)
  onYou: boolean; // overlaps the person box
  crop: boolean; // found in a zoomed-in look rather than the whole picture
  long: number; // long side, share of the frame width (for size checks against your shoulders)
}

export interface Found {
  objects: RawObject[];
  hands: Box[];
}

export interface Detectors { full: ObjectDetector; close: ObjectDetector; hands: HandLandmarker }

type Canvas2D = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Source = CanvasImageSource & (ImageBitmap | HTMLVideoElement | HTMLImageElement);

/** The size of the zoomed-in look: EfficientDet-Lite2 sees 448 x 448. */
export const ZOOM = 448;

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
    // The bigger EfficientDet. In tests the int8 version was as accurate as the full
    // float one and a third faster, so it stays.
    // "person" is the best "are you at your desk" signal; remote/laptop/tv are what gets
    // mistaken for a phone (calculator, iPad), so they're found and ruled out.
    mp.ObjectDetector.createFromOptions(fileset, opts("efficientdet_lite2.tflite", ["person", "cell phone", "remote", "laptop", "tv", "book", "keyboard"], 10)),
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
const iou = (a: Box, b: Box) => {
  const i = overlap(a, b);
  return i / (a.w * a.h + b.w * b.h - i || 1);
};

type Hit = Omit<RawObject, "sharp" | "onYou" | "dark" | "light" | "long">;

/** Runs a detector on a square piece of the picture, scaled up, and maps boxes back. */
function lookClosely(det: ObjectDetector, src: Source, W: number, H: number, zoom: Canvas2D, cx: number, cy: number, side: number, labels: string[]): Hit[] {
  const zg = zoom.getContext("2d") as Ctx2D | null;
  if (!zg) return [];
  side = Math.min(side, W, H);
  const Z = zoom.width;
  const sx = Math.max(0, Math.min(W - side, cx - side / 2)), sy = Math.max(0, Math.min(H - side, cy - side / 2));
  zg.drawImage(src, sx, sy, side, side, 0, 0, Z, Z);
  const out: Hit[] = [];
  for (const d of det.detect(zoom).detections) {
    const c = d.categories[0], b = d.boundingBox!;
    if (!labels.includes(c.categoryName)) continue;
    out.push({
      x: (sx + (b.originX / Z) * side) / W, y: (sy + (b.originY / Z) * side) / H,
      w: ((b.width / Z) * side) / W, h: ((b.height / Z) * side) / H,
      label: c.categoryName, score: c.score, crop: true,
    });
  }
  return out;
}

/** With phones off it only looks for you: no close-ups, no hands, much less work. */
export function detectObjects(d: Detectors, src: Source, W: number, H: number, probe: Canvas2D, zoom: Canvas2D, zoomSmall?: Canvas2D, phones = true): Found {
  const pg = probe.getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
  const PW = probe.width, PH = probe.height;
  pg?.drawImage(src, 0, 0, PW, PH);
  const pixels = pg?.getImageData(0, 0, PW, PH).data;
  const lum = (i: number) => (pixels ? 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] : 0);
  const region = (b: Box) => ({
    x0: Math.max(1, Math.floor(b.x * PW)), y0: Math.max(1, Math.floor(b.y * PH)),
    x1: Math.min(PW - 1, Math.ceil((b.x + b.w) * PW)), y1: Math.min(PH - 1, Math.ceil((b.y + b.h) * PH)),
  });
  // Share of dark and of near-white pixels. His phone is black/bronze; his Casio is white.
  const tones = (b: Box) => {
    if (!pixels) return { dark: 1, light: 0 };
    const r = region(b);
    let dk = 0, lt = 0, all = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++, all++) {
      const l = lum((y * PW + x) * 4);
      if (l < 90) dk++;
      else if (l > 160) lt++;
    }
    return all ? { dark: dk / all, light: lt / all } : { dark: 1, light: 0 };
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

  // 1. The whole picture. You first: only what's on or in front of you is worth looking at.
  const found: Hit[] = [];
  for (const det of d.full.detect(src).detections) {
    const c = det.categories[0], b = det.boundingBox!;
    found.push({ x: b.originX / W, y: b.originY / H, w: b.width / W, h: b.height / H, label: c.categoryName, score: c.score, crop: false });
  }
  const person = found.filter((o) => o.label === "person").sort((a, b) => b.score - a.score)[0];
  if (!phones) return { objects: person ? [{ ...person, dark: 0, light: 0, long: 0, sharp: 1, onYou: true }] : [], hands: [] };
  // Inside the You box (a little slack for a phone held out in front). With no You box
  // (out of view, or only your hands showing) everything counts, as before.
  const PAD = 0.04;
  const onYou = (o: Box) => {
    if (!person) return true;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    return cx >= person.x - PAD && cx <= person.x + person.w + PAD && cy >= person.y - PAD && cy <= person.y + person.h + PAD
      && overlap(o, person) > 0.5 * o.w * o.h;
  };

  // 2. A closer look at your chest, lap and hands: the lower part of the You box.
  const THINGS = ["cell phone", "remote", "laptop", "tv"];
  if (person && person.score >= 0.4) {
    const side = Math.max(person.w * W, 0.75 * person.h * H);
    found.push(...lookClosely(d.full, src, W, H, zoom, (person.x + person.w / 2) * W, (person.y + 0.6 * person.h) * H, side, THINGS));
  }

  // Your hands say where a phone in use would be. Hands outside the You box are someone else's.
  const hands: Box[] = d.hands.detect(src).landmarks.map((l) => {
    const xs = l.map((p) => p.x), ys = l.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }).filter(onYou);

  // 3. Still nothing clear: look closely around each hand.
  if (!found.some((o) => o.label === "cell phone" && o.score >= 0.5 && onYou(o)) && zoomSmall) {
    for (const h of hands) {
      const side = Math.max(0.3 * Math.min(W, H), 2.2 * Math.max(h.w * W, h.h * H));
      found.push(...lookClosely(d.close, src, W, H, zoomSmall, (h.x + h.w / 2) * W, (h.y + h.h / 2) * H, side, ["cell phone", "remote"]));
    }
  }

  // The same thing seen in more than one look: keep the surest.
  found.sort((a, b) => b.score - a.score);
  const kept: Hit[] = [];
  for (const o of found) if (o.label === "person" ? o === person : !kept.some((k) => k.label === o.label && iou(k, o) > 0.4)) kept.push(o);

  // Anything outside the You box is dropped, not just ignored.
  const youEdges = person ? edges(person) : 0;
  const objects: RawObject[] = kept
    .filter((o) => o === person || (o.label !== "person" && onYou(o)))
    .map((o) => {
      const long = Math.max(o.w * W, o.h * H) / W;
      if (o === person) return { ...o, dark: 0, light: 0, long, sharp: 1, onYou: true };
      const sharp = youEdges > 0 ? edges(o) / youEdges : 1;
      return { ...o, ...tones(o), long, onYou: true, sharp };
    });
  return { objects, hands };
}

// ---- Is it really your phone?

/** What the pose model says about you, to judge a phone by. */
export interface Body {
  wrists: { x: number; y: number }[];
  /** Shoulder width as a share of the frame width, if both shoulders are clear. */
  shoulders: number | null;
}

export interface Verdict { verdict: "phone" | "ignored"; why: string }

const MIN_SCORE = 0.45;
const MAX_PHONE_AREA = 0.12; // share of the frame, when your shoulders aren't in view
// A phone's long side is about 15 cm, your shoulders about 40. Held up nearer the camera
// it looks bigger, so there's plenty of room (in the photo tests 8 in 10 real phones
// were under this); a held-up iPad (25 cm) is mostly over it.
const MAX_PHONE_VS_SHOULDERS = 1.1;
// Mostly light with hardly any dark: his white Casio. His phone (black, bronze case,
// black card holder) is about half dark. The old rule ("at least a quarter dark")
// threw away 1 in 6 real phones in the photo tests; this one throws away far fewer.
const calculatorLike = (o: RawObject) => o.dark < 0.15 && o.light > 0.3;
const MIN_SHARP = 0.35; // edge strength next to yours; a blurred background is far lower
const HAND_REACH = 0.16; // a wrist this close to the box (of frame width) means it's in hand

/** Is this detection really a phone you're using, or your calculator, iPad, or something behind you? */
export function judgePhone(o: RawObject, body: Body, hands: Box[], minScore = MIN_SCORE): Verdict {
  const { label, score } = o;
  if (label !== "cell phone") return { verdict: "ignored", why: label === "remote" ? "looks like a calculator" : label === "laptop" || label === "tv" ? "looks like your iPad" : label };
  if (score < minScore) return { verdict: "ignored", why: "not sure enough" };
  if (!o.onYou) return { verdict: "ignored", why: "not on or in front of you" };
  if (o.sharp < MIN_SHARP) return { verdict: "ignored", why: "blurry, so it's in the background" };
  if (body.shoulders ? o.long > body.shoulders * MAX_PHONE_VS_SHOULDERS : o.w * o.h > MAX_PHONE_AREA) return { verdict: "ignored", why: "too big, probably your iPad" };
  if (calculatorLike(o)) return { verdict: "ignored", why: "too light, probably your calculator" };
  const near = (b: Box, pad: number) => hands.some((h) => h.x < b.x + b.w + pad && h.x + h.w > b.x - pad && h.y < b.y + b.h + pad && h.y + h.h > b.y - pad);
  if (near(o, 0.03)) return { verdict: "phone", why: "phone in your hand" };
  const nearWrist = body.wrists.some((w) => w.x > o.x - HAND_REACH && w.x < o.x + o.w + HAND_REACH && w.y > o.y - HAND_REACH && w.y < o.y + o.h + HAND_REACH);
  if (nearWrist && score >= 0.55) return { verdict: "phone", why: "phone in your hand" };
  if (!hands.length && !body.wrists.length && score >= 0.7) return { verdict: "phone", why: "phone (hands out of view)" };
  return { verdict: "ignored", why: "phone not in your hands" };
}
