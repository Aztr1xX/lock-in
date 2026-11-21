// The live camera check (camera plan, step 2). The app's core reads the camera and runs the
// models in the sandboxed worker; this file only talks to it and words what comes back.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Camera {
  name: string;
  id: string;
  broadcast: boolean;
  /** Safe to open without asking (false for other cameras while NVIDIA Broadcast is present). */
  auto: boolean;
}

export type Presence = "here" | "away" | "unknown";
export type Health = "ok" | "covered" | "frozen";

export interface State {
  presence: Presence;
  away_since: number | null;
  phone: boolean;
  phone_hits: number;
  interrupted: boolean;
  health: Health;
}

export interface Stats {
  running_secs: number;
  checks: number;
  failed_checks: number;
  camera_frames: number;
  check_ms: number;
  longest_gap: number;
  hidden_secs: number;
  hidden_checks: number;
  rate: number;
  core_pct: number | null;
  worker_pct: number | null;
  app_pct: number | null;
  worker_restarts: number;
}

export interface Seen {
  people: number;
  person: number[] | null;
  phone: { score: number; box: number[]; near_wrist: boolean; long_side_shoulders: number | null } | null;
  drink: { score: number; box: number[]; near_wrist: boolean } | null;
  keypoints: [number, number, number][];
  hands_box: number[] | null;
  ms: { detect: number; pose: number; hands: number };
}

export type LiveEvent =
  | { kind: "away"; at: number }
  | { kind: "back"; at: number; away_secs: number }
  | { kind: "phone_start"; at: number }
  | { kind: "phone_end"; at: number; secs: number }
  | { kind: "interrupt_start"; at: number }
  | { kind: "interrupt_end"; at: number; secs: number }
  | { kind: "health"; at: number; health: Health }
  | { kind: "dark_tip"; at: number }
  | { kind: "sip"; at: number };

export type Update =
  | { type: "started"; camera: string; engine: string; check: string; sandbox: { on: boolean; error?: string }; width: number; height: number }
  | { type: "check"; state: State; stats: Stats; seen: Seen; preview?: string; brightness: number }
  | { type: "events"; events: LiveEvent[] }
  | { type: "problem"; message: string; fatal: boolean }
  | { type: "stopped"; stats: Stats };

export type Tile =
  | { type: "picture"; id: string; jpeg: string }
  | { type: "sees"; id: string; person: boolean }
  | { type: "problem"; id: string; message: string };

export const listCameras = () => invoke<Camera[]>("camera_list");
export const listChecks = () => invoke<string[]>("camera_checks");

export function startLive(o: { camera: Camera; check: string; gpu: boolean; phone: boolean }) {
  return invoke("camera_live_start", { opts: { camera_id: o.camera.id, camera_name: o.camera.name, check: o.check, gpu: o.gpu, phone: o.phone } });
}
export const stopLive = () => invoke("camera_live_stop");
export const setPreview = (on: boolean) => invoke("camera_live_preview", { on }).catch(() => {});
export const onLive = (f: (u: Update) => void): Promise<UnlistenFn> => listen<Update>("camera-live", (e) => f(e.payload));

export const startPeek = (ids: string[], check: string | null) => invoke("camera_peek_start", { ids, check });
export const stopPeek = () => invoke("camera_peek_stop").catch(() => {});
export const onTile = (f: (t: Tile) => void): Promise<UnlistenFn> => listen<Tile>("camera-peek", (e) => f(e.payload));

/** Default camera: the one picked before, else NVIDIA Broadcast, else the first. */
export function preferred(cams: Camera[], saved: string): Camera | null {
  return cams.find((c) => c.id === saved) ?? cams.find((c) => c.broadcast) ?? cams[0] ?? null;
}

/**
 * The detector the app uses unless you pick another. Chosen from the speed test: the fastest
 * Apache 2.0 model that fits the time budget without a graphics chip.
 */
export const DEFAULT_CHECK = "NanoDet-Plus";

export const duration = (s: number) => {
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60 ? `${s % 60} s` : ""}`.trim();
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** One line for the event log. */
export function describe(e: LiveEvent): string {
  switch (e.kind) {
    case "away":
      return "You left";
    case "back":
      return `Back after ${duration(e.away_secs)}`;
    case "phone_start":
      return "Phone in hand";
    case "phone_end":
      return `Phone put down after ${duration(e.secs)}`;
    case "interrupt_start":
      return "Someone else is here (counts as interrupted, not unfocused)";
    case "interrupt_end":
      return `On your own again after ${duration(e.secs)}`;
    case "health":
      return e.health === "covered" ? "The camera looks covered" : e.health === "frozen" ? "The camera picture froze" : "The camera picture is back";
    case "dark_tip":
      return "The room has been dim for 10 minutes. More light helps the camera and your eyes.";
    case "sip":
      return "Took a sip (Shrubert will water a plant for this later)";
  }
}

// ---------- your own test clips (camera plan, step 3) ----------

export interface ClipSpec {
  id: string;
  title: string;
  how: string;
  secs: number;
  expect: Record<"phone" | "away" | "unclear" | "sip" | "interrupted", boolean | null>;
}
export interface ClipMeta { id: string; camera: string; recorded_at: number; frames: number; width: number; height: number }
export interface ClipScore {
  id: string;
  passed: boolean;
  phone: boolean;
  away: boolean;
  unclear: boolean;
  sip: boolean;
  interrupted: boolean;
  phone_frames: number;
  seen_frames: number;
  frames: number;
  misses: string[];
}
export interface CheckScore { check: string; engine: string; clips: ClipScore[]; check_ms: number }

export const listClips = () => invoke<{ folder: string; clips: { spec: ClipSpec; recorded: ClipMeta | null }[] }>("clips_list");
export const recordClip = (id: string, camera: Camera) => invoke<ClipMeta>("clip_record", { id, cameraId: camera.id, cameraName: camera.name });
export const stopClips = () => invoke("clips_stop").catch(() => {});
export const deleteClips = (id: string | null) => invoke("clips_delete", { id });
export const scoreClips = (checks: string[], gpu: boolean, phone: boolean) => invoke<CheckScore[]>("clips_score", { checks, gpu, phone });
export interface ClipProgress { id: string; done: number; total: number; count: number; preview: string | null }
export const onClipProgress = (f: (p: ClipProgress) => void) => listen<ClipProgress>("clip-progress", (e) => f(e.payload));
export const onScoreProgress = (f: (p: { check: string; clip: string; done: number; total: number }) => void) =>
  listen<{ check: string; clip: string; done: number; total: number }>("clip-score-progress", (e) => f(e.payload));

/** Frames with a phone at a hand: the share of phone-in-hand frames caught, and of other frames wrongly flagged. */
export function phoneRates(clips: ClipScore[], specs: ClipSpec[]) {
  const want = (c: ClipScore) => specs.find((s) => s.id === c.id)?.expect.phone;
  const rate = (cs: ClipScore[]) => {
    const n = cs.reduce((a, c) => a + c.frames, 0);
    return n ? cs.reduce((a, c) => a + c.phone_frames * c.frames, 0) / n : null;
  };
  return { caught: rate(clips.filter((c) => want(c) === true)), wrong: rate(clips.filter((c) => want(c) === false)) };
}
