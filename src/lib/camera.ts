// The camera coach. Everything here runs inside this browser tab: frames are read,
// turned into a few numbers, and thrown away. Only time-lapse snapshots are kept,
// and they're saved in this browser on this PC.
//
// Built so looking down at an iPad still counts as "at your desk": presence comes
// from head-and-shoulders pose, not from seeing your face.

import type { FaceLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import { type Box, type Detectors, type Found, type RawObject, detectObjects, makeDetectors } from "./objects";
import ObjectsWorker from "./objects.worker?worker";

export type CamEvent = "away" | "back" | "phone" | "posture" | "drowsy" | "calibrated";

export interface CamFeatures {
  away: boolean;
  phone: boolean;
  posture: boolean;
  drowsy: boolean;
  timelapse: boolean;
}

export interface CamStatus {
  state: "off" | "loading" | "on" | "denied" | "error";
  present: boolean;
  faceVisible: boolean;
}

export interface DebugObject {
  x: number; y: number; w: number; h: number; // 0..1 of the frame
  label: string;
  score: number;
  verdict: "phone" | "ignored" | "you";
  why: string;
}

/** What the camera worked out on its last look. Drawn by the camera check screen. */
export interface CamDebug {
  points: { x: number; y: number; part: "head" | "shoulder" | "wrist" }[];
  face: { x: number; y: number; w: number; h: number } | null;
  objects: DebugObject[];
  hands: { x: number; y: number; w: number; h: number }[];
  present: boolean;
  faceVisible: boolean;
  eyesClosed: boolean;
  yawning: boolean;
  lookingDown: boolean;
  phoneHits: number;
  /** How sure it is that you're on your phone right now, 0..1. It warns at 1. */
  phoneSure: number;
  posture: "calibrating" | "good" | "hunched" | "unknown";
  /** What the camera border should flash: red for phone, orange for posture. */
  alert: "phone" | "posture" | null;
}

export interface TracePoint {
  t: number; // minute start (ms)
  s: number; // focus score 0..1
}

interface Models {
  pose: PoseLandmarker;
  face: FaceLandmarker;
}

let modelsPromise: Promise<Models> | null = null;

function loadModels(): Promise<Models> {
  modelsPromise ??= (async () => {
    const mp = await import("@mediapipe/tasks-vision");
    const fileset = await mp.FilesetResolver.forVisionTasks("/mediapipe");
    const make = async <T,>(fn: (d: "GPU" | "CPU") => Promise<T>) => {
      try {
        return await fn("GPU");
      } catch {
        return await fn("CPU");
      }
    };
    const [pose, face] = await Promise.all([
      make((delegate) =>
        mp.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "/mediapipe/pose_landmarker_lite.task", delegate },
          runningMode: "VIDEO",
          numPoses: 1,
        }),
      ),
      make((delegate) =>
        mp.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        }),
      ),
    ]);
    return { pose, face };
  })();
  modelsPromise.catch(() => (modelsPromise = null));
  return modelsPromise;
}

/**
 * Finds people and phones in a background worker so it never holds up the timer or
 * animations. Falls back to running here if workers aren't available. One for the app.
 */
class ObjectFinder {
  private worker: Worker | null = null;
  private local: Detectors | null = null;
  private ready: Promise<void> | null = null;
  private waiting = new Map<number, (o: Found | null) => void>();
  private n = 0;
  busy = false;
  private probe = document.createElement("canvas");
  private zoom = document.createElement("canvas");

  init(): Promise<void> {
    this.ready ??= this.startWorker().catch(async () => {
      this.worker?.terminate();
      this.worker = null;
      this.probe.width = 320; this.probe.height = 240;
      this.zoom.width = this.zoom.height = 320;
      this.local = await makeDetectors("/mediapipe");
    });
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  private startWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return reject(new Error("no offscreen"));
      const w = new ObjectsWorker();
      this.worker = w;
      const t = setTimeout(() => reject(new Error("worker timeout")), 45_000);
      w.onerror = () => { clearTimeout(t); reject(new Error("worker failed")); };
      w.onmessage = (e) => {
        const m = e.data as { id: number; ready?: boolean; found?: Found; error?: string };
        if (m.ready) { clearTimeout(t); resolve(); return; }
        if (m.error && m.id === 0) { clearTimeout(t); reject(new Error(m.error)); return; }
        const done = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        done?.(m.found ?? null);
      };
      w.postMessage({ id: 0, base: "/mediapipe" });
    });
  }

  async find(v: HTMLVideoElement): Promise<Found | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      if (this.local) return detectObjects(this.local, v, v.videoWidth, v.videoHeight, this.probe, this.zoom);
      if (!this.worker) return null;
      const frame = await createImageBitmap(v);
      const id = ++this.n;
      return await new Promise<Found | null>((res) => {
        this.waiting.set(id, res);
        setTimeout(() => { if (this.waiting.delete(id)) res(null); }, 5_000);
        this.worker!.postMessage({ id, frame }, [frame]);
      });
    } catch {
      return null;
    } finally {
      this.busy = false;
    }
  }
}

