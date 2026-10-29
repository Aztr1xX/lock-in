import type { Sky } from "../lib/sky";

// Fixed star spots so the sky looks the same every visit.
const STARS = Array.from({ length: 34 }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return { x: r(1) * 100, y: r(2) * 62, s: 1 + r(3) * 1.8, d: r(4) * 4 };
});

/** The sky behind a garden: gradient, sun or moon, stars and a couple of drifting clouds. */
export default function SkyLayer({ sky, clouds = true }: { sky: Sky; clouds?: boolean }) {
  return (
    <div className="sky" aria-hidden="true">
      <div className="sky-stars" style={{ opacity: sky.stars }}>
        {STARS.map((s, i) => (
          <i key={i} style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.s, height: s.s, animationDelay: `${s.d}s` }} />
        ))}
      </div>
      {sky.sun && <div className="sky-sun" style={{ left: `${sky.sun.x * 100}%`, top: `${8 + sky.sun.y * 52}%` }} />}
      {sky.moon && <div className="sky-moon" style={{ left: `${sky.moon.x * 100}%`, top: `${8 + sky.moon.y * 52}%` }} />}
      {clouds && sky.stars < 0.8 && (
        <div className="sky-clouds" style={{ opacity: 1 - sky.stars }}>
          <span className="cloud c1" />
          <span className="cloud c2" />
        </div>
      )}
    </div>
  );
}
