// The garden's sky follows the real time of day: dawn, bright day, golden hour, dusk and a starry night.

interface Stop {
  h: number;
  top: string;
  bottom: string;
  light: number; // how lit the plants are, 0.5 at night to 1 at midday
}

const STOPS: Stop[] = [
  { h: 0, top: "#0a0f2c", bottom: "#1f2a5c", light: 0.55 },
  { h: 4.5, top: "#0d1335", bottom: "#2a2f63", light: 0.55 },
  { h: 6, top: "#4b5aa3", bottom: "#ff9e7d", light: 0.75 },
  { h: 7.5, top: "#7cb8f2", bottom: "#ffd9b0", light: 0.92 },
  { h: 10, top: "#5aaef7", bottom: "#c9ecff", light: 1 },
  { h: 15.5, top: "#5aa8f2", bottom: "#d4efff", light: 1 },
  { h: 18, top: "#6f8fd8", bottom: "#ffc98a", light: 0.95 },
  { h: 19.3, top: "#7c5aa6", bottom: "#ff8f66", light: 0.82 },
  { h: 20.5, top: "#2b2a66", bottom: "#8b5a8e", light: 0.66 },
  { h: 21.8, top: "#0f1438", bottom: "#28306a", light: 0.56 },
  { h: 24, top: "#0a0f2c", bottom: "#1f2a5c", light: 0.55 },
];

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => {
  const x = hex(a), y = hex(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(",")})`;
};

export interface Sky {
  top: string;
  bottom: string;
  light: number;
  stars: number; // 0 to 1
  night: boolean;
  sun: { x: number; y: number } | null; // 0 to 1 across, 0 (high) to 1 (horizon)
  moon: { x: number; y: number } | null;
  name: string;
}

export function skyAt(d = new Date()): Sky {
  const h = d.getHours() + d.getMinutes() / 60;
  let i = 0;
  while (h > STOPS[i + 1].h) i++;
  const a = STOPS[i], b = STOPS[i + 1];
  const t = (h - a.h) / (b.h - a.h);
  const light = a.light + (b.light - a.light) * t;
  // Sun from 6:00 to 20:30, moon the rest of the time.
  const arc = (p: number) => ({ x: 0.08 + p * 0.84, y: 1 - Math.sin(p * Math.PI) });
  const sunP = (h - 6) / 14.5;
  const moonP = ((h - 20 + 24) % 24) / 10.5;
  const stars = Math.max(0, Math.min(1, (0.72 - light) / 0.14));
  const name = h < 5 || h >= 21.5 ? "Night" : h < 7.5 ? "Dawn" : h < 12 ? "Morning" : h < 17.5 ? "Afternoon" : h < 19.6 ? "Golden hour" : "Dusk";
  return {
    top: mix(a.top, b.top, t),
    bottom: mix(a.bottom, b.bottom, t),
    light,
    stars,
    night: stars > 0.5,
    sun: sunP > 0 && sunP < 1 ? arc(sunP) : null,
    moon: moonP > 0 && moonP < 1 ? arc(moonP) : null,
    name,
  };
}

/** CSS variables for any element that draws a sky. */
export const skyVars = (s: Sky) =>
  ({ "--sky-top": s.top, "--sky-bottom": s.bottom, "--lit": s.light, "--stars": s.stars }) as React.CSSProperties;
