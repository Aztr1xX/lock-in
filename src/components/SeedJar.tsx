import { SPECIES } from "../lib/garden";

// Seed spots inside the jar, filled from the bottom up.
const SPOTS = Array.from({ length: 30 }, (_, i) => {
  const row = Math.floor(i / 5);
  const col = i % 5;
  return { x: 13 + col * 5.6 + (row % 2 ? 2.6 : 0) - (col === 4 && row % 2 ? 5.6 : 0), y: 53 - row * 5, r: (i * 47) % 360 };
});

/** How full the jar is on the way to the next seed unlock (0 to 1), plus that unlock. */
export function jarFill(seeds: number) {
  const next = SPECIES.find((s) => seeds < s.seeds);
  const prev = [...SPECIES].reverse().find((s) => seeds >= s.seeds)?.seeds ?? 0;
  return next ? { fill: (seeds - prev) / (next.seeds - prev), next } : { fill: 1, next: null };
}

/** A glass jar that fills with seeds. One seed for every 25 focused minutes. */
export default function SeedJar({ seeds, size = 60, drop = 0 }: { seeds: number; size?: number; drop?: number }) {
  const { fill } = jarFill(seeds);
  const n = Math.max(seeds > 0 ? 1 : 0, Math.round(fill * SPOTS.length));
  return (
    <svg viewBox="0 0 50 66" width={size} height={(size * 66) / 50} className="seed-jar" aria-label={`${seeds} seeds`} role="img">
      <rect x="9" y="6" width="32" height="7" rx="2.5" fill="#c98a4a" />
      <rect x="9" y="6" width="32" height="2.4" rx="1.2" fill="#e0a868" />
      <path d="M11 13 h28 q4 0 4 5 v38 q0 6 -6 6 h-24 q-6 0 -6 -6 v-38 q0 -5 4 -5 z" fill="rgba(220,240,255,0.35)" stroke="rgba(255,255,255,0.75)" strokeWidth="1.6" />
      {SPOTS.slice(0, n).map((s, i) => (
        <ellipse key={i} cx={s.x} cy={s.y} rx="2.4" ry="1.6" fill={i % 3 ? "#a8743f" : "#8a5a2e"} transform={`rotate(${s.r} ${s.x} ${s.y})`} className={i === n - 1 && drop ? "seed-new" : ""} />
      ))}
      <path d="M14 18 q -2 14 0 34" stroke="#fff" strokeOpacity="0.55" strokeWidth="2" fill="none" strokeLinecap="round" />
      <rect x="15" y="27" width="20" height="11" rx="2.5" fill="#fff8ec" stroke="#e1caa4" strokeWidth="0.8" />
      <text x="25" y="35.3" textAnchor="middle" fontSize="7.5" fontWeight="800" fill="#6a4a2a">{seeds}</text>
    </svg>
  );
}