let finder: ObjectFinder | null = null;
const getFinder = () => (finder ??= new ObjectFinder());

// Only "ideal" values: virtual cameras like NVIDIA Broadcast offer a few fixed modes,
// and a hard limit they can't meet makes Chrome refuse them.
const CAM_CONSTRAINTS = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } };
const NVIDIA = /nvidia broadcast/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The camera to open, without opening anything to find out. Never the physical webcam
 * when NVIDIA Broadcast is there: Broadcast needs that webcam for itself, and if this
 * page grabs it, even for a moment, Broadcast falls back to its "no camera" picture.
 */
function chooseCamera(cams: MediaDeviceInfo[], picked: string): string {
  if (picked && cams.some((c) => c.deviceId === picked)) return picked;
  return cams.find((c) => NVIDIA.test(c.label))?.deviceId ?? picked;
}

/** Opens a camera, falling back to the default one if the chosen camera is gone. */
let lastOpened = ""; // the device asked for, for cameras that don't report their id
async function openCamera(id: string): Promise<MediaStream> {
  lastOpened = id;
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { ...CAM_CONSTRAINTS, deviceId: { exact: id } }, audio: false });
    } catch (e) {
      if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")) throw e;
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: { ...CAM_CONSTRAINTS, facingMode: "user" }, audio: false });
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  } catch {
    return [];
  }
}

const AWAY_MS = 10_000; // default; Settings can change it
const PERSON_SCORE = 0.45;
const PERSON_KEEP = 3_000; // a person sighting counts as "here" for this long
const BACK_MS = 2_000;
// A phone warning needs a steady, confident sighting: seen in 6 of the last 8 checks
// (about 8 seconds), at 50% or more on average. One-off false sightings never add up.
const PHONE_HITS = 6;
const PHONE_WINDOW = 8;
const PHONE_MEAN = 0.5;
const POSTURE_FLASH = 10_000; // hunched this long before the border turns orange
const PHONE_COOLDOWN = 3 * 60_000;
const POSTURE_HOLD = 3 * 60_000;
const POSTURE_COOLDOWN = 10 * 60_000;
const CALIBRATE_MS = 45_000;
const EYES_CLOSED_MS = 2_500;
const YAWN_MS = 1_500;
const DROWSY_COOLDOWN = 10 * 60_000;
const TICK_MS = 500;
// Phone vs the other things on Ryan's desk. His phone is dark and small; his Casio is
// light grey/white; his iPad is far bigger in frame.
const MAX_PHONE_AREA = 0.12; // share of the frame; an iPad at desk distance is bigger
const MIN_DARK = 0.25; // share of dark pixels. His phone is black (a card in the back holder adds a light patch); the Casio is mostly white
const MIN_SHARP = 0.35; // edge strength next to yours; a blurred background is far lower
const HAND_REACH = 0.16; // a wrist this close to the box (of frame width) means it's in hand
const FRAME_MS = 10_000;
const NORMAL = { calibrate: CALIBRATE_MS, postureHold: POSTURE_HOLD, postureCool: POSTURE_COOLDOWN, phoneCool: PHONE_COOLDOWN, drowsyCool: DROWSY_COOLDOWN };
// Test runs: everything fires fast so you can try it in a minute.
const QUICK = { away: 5_000, calibrate: 10_000, postureHold: 15_000, postureCool: 30_000, phoneCool: 20_000, drowsyCool: 30_000 };

export class FocusCamera {
  video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private models: Models | null = null;
  private timer: number | null = null;
  private lastTs = 0;
  private tickN = 0;

