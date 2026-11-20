// Camera speed test (camera plan, step 1). Grabs one frame from the camera, hands it to the
// camera worker, and turns the worker's numbers into something readable.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openCamera } from "./camtest";

export type EngineKey = "cpu1" | "cpu" | "gpu" | "gpu-low";

export const ENGINES: { key: EngineKey; name: string }[] = [
  { key: "cpu1", name: "One CPU core" },
  { key: "cpu", name: "All CPU cores" },
  { key: "gpu", name: "Graphics chip" },
  { key: "gpu-low", name: "Power-saving chip" },
];

export interface Timing {
  ms: number;
  p90: number;
  max: number;
  cpu_ms: number;
  load_ms: number;
  runs: number;
  agrees?: boolean;
}
export type Outcome = Timing | { error: string };

export interface ModelResult {
  id: string;
  label: string;
  family: "rfdetr" | "dfine" | "yolo26" | "rtmpose";
  width: number;
  height: number;
  mb: number;
  prep_ms: number;
  engines: Partial<Record<EngineKey, Outcome>>;
  found?: { cls: string; score: number; box: number[] }[];
  keypoints?: { x: number; y: number; score: number }[];
}

export interface BenchResult {
  machine: { cpu: string; threads: number; gpus: string[] };
  frame: { width: number; height: number; source: string };
  runs: number;
  models: ModelResult[];
  checks: { name: string; engines: Partial<Record<EngineKey, { ms: number; cpu_ms: number }>> }[];
  /** Whether the worker ran in its Windows sandbox (no network, camera or personal files). */
  sandbox?: { on: boolean; error?: string };
}

export interface Progress {
  step: number;
  total: number;
  model: string;
  size: number;
  where: string;
}

/** Target from the camera plan: a full check under 60 ms using the CPU alone. */
export const TARGET_MS = 60;
/** Checks run twice a second during a round. */
export const CHECKS_PER_SECOND = 2;

export const isTiming = (o: Outcome | undefined): o is Timing => !!o && "ms" in o;

/** Share of one CPU core a check costs at two checks a second, as a whole percentage. */
export const coreShare = (cpuMs: number) => Math.round((cpuMs * CHECKS_PER_SECOND) / 10);

/**
 * Takes one picture from the camera, then closes it. If the camera can't be opened, the test
 * still runs on a plain grey picture (speed doesn't depend on what's in it) and says so.
 */
export async function grabFrame(deviceId: string, live?: HTMLVideoElement | null): Promise<{ png: Uint8Array; fromCamera: boolean }> {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d")!;
  let fromCamera = false;
  let stream: MediaStream | null = null;
  try {
    let video = live && live.readyState >= 2 ? live : null;
    if (!video) {
      video = document.createElement("video");
      video.muted = true;
      stream = await openCamera(video, deviceId);
      // Give the camera a moment to settle its exposure.
      await new Promise((r) => setTimeout(r, 800));
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    fromCamera = true;
  } catch {
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("no picture"))), "image/png"));
  return { png: new Uint8Array(await blob.arrayBuffer()), fromCamera };
}

export async function runBench(png: Uint8Array, onProgress: (p: Progress) => void): Promise<BenchResult> {
  const stop = await listen<Progress>("camera-bench", (e) => onProgress(e.payload));
  try {
    return (await invoke("camera_bench", png)) as BenchResult;
  } finally {
    stop();
  }
}

const ms = (o: Outcome | undefined) => (isTiming(o) ? `${o.ms.toFixed(1)} ms` : o ? "failed" : "-");

/** Plain-text results for pasting into the chat. */
export function benchText(r: BenchResult, fromCamera: boolean): string {
  const lines = [`Camera speed test on ${r.machine.cpu} (${r.machine.threads} threads). Graphics: ${r.machine.gpus.join(", ") || "none listed"}.`];
  lines.push(fromCamera ? `Picture: your camera, ${r.frame.width}x${r.frame.height}.` : "Picture: none from the camera, timed on a grey frame.");
  lines.push(r.sandbox?.on ? "Sandbox: on (no network, camera or file access)." : `Sandbox: OFF${r.sandbox?.error ? ` (${r.sandbox.error})` : ""}.`);
  lines.push("Full check (frame + hands + posture), median:");
  for (const c of r.checks) {
    const parts = ENGINES.filter((e) => c.engines[e.key]).map((e) => `${e.name.toLowerCase()} ${c.engines[e.key]!.ms} ms`);
    const cpu = c.engines.cpu;
    lines.push(`  ${c.name}: ${parts.join(", ")}${cpu ? `; ${coreShare(cpu.cpu_ms)}% of one core at 2 checks/s` : ""}`);
  }
  lines.push("Each model:");
  for (const m of r.models) {
    const parts = ENGINES.filter((e) => m.engines[e.key]).map((e) => `${e.key} ${ms(m.engines[e.key])}`);
    const errors = ENGINES.map((e) => m.engines[e.key]).filter((o): o is { error: string } => !!o && "error" in o);
    const differs = ENGINES.some((e) => isTiming(m.engines[e.key]) && (m.engines[e.key] as Timing).agrees === false);
    const seen = m.found?.length ? `; saw ${m.found.slice(0, 3).map((d) => `${d.cls} ${Math.round(d.score * 100)}%`).join(", ")}` : "";
    lines.push(`  ${m.label} ${m.width}px (${m.mb} MB): ${parts.join(", ")}${seen}${differs ? "; GPU answer differs" : ""}${errors.length ? `; error: ${errors[0].error}` : ""}`);
  }
  return lines.join("\n");
}
