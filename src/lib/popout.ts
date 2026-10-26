// The pop-out camera: its own always-on-top window (Chrome's Document Picture-in-Picture)
// that you can drag to any monitor and resize. It shows the live camera with the same
// overlays, the time left, and a border that flashes red for your phone and orange
// for posture.

import type { FocusCamera } from "./camera";
import { drawCam } from "./camDraw";
import type { Overlay } from "./store";

export interface PopInfo {
  clock: string;
  label: string;
  onBreak: boolean;
}

interface Options {
  overlay: () => Overlay;
  info: () => PopInfo | null;
  onClose: () => void;
}

const MIN_W = 220, MIN_H = 180, MAX_W = 960, MAX_H = 760;

type DocPip = { requestWindow: (o: { width: number; height: number }) => Promise<Window> };

export const canPopOut = () => "documentPictureInPicture" in window;

export async function openPopout(cam: FocusCamera, opts: Options): Promise<Window | null> {
  const dpip = (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture;
  if (!dpip) return null;
  const w = await dpip.requestWindow({ width: 380, height: 320 });
  const d = w.document;
  d.title = "Lock In camera";
  // Same fonts as the app, if they're loaded.
  document.querySelectorAll('link[rel="stylesheet"], link[rel="preconnect"]').forEach((l) => d.head.appendChild(l.cloneNode()));
  const style = d.createElement("style");
  style.textContent = CSS;
  d.head.appendChild(style);
  d.body.innerHTML = `
    <div class="frame">
      <canvas width="640" height="480"></canvas>
      <div class="top"><span class="clock"></span><span class="label"></span></div>
      <div class="status"><i></i><span></span></div>
    </div>`;
  const frame = d.querySelector(".frame") as HTMLDivElement;
  const canvas = d.querySelector("canvas") as HTMLCanvasElement;
  const clock = d.querySelector(".clock") as HTMLSpanElement;
  const label = d.querySelector(".label") as HTMLSpanElement;
  const status = d.querySelector(".status span") as HTMLSpanElement;

  // Detection runs on this window's clock while it's open, so a background tab can't slow it down.
  cam.setHost(w);

  let raf = 0, lastText = 0;
  const loop = (t: number) => {
    raf = w.requestAnimationFrame(loop);
    drawCam(canvas, cam, opts.overlay());
    const dbg = cam.debug;
    const tone = cam.status.state !== "on" ? "off" : !cam.status.present ? "gone" : "here";
    frame.className = `frame ${tone} ${dbg.alert ?? ""}`;
    if (t - lastText > 200) {
      lastText = t;
      const info = opts.info();
      clock.textContent = info?.clock ?? "";
      label.textContent = info?.label ?? "";
      frame.classList.toggle("break", !!info?.onBreak);
      status.textContent =
        dbg.alert === "phone" ? "Phone spotted" : dbg.alert === "posture" ? "Check your posture" : cam.status.state !== "on" ? "Camera starting…" : cam.status.present ? "Sees you" : "Can't see you";
    }
  };
  raf = w.requestAnimationFrame(loop);

  // Resizable, within reason.
  const clamp = () => {
    const cw = Math.max(MIN_W, Math.min(MAX_W, w.outerWidth));
    const ch = Math.max(MIN_H, Math.min(MAX_H, w.outerHeight));
    if (cw !== w.outerWidth || ch !== w.outerHeight) {
      try { w.resizeTo(cw, ch); } catch { /* Chrome may refuse without a click; the layout still copes */ }
    }
  };
  w.addEventListener("resize", clamp);

  w.addEventListener("pagehide", () => {
    w.cancelAnimationFrame(raf);
    cam.setHost(null);
    opts.onClose();
  });
  return w;
}

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #0d1418; color: #e9f2ee; overflow: hidden;
  font-family: "Bricolage Grotesque", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.frame { position: fixed; inset: 0; border: 4px solid #243540; border-radius: 14px; overflow: hidden; background: #000;
  transition: border-color 0.4s; }
.frame.here { border-color: #5ee0a0; }
.frame.gone { border-color: #8da39b; }
.frame.phone { animation: flash-red 0.9s ease-in-out infinite; }
.frame.posture { animation: flash-orange 1.4s ease-in-out infinite; }
@keyframes flash-red { 0%, 100% { border-color: #ff4d5e; box-shadow: inset 0 0 0 2px #ff4d5e, inset 0 0 40px rgba(255,77,94,0.55); } 50% { border-color: rgba(255,77,94,0.25); box-shadow: inset 0 0 0 0 transparent; } }
@keyframes flash-orange { 0%, 100% { border-color: #ff9f2e; box-shadow: inset 0 0 0 2px #ff9f2e, inset 0 0 36px rgba(255,159,46,0.45); } 50% { border-color: rgba(255,159,46,0.25); box-shadow: inset 0 0 0 0 transparent; } }
canvas { width: 100%; height: 100%; display: block; object-fit: contain; }
.top { position: absolute; top: 8px; left: 10px; right: 10px; display: flex; align-items: baseline; gap: 8px; pointer-events: none; }
.clock { font-family: "JetBrains Mono", Consolas, monospace; font-weight: 700; font-size: clamp(16px, 7vw, 34px);
  padding: 2px 10px; border-radius: 10px; background: rgba(13,20,24,0.72); }
.frame.break .clock { color: #ffb86b; }
.label { font-size: clamp(11px, 3.2vw, 14px); font-weight: 700; padding: 3px 8px; border-radius: 999px; background: rgba(13,20,24,0.6); color: #b9cbc3; }
.label:empty, .clock:empty { display: none; }
.status { position: absolute; left: 10px; bottom: 10px; display: inline-flex; align-items: center; gap: 6px; pointer-events: none;
  padding: 4px 10px; border-radius: 999px; background: rgba(13,20,24,0.75); font-size: 13px; font-weight: 700; }
.status i { width: 8px; height: 8px; border-radius: 50%; background: #8da39b; }
.here .status i { background: #5ee0a0; }
.phone .status i { background: #ff4d5e; }
.posture .status i { background: #ff9f2e; }
`;
