// Little touches: chimes, the live favicon ring, confetti.

let ctx: AudioContext | null = null;
let bus: GainNode | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Everything plays into one bus: a little dry signal, a soft generated room
 * reverb, and a gentle compressor so nothing ever clips or startles.
 */
function out(ac: AudioContext): GainNode {
  if (bus) return bus;
  bus = ac.createGain();
  bus.gain.value = 0.9;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 3;
  comp.attack.value = 0.005;
  comp.release.value = 0.25;
  const verb = ac.createConvolver();
  const len = Math.floor(ac.sampleRate * 2.4);
  const ir = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  verb.buffer = ir;
  const wet = ac.createGain();
  wet.gain.value = 0.32;
  const tone = ac.createBiquadFilter(); // takes the edge off the top
  tone.type = "lowpass";
  tone.frequency.value = 6500;
  bus.connect(tone);
  tone.connect(comp);
  tone.connect(verb).connect(wet).connect(comp);
  comp.connect(ac.destination);
  return bus;
}

/** Unlocks audio; call from a click so later chimes are allowed to play. */
export const primeAudio = () => {
  const ac = audio();
  if (ac) out(ac);
};

// A soft mallet bell: a sine fundamental with a few inharmonic partials that die away fast,
// so it starts bright and settles warm.
const PARTIALS: [number, number, number][] = [
  // ratio, level, decay multiplier
  [1, 1, 1],
  [2, 0.28, 0.55],
  [3.01, 0.12, 0.35],
  [4.2, 0.07, 0.22],
  [6.8, 0.035, 0.12],
];

function bell(freq: number, at: number, dur = 1.6, gain = 0.16, pan = 0) {
  const ac = audio();
  if (!ac) return;
  const dest = out(ac);
  const t = ac.currentTime + 0.01 + at;
  const p = ac.createStereoPanner();
  p.pan.value = pan;
  p.connect(dest);
  for (const [ratio, level, decay] of PARTIALS) {
    const f = freq * ratio;
    if (f > 12000) continue;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.value = f;
    const d = Math.max(0.08, dur * decay);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(p);
    o.start(t);
    o.stop(t + d + 0.05);
  }
}

/** A warm, quiet chord underneath, like a held breath. */
function pad(freqs: number[], at: number, dur = 2.2, gain = 0.035) {
  const ac = audio();
  if (!ac) return;
  const dest = out(ac);
  const t = ac.currentTime + 0.01 + at;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(600, t);
  lp.frequency.linearRampToValueAtTime(1800, t + dur * 0.4);
  lp.frequency.linearRampToValueAtTime(500, t + dur);
  lp.connect(dest);
  for (const f of freqs) {
    for (const det of [-6, 6]) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      o.detune.value = det;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }
}

/** A tiny wooden tap for button presses. */
function tap(at = 0, freq = 520, gain = 0.22) {
  const ac = audio();
  if (!ac) return;
  const dest = out(ac);
  const t = ac.currentTime + 0.005 + at;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(freq * 1.6, t);
  o.frequency.exponentialRampToValueAtTime(freq, t + 0.04);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + 0.15);
}

// Notes (Hz)
const N = {
  C4: 261.63, E4: 329.63, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, C7: 2093.0,
};

export const chime = {
  /** Session starts: a quick, bright rising lift. */
  start: () => {
    tap(0, 440, 0.18);
    [N.C5, N.E5, N.G5, N.C6].forEach((f, i) => bell(f, 0.05 + i * 0.075, 1.4, 0.13, -0.3 + i * 0.2));
    pad([N.C4, N.G4], 0.05, 1.8, 0.025);
  },
  /** Break time: falling, relaxed, with a warm chord to exhale on. */
  breakTime: () => {
    [N.G5, N.E5, N.C5].forEach((f, i) => bell(f, i * 0.22, 2, 0.15, 0.25 - i * 0.25));
    pad([N.C4, N.E4, N.G4], 0.1, 2.6, 0.03);
  },
  /** Back to work: rising and a little brighter than the start. */
  backToWork: () => {
    [N.D5, N.G5, N.B5, N.D6].forEach((f, i) => bell(f, i * 0.1, 1.3, 0.13, -0.3 + i * 0.2));
  },
  /** Session done: a rolling major-seven arpeggio that lands softly. */
  done: () => {
    [N.C5, N.E5, N.G5, N.B5, N.D6, N.G6].forEach((f, i) => bell(f, i * 0.09, 1.8, 0.11, -0.4 + i * 0.16));
    bell(N.C6, 0.62, 2.4, 0.12);
    pad([N.C4, N.G4, N.B4, N.E5], 0.1, 3, 0.022);
  },
  /** Unlocks: badges and flowers. A shimmer of high bells. */
  sparkle: () => {
    [N.E6, N.G6, N.C7, N.G6, N.C7].forEach((f, i) => bell(f, i * 0.06, 0.9, 0.06, (i % 2 ? 0.4 : -0.4)));
    bell(N.C6, 0.32, 1.6, 0.08);
  },
  /** Soft UI tap. */
  tick: () => tap(0, 700, 0.08),
};

let faviconCanvas: HTMLCanvasElement | null = null;

/** Draws the remaining time as a ring in the browser tab icon. */
export function setFavicon(progress: number | null, onBreak = false) {
  const link = document.getElementById("favicon") as HTMLLinkElement | null;
  if (!link) return;
  if (progress === null) {
    link.href = "/icon.svg";
    return;
  }
  faviconCanvas ??= document.createElement("canvas");
  const c = faviconCanvas;
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = "#0d1418";
  g.beginPath();
  g.roundRect(0, 0, 64, 64, 16);
  g.fill();
  g.lineWidth = 8;
  g.lineCap = "round";
  g.strokeStyle = "#22332c";
  g.beginPath();
  g.arc(32, 32, 20, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = onBreak ? "#ffb86b" : "#5ee0a0";
  g.beginPath();
  g.arc(32, 32, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, progress));
  g.stroke();
  link.href = c.toDataURL("image/png");
}

export function confetti(origin?: { x: number; y: number }) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas");
  c.className = "confetti";
  c.width = innerWidth * devicePixelRatio;
  c.height = innerHeight * devicePixelRatio;
  document.body.appendChild(c);
  const g = c.getContext("2d")!;
  g.scale(devicePixelRatio, devicePixelRatio);
  const colors = ["#5ee0a0", "#ffb86b", "#7cc4ff", "#ff7d8a", "#f5e663"];
  const ox = origin?.x ?? innerWidth / 2;
  const oy = origin?.y ?? innerHeight / 2;
  const bits = Array.from({ length: 140 }, () => {
    const a = Math.random() * Math.PI * 2;
    const v = 4 + Math.random() * 9;
    return {
      x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
      w: 6 + Math.random() * 6, h: 3 + Math.random() * 4,
      color: colors[(Math.random() * colors.length) | 0],
    };
  });
  const t0 = performance.now();
  const frame = (t: number) => {
    const age = t - t0;
    g.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.vy += 0.25; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
      g.save();
      g.globalAlpha = Math.max(0, 1 - age / 2600);
      g.translate(b.x, b.y);
      g.rotate(b.r);
      g.fillStyle = b.color;
      g.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      g.restore();
    }
    if (age < 2600) requestAnimationFrame(frame);
    else c.remove();
  };
  requestAnimationFrame(frame);
}
