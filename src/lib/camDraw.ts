// Draws the camera picture plus what the coach worked out, for the check sheet and the session preview.
import type { CamDebug, FocusCamera } from "./camera";
import type { Overlay } from "./store";

const ALL: Overlay = { you: true, face: true, head: true, shoulders: true, hands: true, things: true };

export const nice = (label: string) =>
  label === "remote" ? "Calculator?" : label === "laptop" || label === "tv" ? "iPad?" : label === "person" ? "You" : label[0].toUpperCase() + label.slice(1);

/** Paints one frame onto a canvas of any size: mirrored picture, then the overlays. */
export function drawCam(canvas: HTMLCanvasElement, cam: FocusCamera, show: Overlay = ALL) {
  const g = canvas.getContext("2d");
  const v = cam.video;
  if (!g || v.readyState < 2) return false;
  const W = canvas.width, H = canvas.height;
  g.save();
  g.translate(W, 0);
  g.scale(-1, 1); // mirror, so it moves like a mirror does
  g.drawImage(v, 0, 0, W, H);
  g.restore();
  overlay(g, cam.debug, W, H, show);
  return true;
}

function overlay(g: CanvasRenderingContext2D, d: CamDebug, W: number, H: number, show: Overlay) {
  const k = W / 640; // line widths and text scale with the canvas
  const X = (x: number) => (1 - x) * W; // mirrored to match the picture
  const css = getComputedStyle(document.documentElement);
  const c = {
    head: css.getPropertyValue("--accent").trim() || "#5ee0a0",
    shoulder: "#7cc4ff",
    wrist: "#ffb86b",
    phone: "#ff7d8a",
    ignored: "rgba(255,255,255,0.55)",
  };
  g.lineWidth = Math.max(1.5, 3 * k);
  g.font = `600 ${Math.max(10, Math.round(15 * k))}px 'Bricolage Grotesque', system-ui, sans-serif`;

  if (d.face && show.face) {
    g.setLineDash([6 * k, 6 * k]);
    g.strokeStyle = c.head;
    g.strokeRect(X(d.face.x + d.face.w), d.face.y * H, d.face.w * W, d.face.h * H);
    g.setLineDash([]);
  }
  const sh = d.points.filter((p) => p.part === "shoulder");
  if (sh.length === 2 && show.shoulders) {
    g.strokeStyle = c.shoulder;
    g.beginPath();
    g.moveTo(X(sh[0].x), sh[0].y * H);
    g.lineTo(X(sh[1].x), sh[1].y * H);
    g.stroke();
  }
  if (show.hands) {
    g.strokeStyle = c.wrist;
    g.setLineDash([4 * k, 4 * k]);
    for (const h of d.hands ?? []) g.strokeRect(X(h.x + h.w), h.y * H, h.w * W, h.h * H);
    g.setLineDash([]);
  }
  for (const p of d.points) {
    if (!(p.part === "head" ? show.head : p.part === "shoulder" ? show.shoulders : show.hands)) continue;
    g.fillStyle = c[p.part];
    g.beginPath();
    g.arc(X(p.x), p.y * H, (p.part === "head" ? 5 : 7) * Math.max(0.6, k), 0, Math.PI * 2);
    g.fill();
  }
  for (const o of d.objects) {
    if (o.verdict === "you" ? !show.you : !show.things) continue;
    const col = o.verdict === "phone" ? c.phone : o.verdict === "you" ? c.head : c.ignored;
    const x = X(o.x + o.w), y = o.y * H, w = o.w * W, h = o.h * H;
    g.strokeStyle = col;
    g.globalAlpha = o.verdict === "you" ? 0.6 : 1;
    g.beginPath();
    g.roundRect(x, y, w, h, 8 * k);
    g.stroke();
    g.globalAlpha = 1;
    const text = `${o.verdict === "phone" ? "Phone" : nice(o.label)} · ${Math.round(o.score * 100)}%`;
    const th = 22 * Math.max(0.6, k);
    const tw = g.measureText(text).width + 14 * k;
    const ty = o.verdict === "you" ? y + 2 : Math.max(0, y - th - 2);
    g.fillStyle = col;
    g.beginPath();
    g.roundRect(x + (o.verdict === "you" ? 2 : 0), ty, tw, th, 6 * k);
    g.fill();
    g.fillStyle = "#0d1418";
    g.fillText(text, x + 7 * k + (o.verdict === "you" ? 2 : 0), ty + th * 0.72);
  }
}
