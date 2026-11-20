// Camera test: does the camera open inside the app, and can MediaPipe keep up at a low frame rate?
// It loads the same two heavy models the web app's phone check uses (pose + EfficientDet lite2),
// runs them twice a second, and measures how long each pass takes.

import { FilesetResolver, ObjectDetector, PoseLandmarker } from "@mediapipe/tasks-vision";

export interface CamStats {
  frames: number;
  avgMs: number;
  maxMs: number;
  poseDelegate: "GPU" | "CPU" | "";
  person: boolean;
  phone: number; // best "cell phone" score in the last frame, 0 to 1
  error: string;
}

const BASE = "/mediapipe";
const FPS = 2;

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput");
}

/** Prefers NVIDIA Broadcast, the same way the web app does. */
export function preferredCamera(cams: MediaDeviceInfo[]): string {
  return (cams.find((c) => /nvidia broadcast/i.test(c.label)) ?? cams[0])?.deviceId ?? "";
}

export async function openCamera(video: HTMLVideoElement, deviceId: string): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: 640, height: 480 },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

async function loadPose(fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>) {
  for (const delegate of ["GPU", "CPU"] as const) {
    try {
      const pose = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}/pose_landmarker_full.task`, delegate },
        runningMode: "VIDEO",
        numPoses: 1,
      });
      return { pose, delegate };
    } catch (e) {
      if (delegate === "CPU") throw e;
    }
  }
  throw new Error("unreachable");
}

export class CamTest {
  stats: CamStats = { frames: 0, avgMs: 0, maxMs: 0, poseDelegate: "", person: false, phone: 0, error: "" };
  private timer = 0;
  private total = 0;
  private pose?: PoseLandmarker;
  private objects?: ObjectDetector;

  constructor(private video: HTMLVideoElement, private onUpdate: (s: CamStats) => void) {}

  async start() {
    const fileset = await FilesetResolver.forVisionTasks(BASE);
    const { pose, delegate } = await loadPose(fileset);
    this.pose = pose;
    this.stats.poseDelegate = delegate;
    // The web app found this detector silently returns nothing on the GPU, so it stays on the CPU.
    this.objects = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${BASE}/efficientdet_lite2.tflite`, delegate: "CPU" },
      runningMode: "VIDEO",
      scoreThreshold: 0.2,
      maxResults: 8,
    });
    this.timer = window.setInterval(() => this.tick(), 1000 / FPS);
  }

  private tick() {
    const v = this.video;
    if (!this.pose || !this.objects || v.readyState < 2) return;
    try {
      const t0 = performance.now();
      const ts = Math.round(t0);
      const p = this.pose.detectForVideo(v, ts);
      const o = this.objects.detectForVideo(v, ts);
      const ms = performance.now() - t0;
      const cats = o.detections.flatMap((d) => d.categories);
      const s = this.stats;
      s.frames++;
      this.total += ms;
      s.avgMs = this.total / s.frames;
      s.maxMs = Math.max(s.maxMs, ms);
      s.person = p.landmarks.length > 0 || cats.some((c) => c.categoryName === "person" && c.score > 0.5);
      s.phone = Math.max(0, ...cats.filter((c) => c.categoryName === "cell phone").map((c) => c.score));
      this.onUpdate({ ...s });
    } catch (e) {
      this.stats.error = String(e);
      this.onUpdate({ ...this.stats });
    }
  }

  stop() {
    clearInterval(this.timer);
    this.pose?.close();
    this.objects?.close();
    const stream = this.video.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
  }
}

/** Share of one CPU core the detection uses: time per pass times passes per second. */
export const coreShare = (avgMs: number) => (avgMs * FPS) / 1000;
