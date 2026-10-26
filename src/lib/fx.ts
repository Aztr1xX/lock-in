// Little touches: chimes, the live favicon ring, confetti.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Unlocks audio; call from a click so later chimes are allowed to play. */
export const primeAudio = () => void audio();

function tone(freq: number, start: number, dur: number, gain = 0.18) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + start;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = "sine";
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export const chime = {
  start: () => { tone(523.25, 0, 0.5); tone(783.99, 0.12, 0.7); },
  breakTime: () => { tone(783.99, 0, 0.6); tone(659.25, 0.18, 0.6); tone(523.25, 0.36, 0.9); },
  backToWork: () => { tone(523.25, 0, 0.4); tone(659.25, 0.14, 0.4); tone(783.99, 0.28, 0.8); },
  done: () => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.12, 0.9, 0.14)); },
  tick: () => tone(1200, 0, 0.05, 0.05),
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