  status: CamStatus = { state: "off", present: false, faceVisible: false };
  private active = false; // detection runs only during focus, not breaks

  // presence
  private lastSeen = 0;
  private seenSince = 0;
  private isAway = false;
  // phone
  private phoneHits = 0;
  private phoneLog: number[] = []; // best phone score per check, 0 when none
  private personAt = 0;
  private lastPhoneNudge = 0;
  // posture
  private calib: { w: number[]; y: number[] } = { w: [], y: [] };
  private calibStart = 0;
  private base: { w: number; y: number } | null = null;
  private slouchSince = 0;
  private lastPosture = 0;
  // drowsy
  private eyesClosedSince = 0;
  private jawSince = 0;
  private yawns: number[] = [];
  private lastDrowsy = 0;
  // focus trace
  private minute = { t: 0, n: 0, good: 0 };
  trace: TracePoint[] = [];
  counts = { phone: 0, posture: 0, drowsy: 0, away: 0 };
  // time-lapse
  private lastFrame = 0;
  private snap = document.createElement("canvas");
  debug: CamDebug = {
    points: [], face: null, objects: [], hands: [], present: false, faceVisible: false,
    eyesClosed: false, yawning: false, lookingDown: false, phoneHits: 0, phoneSure: 0, posture: "unknown", alert: null,
  };

