// Posture, from the front. A webcam can't see your spine, so this watches the things
// that change when you slump, all measured against how YOU normally sit:
//   - sinking: your shoulders drop lower in the picture
//   - leaning in: your shoulders get wider (you're closer to the screen)
//   - neck: your ears sink down toward your shoulders (head pushed forward)
//   - leaning sideways: your shoulder line tilts
// Every length is divided by your shoulder width, so it doesn't matter how far the
// camera is. Looking down at your iPad tilts your head, which barely moves your ears,
// so studying on the iPad isn't mistaken for a slouch.

export interface Pt { x: number; y: number; visibility?: number }

/** One look at how you're sitting. Lengths are in shoulder widths, except w (share of frame width). */
export interface Sample {
  w: number; // shoulder width, share of the frame
  y: number; // shoulder line height, share of the frame
  neck: number | null; // ear line to shoulder line, in shoulder widths (null: ears not seen)
  tilt: number; // shoulder line angle, degrees
}

export interface Baseline extends Sample {
  at: number;
  cam: string;
  set?: boolean; // set on purpose with the button, not learned
}

export type Slump = "sinking" | "leaning in" | "neck" | "leaning sideways";

// How far from your normal counts. Generous on purpose: it's meant to catch a real
// slump that sticks, not every shift in your chair.
export const LIMITS = {
  lean: 1.15, // shoulders this much wider than normal (15% closer)
  sink: 0.2, // shoulders this many shoulder widths lower
  neck: 0.72, // ear-to-shoulder gap down to this share of normal
  tilt: 10, // degrees more tilt than normal
};

const vis = (p: Pt | undefined, min: number) => !!p && (p.visibility ?? 1) > min;

/** Reads one pose (MediaPipe's 33 points). Null when your shoulders aren't both clear. */
export function measure(lm: Pt[] | undefined): Sample | null {
  if (!lm) return null;
  const ls = lm[11], rs = lm[12];
  if (!vis(ls, 0.6) || !vis(rs, 0.6)) return null;
  const w = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (w < 0.05) return null; // side-on or far away, nothing useful to measure
  const y = (ls.y + rs.y) / 2;
  const le = lm[7], re = lm[8];
  let neck: number | null = null;
  if (vis(le, 0.5) && vis(re, 0.5)) neck = (y - (le.y + re.y) / 2) / w;
  else if (vis(le, 0.5) || vis(re, 0.5)) neck = (y - (vis(le, 0.5) ? le : re).y) / w;
  // Mirror-proof angle: always measured left to right in the picture.
  const [a, b] = ls.x < rs.x ? [ls, rs] : [rs, ls];
  const tilt = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return { w, y, neck, tilt };
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/** Your normal, from a run of samples: the middle value of each measure. */
export function baselineOf(samples: Sample[], cam: string, now: number, min = 6): Baseline | null {
  if (samples.length < min) return null;
  const necks = samples.map((s) => s.neck).filter((n): n is number => n !== null);
  return {
    w: median(samples.map((s) => s.w)),
    y: median(samples.map((s) => s.y)),
    neck: necks.length >= samples.length / 2 ? median(necks) : null,
    tilt: median(samples.map((s) => s.tilt)),
    at: now,
    cam,
  };
}

/** Which ways you're slumped compared with your normal. Empty when you're fine. */
export function slumps(s: Sample, b: Baseline): Slump[] {
  const out: Slump[] = [];
  if (s.y - b.y > LIMITS.sink * b.w) out.push("sinking");
  if (s.w > b.w * LIMITS.lean) out.push("leaning in");
  if (s.neck !== null && b.neck !== null && b.neck > 0.15 && s.neck < b.neck * LIMITS.neck) out.push("neck");
  if (Math.abs(s.tilt - b.tilt) > LIMITS.tilt) out.push("leaning sideways");
  return out;
}

/** Smooths a stream of samples, so one jumpy frame never counts. */
export class Smoother {
  private s: Sample | null = null;
  constructor(private k = 0.35) {}
  push(n: Sample | null): Sample | null {
    if (!n) return this.s;
    const k = this.k, p = this.s;
    this.s = !p ? n : {
      w: p.w + k * (n.w - p.w),
      y: p.y + k * (n.y - p.y),
      neck: n.neck === null ? p.neck : p.neck === null ? n.neck : p.neck + k * (n.neck - p.neck),
      tilt: p.tilt + k * (n.tilt - p.tilt),
    };
    return this.s;
  }
  reset() { this.s = null; }
}

// ---- remembered between sessions, so a slouchy start never becomes "normal"

const KEY = "lockin.posture";
const KEEP = 5; // your normal is the middle of your last few sessions

interface Saved { list: Baseline[] }

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Saved) : null;
    return v && Array.isArray(v.list) ? v : { list: [] };
  } catch {
    return { list: [] };
  }
}

function save(v: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch { /* storage full or blocked: posture still works for this session */ }
}

/** Is this the same setup (camera not moved)? */
const sameSetup = (a: Sample, b: Sample) => Math.abs(a.w / b.w - 1) < 0.3 && Math.abs(a.y - b.y) < 0.15;

/** Your saved normal for this camera, or null. */
export function savedBaseline(cam: string): Baseline | null {
  const list = load().list.filter((b) => b.cam === cam);
  if (!list.length) return null;
  const set = list.find((b) => b.set);
  if (set) return set;
  return baselineOf(list, cam, list[list.length - 1].at, 1);
}

/**
 * Remembers one session's normal. If the camera has moved since last time, the old
 * ones are dropped. A posture you set with the button stays until you set a new one.
 */
export function rememberBaseline(b: Baseline) {
  const v = load();
  let mine = v.list.filter((x) => x.cam === b.cam);
  const others = v.list.filter((x) => x.cam !== b.cam);
  const set = mine.find((x) => x.set);
  if (b.set) mine = [b];
  else if (set) mine = sameSetup(set, b) ? [set] : [b];
  else mine = [...mine.filter((x) => sameSetup(x, b)), b].slice(-KEEP);
  save({ list: [...others.slice(-10), ...mine] });
}
