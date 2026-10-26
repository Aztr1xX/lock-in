// The camera coach. Everything here runs inside this browser tab: frames are read,
// turned into a few numbers, and thrown away. Only time-lapse snapshots are kept,
// and they're saved in this browser on this PC.
//
// Built so looking down at an iPad still counts as "at your desk": presence comes
// from head-and-shoulders pose, not from seeing your face.

import type { FaceLandmarker, ObjectDetector, PoseLandmarker } from "@mediapipe/tasks-vision";

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

export interface TracePoint {
  t: number; // minute start (ms)
  s: number; // focus score 0..1
}

interface Models {
  pose: PoseLandmarker;
  face: FaceLandmarker;
  objects: ObjectDetector;
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
    const [pose, face, objects] = await Promise.all([
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
      make((delegate) =>
        mp.ObjectDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "/mediapipe/efficientdet_lite0.tflite", delegate },
          runningMode: "VIDEO",
          scoreThreshold: 0.35,
          categoryAllowlist: ["cell phone"],
          maxResults: 2,
        }),
      ),
    ]);
    return { pose, face, objects };
  })();
  modelsPromise.catch(() => (modelsPromise = null));
  return modelsPromise;
}

const AWAY_MS = 60_000;
const BACK_MS = 2_000;
const PHONE_HITS = 3; // consecutive phone sightings (~1.5 s apart)
const PHONE_COOLDOWN = 3 * 60_000;
const POSTURE_HOLD = 3 * 60_000;
const POSTURE_COOLDOWN = 10 * 60_000;
const CALIBRATE_MS = 45_000;
const EYES_CLOSED_MS = 2_500;
const YAWN_MS = 1_500;
const DROWSY_COOLDOWN = 10 * 60_000;
const TICK_MS = 500;
const FRAME_MS = 10_000;

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

  setFeatures(f: CamFeatures) {
    this.features = f;
  }

  async start() {
    this.setStatus({ state: "loading" });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 }, facingMode: "user" },
        audio: false,
      });
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      this.setStatus({ state: denied ? "denied" : "error" });
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    try {
      this.models = await loadModels();
    } catch {
      this.setStatus({ state: "error" });
      this.stop();
      return;
    }
    if (!this.stream) return; // stopped while loading
    this.lastSeen = Date.now();
    this.setStatus({ state: "on" });
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
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
    if (lm) {
      const vis = (i: number) => (lm[i]?.visibility ?? 0) > 0.5;
      const ls = lm[11], rs = lm[12];
      const headSeen = [0, 2, 5, 7, 8].some(vis);
      const shouldersSeen = vis(11) && vis(12);
      present = headSeen || shouldersSeen;
      if (shouldersSeen) shoulders = { w: Math.hypot(ls.x - rs.x, ls.y - rs.y), y: (ls.y + rs.y) / 2 };
    }

    // ---- face: eyes and yawns, only when you're facing the screen
    let faceVisible = false;
    let eyesClosed = false;
    let jawOpen = 0;
    const face = this.models.face.detectForVideo(v, ts);
    if (face.faceLandmarks.length) {
      present = true;
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

    // ---- phone, checked every 1.5 s
    let phone = false;
    if (this.tickN % 3 === 0) {
      const det = this.models.objects.detectForVideo(v, ts);
      phone = det.detections.some((d) => d.categories.some((c) => c.categoryName === "cell phone" && c.score > 0.4));
      this.phoneHits = phone ? this.phoneHits + 1 : 0;
    }

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
      if (!this.isAway && now - this.lastSeen >= AWAY_MS) {
        this.isAway = true;
        this.counts.away++;
        if (this.features.away) this.onEvent("away");
      }
    }

    // phone
    if (this.phoneHits >= PHONE_HITS && now - this.lastPhoneNudge > PHONE_COOLDOWN) {
      this.lastPhoneNudge = now;
      this.phoneHits = 0;
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
        if (now - this.calibStart >= CALIBRATE_MS && this.calib.w.length >= 20) {
          const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
          this.base = { w: med(this.calib.w), y: med(this.calib.y) };
          this.onEvent("calibrated");
        }
      } else if (this.base) {
        const slouched = shoulders.w > this.base.w * 1.18 || shoulders.y > this.base.y + 0.08;
        if (slouched) {
          if (!this.slouchSince) this.slouchSince = now;
          if (now - this.slouchSince >= POSTURE_HOLD && now - this.lastPosture > POSTURE_COOLDOWN) {
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
    if (drowsy && now - this.lastDrowsy > DROWSY_COOLDOWN) {
      this.lastDrowsy = now;
      this.counts.drowsy++;
      if (this.features.drowsy) this.onEvent("drowsy");
    }

    // focus score for this minute
    const good = present && this.phoneHits === 0 && !eyesClosed ? 1 : 0;
    const mt = Math.floor(now / 60_000) * 60_000;
    if (this.minute.t !== mt) {
      this.flushMinute();
      this.minute = { t: mt, n: 0, good: 0 };
    }
    this.minute.n++;
    this.minute.good += good;
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