  constructor(
    private features: CamFeatures,
    private onEvent: (e: CamEvent) => void,
    private onStatus: (s: CamStatus) => void,
    private onFrame: (b: Blob) => void,
  ) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.snap.width = 320;
    this.snap.height = 240;
  }

  private k = NORMAL;
  setQuick(on: boolean) {
    this.k = on ? QUICK : NORMAL;
  }

  /** How long you can be out of view before the timer pauses. Test runs keep their quick 5 s. */
  private awayMs = AWAY_MS;
  setAwayMs(ms: number) {
    this.awayMs = Math.max(3_000, ms);
  }

  /**
   * Which window's clock drives detection. A popped-out camera window stays visible,
   * so its timers keep running at full speed even when this tab is in the background.
   */
  private host: Window = window;
  setHost(w: Window | null) {
    const next = w ?? window;
    if (next === this.host) return;
    if (this.timer) {
      this.host.clearInterval(this.timer);
      this.timer = next.setInterval(() => this.tick(), TICK_MS);
    }
    this.host = next;
  }

  setFeatures(f: CamFeatures) {
    this.features = f;
  }

  private stopped = false;
  private cameraId = "";

  /** Which camera to use ("" = the default, or NVIDIA Broadcast if present). Switches live. */
  async setCamera(id: string) {
    if (id === this.cameraId) return;
    this.cameraId = id;
    if (!this.stream) return;
    // Let go of the old camera first. Holding the webcam while opening Broadcast is
    // exactly what makes Broadcast lose its picture.
    const was = this.currentCamera();
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    await sleep(400);
    if (this.stopped) return;
    const cams = await listCameras();
    let next: MediaStream;
    try {
      next = await openCamera(chooseCamera(cams, id));
    } catch {
      next = await openCamera(was).catch(() => null as unknown as MediaStream);
      if (!next) return this.setStatus({ state: "error" });
    }
    if (this.stopped) return next.getTracks().forEach((t) => t.stop());
    this.stream = next;
    this.video.srcObject = next;
    await this.video.play().catch(() => {});
  }

  /** The camera actually in use, for the picker. */
  currentCamera() {
    const t = this.stream?.getVideoTracks()[0];
    return t ? t.getSettings().deviceId || lastOpened : "";
  }

  async start() {
    this.stopped = false;
    this.setStatus({ state: "loading" });
    try {
      // Camera names are known once the camera has been allowed before, so normally this
      // goes straight to the right one.
      const cams = await listCameras();
      const known = cams.some((c) => c.label);
      this.stream = await openCamera(chooseCamera(cams, this.cameraId));
      if (!known && !this.cameraId) {
        // Very first time: names only appear after this first open. If that was the webcam
        // and Broadcast is there, let go of the webcam and give Broadcast a moment to take it back.
        const nv = (await listCameras()).find((c) => NVIDIA.test(c.label));
        if (nv && nv.deviceId !== this.currentCamera()) {
          this.stream.getTracks().forEach((t) => t.stop());
          await sleep(1500);
          this.stream = await openCamera(nv.deviceId);
        }
      }
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      this.setStatus({ state: denied ? "denied" : "error" });
      return;
    }
    if (this.stopped) {
      this.stream.getTracks().forEach((t) => t.stop()); // closed before the camera came on
      this.stream = null;
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    try {
      [this.models] = await Promise.all([loadModels(), getFinder().init()]);
    } catch {
      this.setStatus({ state: "error" });
      this.stop();
      return;
    }
    if (!this.stream) return; // stopped while loading
    this.lastSeen = Date.now();
    this.setStatus({ state: "on" });
    this.timer = this.host.setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.host.clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.flushMinute(true);
    this.setStatus({ state: "off", present: false, faceVisible: false });
  }

  /** Detection only counts during focus. Breaks are for walking away. */
  setFocusing(on: boolean) {
    if (on === this.active) return;
    this.active = on;
    const now = Date.now();
    this.lastSeen = now;
    this.isAway = false;
    this.slouchSince = 0;
    this.eyesClosedSince = 0;
    this.phoneHits = 0;
    this.phoneLog = [];
    if (on && !this.base && !this.calibStart) this.calibStart = now;
  }

  private setStatus(p: Partial<CamStatus>) {
    this.status = { ...this.status, ...p };
    this.onStatus(this.status);
  }

  private tick() {
    const v = this.video;
    if (!this.models || v.readyState < 2 || !v.videoWidth) return;
    const now = Date.now();
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    this.tickN++;

    // ---- pose: are you here, how are you sitting
    const pose = this.models.pose.detectForVideo(v, ts);
    const lm = pose.landmarks[0];
    let present = false;
    let shoulders: { w: number; y: number } | null = null;
    const points: CamDebug["points"] = [];
    const wrists: { x: number; y: number }[] = [];
    if (lm) {
      const parts: [number, CamDebug["points"][number]["part"]][] = [[0, "head"], [2, "head"], [5, "head"], [7, "head"], [8, "head"], [11, "shoulder"], [12, "shoulder"], [15, "wrist"], [16, "wrist"]];
      for (const [i, part] of parts) {
        const p = lm[i];
        if (p && (p.visibility ?? 0) > 0.5) points.push({ x: p.x, y: p.y, part });
        if (p && part === "wrist" && (p.visibility ?? 0) > 0.3) wrists.push({ x: p.x, y: p.y });
      }
      const vis = (i: number) => (lm[i]?.visibility ?? 0) > 0.5;
      const ls = lm[11], rs = lm[12];
      const shouldersSeen = vis(11) && vis(12);
      // Pose alone can "find" someone in an empty chair, so it only counts when it's confident.
      const sure = (i: number) => (lm[i]?.visibility ?? 0) > 0.8;
      present = [0, 2, 5, 7, 8].filter(sure).length >= 2 || (sure(11) && sure(12));
      if (shouldersSeen) shoulders = { w: Math.hypot(ls.x - rs.x, ls.y - rs.y), y: (ls.y + rs.y) / 2 };
    }

    // ---- face: eyes and yawns, only when you're facing the screen
    let faceVisible = false;
    let eyesClosed = false;
    let jawOpen = 0;
    let faceBox: CamDebug["face"] = null;
    const face = this.models.face.detectForVideo(v, ts);
    if (face.faceLandmarks.length) {
      present = true;
      const fl = face.faceLandmarks[0];
      const xs = fl.map((p) => p.x), ys = fl.map((p) => p.y);
      faceBox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const m = face.facialTransformationMatrixes?.[0]?.data;
      // Head pitch from the transform matrix; looking down at an iPad tilts it a lot.
      // Column-major 4x4: pitch is the rotation about x, atan2(r21, r22).
      const pitch = m ? (Math.atan2(m[6], m[10]) * 180) / Math.PI : 0;
      faceVisible = Math.abs(pitch) < 20;
      const bs = face.faceBlendshapes?.[0]?.categories ?? [];
      const get = (n: string) => bs.find((c) => c.categoryName === n)?.score ?? 0;
      eyesClosed = faceVisible && get("eyeBlinkLeft") > 0.6 && get("eyeBlinkRight") > 0.6;
      jawOpen = get("jawOpen");
    }

    // ---- person and phone, checked about every second (in the background)
    if (this.tickN % 2 === 0 && !getFinder().busy) {
      const seenWrists = wrists;
      void getFinder().find(v).then((f) => f && this.stream && this.onObjects(f, seenWrists, Date.now()));
    }
    const personSeen = now - this.personAt < PERSON_KEEP;
    if (personSeen) present = true;

    const yawning = jawOpen > 0.55;
    this.debug = {
      ...this.debug,
      points,
      face: faceBox,
      present,
      faceVisible,
      eyesClosed,
      yawning,
      lookingDown: !!faceBox && !faceVisible,
      phoneHits: this.phoneHits,
      phoneSure: this.phoneSure(),
      posture: !this.base ? (this.calibStart ? "calibrating" : "unknown") : this.slouchSince ? "hunched" : "good",
      alert: this.phoneHits >= 4 && this.phoneSure() >= 0.6 ? "phone" : this.slouchSince && now - this.slouchSince >= POSTURE_FLASH ? "posture" : null,
    };

    if (present !== this.status.present || faceVisible !== this.status.faceVisible) this.setStatus({ present, faceVisible });

    // ---- time-lapse snapshot (focus and breaks both, it's your session)
    if (this.features.timelapse && now - this.lastFrame >= FRAME_MS) {
      this.lastFrame = now;
      const g = this.snap.getContext("2d");
      if (g) {
        g.save();
        g.translate(320, 0);
        g.scale(-1, 1);
        g.drawImage(v, 0, 0, 320, 240);
        g.restore();
        this.snap.toBlob((b) => b && this.onFrame(b), "image/jpeg", 0.7);
      }
    }

    if (!this.active) return;

    // presence
    if (present) {
      this.lastSeen = now;
      if (!this.seenSince) this.seenSince = now;
      if (this.isAway && now - this.seenSince >= BACK_MS) {
        this.isAway = false;
        if (this.features.away) this.onEvent("back");
      }
    } else {
      this.seenSince = 0;
      if (!this.isAway && now - this.lastSeen >= (this.k === QUICK ? QUICK.away : this.awayMs)) {
        this.isAway = true;
        this.counts.away++;
        if (this.features.away) this.onEvent("away");
      }
    }

    // phone
    if (this.phoneSure() >= 1 && now - this.lastPhoneNudge > this.k.phoneCool) {
      this.lastPhoneNudge = now;
      this.phoneHits = 0;
      this.phoneLog = [];
      this.counts.phone++;
      if (this.features.phone) this.onEvent("phone");
    }

    // posture: calibrate on how you normally sit, then watch for a hunch that sticks.
    // Leaning in (shoulders wider in frame) or sinking (shoulders lower) counts.
    // Just tilting your head down to your iPad doesn't.
    if (shoulders) {
      if (!this.base && this.calibStart) {
        this.calib.w.push(shoulders.w);
        this.calib.y.push(shoulders.y);
        if (now - this.calibStart >= this.k.calibrate && this.calib.w.length >= 15) {
          const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
          this.base = { w: med(this.calib.w), y: med(this.calib.y) };
          this.onEvent("calibrated");
        }
      } else if (this.base) {
        const slouched = shoulders.w > this.base.w * 1.18 || shoulders.y > this.base.y + 0.08;
        if (slouched) {
          if (!this.slouchSince) this.slouchSince = now;
          if (now - this.slouchSince >= this.k.postureHold && now - this.lastPosture > this.k.postureCool) {
            this.lastPosture = now;
            this.slouchSince = 0;
            this.counts.posture++;
            if (this.features.posture) this.onEvent("posture");
          }
        } else this.slouchSince = 0;
      }
    }

    // drowsy: long eye closures, or three big yawns in ten minutes
    let drowsy = false;
    if (eyesClosed) {
      if (!this.eyesClosedSince) this.eyesClosedSince = now;
      if (now - this.eyesClosedSince >= EYES_CLOSED_MS) {
        drowsy = true;
        this.eyesClosedSince = 0;
      }
    } else this.eyesClosedSince = 0;
    if (jawOpen > 0.55) {
      if (!this.jawSince) this.jawSince = now;
    } else {
      if (this.jawSince && now - this.jawSince >= YAWN_MS) this.yawns.push(now);
      this.jawSince = 0;
    }
    this.yawns = this.yawns.filter((t) => now - t < 10 * 60_000);
    if (this.yawns.length >= 3) {
      drowsy = true;
      this.yawns = [];
    }
    if (drowsy && now - this.lastDrowsy > this.k.drowsyCool) {
      this.lastDrowsy = now;
      this.counts.drowsy++;
      if (this.features.drowsy) this.onEvent("drowsy");
    }

    // focus score for this minute
    const good = present && this.phoneSure() < 0.6 && !eyesClosed ? 1 : 0;
    const mt = Math.floor(now / 60_000) * 60_000;
    if (this.minute.t !== mt) {
      this.flushMinute();
      this.minute = { t: mt, n: 0, good: 0 };
    }
    this.minute.n++;
    this.minute.good += good;
  }

  private onObjects(found: Found, wrists: { x: number; y: number }[], now: number) {
    const objects: DebugObject[] = [];
    for (const o of found.objects) {
      const box = { x: o.x, y: o.y, w: o.w, h: o.h };
      if (o.label === "person") {
        if (o.score >= PERSON_SCORE) {
          this.personAt = now;
          objects.push({ ...box, label: "person", score: o.score, verdict: "you", why: "you" });
        }
        continue;
      }
      objects.push({ ...box, label: o.label, score: o.score, ...this.judgePhone(o, wrists, found.hands) });
    }
    this.debug = { ...this.debug, objects, hands: found.hands };
    const best = Math.max(0, ...objects.filter((o) => o.verdict === "phone").map((o) => o.score));
    this.phoneLog = [...this.phoneLog, best].slice(-PHONE_WINDOW);
    this.phoneHits = this.phoneLog.filter((x) => x > 0).length;
  }

  private phoneSure() {
    const seen = this.phoneLog.filter((x) => x > 0);
    if (!seen.length) return 0;
    const mean = seen.reduce((a, b) => a + b, 0) / seen.length;
    return Math.min(1, seen.length / PHONE_HITS) * Math.min(1, mean / PHONE_MEAN);
  }

  /** Is this detection really a phone you're using, or your calculator, iPad, or something behind you? */
  private judgePhone(o: RawObject, wrists: { x: number; y: number }[], hands: Box[]): { verdict: DebugObject["verdict"]; why: string } {
    const { label, score } = o;
    if (label !== "cell phone") return { verdict: "ignored", why: label === "remote" ? "looks like a calculator" : label === "laptop" || label === "tv" ? "looks like your iPad" : label };
    if (score < (o.crop ? 0.5 : 0.45)) return { verdict: "ignored", why: "not sure enough" };
    if (!o.onYou) return { verdict: "ignored", why: "not on or in front of you" };
    if (o.sharp < MIN_SHARP) return { verdict: "ignored", why: "blurry, so it's in the background" };
    if (o.w * o.h > MAX_PHONE_AREA) return { verdict: "ignored", why: "too big, probably your iPad" };
    if (o.dark < MIN_DARK) return { verdict: "ignored", why: "too light, probably your calculator" };
    const near = (b: Box, pad: number) => hands.some((h) => h.x < b.x + b.w + pad && h.x + h.w > b.x - pad && h.y < b.y + b.h + pad && h.y + h.h > b.y - pad);
    if (near(o, 0.03)) return { verdict: "phone", why: "phone in your hand" };
    const nearWrist = wrists.some((w) => w.x > o.x - HAND_REACH && w.x < o.x + o.w + HAND_REACH && w.y > o.y - HAND_REACH && w.y < o.y + o.h + HAND_REACH);
    if (nearWrist && score >= 0.55) return { verdict: "phone", why: "phone in your hand" };
    if (!hands.length && !wrists.length && score >= 0.7) return { verdict: "phone", why: "phone (hands out of view)" };
    return { verdict: "ignored", why: "phone not in your hands" };
  }

  private flushMinute(force = false) {
    const m = this.minute;
    if (m.t && m.n >= (force ? 1 : 20)) this.trace.push({ t: m.t, s: Math.round((m.good / m.n) * 100) / 100 });
    this.minute = { t: 0, n: 0, good: 0 };
  }

  takeTrace(): TracePoint[] {
    this.flushMinute(true);
    return this.trace;
  }
}
