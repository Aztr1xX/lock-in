import type { PotId, SpeciesId } from "../lib/garden";
import Pot, { PotDefs } from "./Pot";

// Every garden plant is drawn from its growth (0 to 1), so it grows smoothly minute by minute.
// The soil sits at y 93 in a 120 x 140 frame, the same frame as the original plant.

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
/** 0 before `a`, 1 after `b`, a straight ramp in between. */
const k = (g: number, a: number, b: number) => clamp((g - a) / (b - a));
const rnd = (i: number) => {
  const x = Math.sin(i * 91.7 + 13.3) * 43758.5453;
  return x - Math.floor(x);
};
const BASE = 93;

function Sprout({ t }: { t: number }) {
  const h = 3 + t * 7;
  const s = 0.5 + t * 0.5;
  return (
    <g>
      <path d={`M60 ${BASE} q -1 ${-h / 2} 0 ${-h}`} stroke="#3fae74" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path className="gleaf" d={`M60 ${BASE - h} q ${-6 * s} ${-5 * s} ${-9 * s} ${-1 * s} q ${4 * s} ${4 * s} ${9 * s} ${1 * s}`} fill="#4fcf8a" />
      <path className="gleaf" d={`M60 ${BASE - h} q ${6 * s} ${-5 * s} ${9 * s} ${-1 * s} q ${-4 * s} ${4 * s} ${-9 * s} ${1 * s}`} fill="#3fbb7b" />
    </g>
  );
}

/** Not picked yet: a seedling with a little "?" tag. It keeps growing while it waits. */
function Mystery({ g }: { g: number }) {
  const h = 10 + g * 50;
  const n = 1 + Math.floor(g * 5);
  return (
    <g>
      <path d={`M60 ${BASE} C 58 ${BASE - h / 2}, 62 ${BASE - h / 2}, 60 ${BASE - h}`} stroke="#3fae74" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      {Array.from({ length: n }, (_, i) => {
        const y = BASE - h * ((i + 1) / (n + 1));
        const l = 7 + i;
        const left = i % 2 === 0;
        return (
          <path key={i} className="gleaf" fill={left ? "#4fcf8a" : "#3fbb7b"}
            d={left ? `M60 ${y} q ${-l * 0.6} ${-l * 0.7} ${-l} ${-l * 0.15} q ${l * 0.5} ${l * 0.45} ${l} ${l * 0.15}` : `M60 ${y} q ${l * 0.6} ${-l * 0.7} ${l} ${-l * 0.15} q ${-l * 0.5} ${l * 0.45} ${-l} ${l * 0.15}`} />
        );
      })}
      <path className="gleaf" d={`M60 ${BASE - h} q -4 -7 0 -11 q 4 4 0 11`} fill="#4fcf8a" />
      <g className="mystery-tag">
        <line x1="78" y1={BASE + 1} x2="78" y2={BASE - 16} stroke="#b08a5a" strokeWidth="1.6" />
        <rect x="71" y={BASE - 26} width="14" height="12" rx="2.5" fill="#fff6e0" stroke="#d9b98a" strokeWidth="0.8" />
        <text x="78" y={BASE - 16.8} textAnchor="middle" fontSize="10" fontWeight="800" fill="#c47a2c">?</text>
      </g>
    </g>
  );
}

function Cactus({ g }: { g: number }) {
  const h = 10 + 46 * g;
  const w = 12 + 8 * k(g, 0, 0.5);
  const top = BASE - h;
  const a1 = k(g, 0.38, 0.7), a2 = k(g, 0.62, 0.9);
  const y1 = BASE - h * 0.42, y2 = BASE - h * 0.62;
  const arm = (dir: number, y: number, a: number, up: number) =>
    `M${60 + dir * (w / 2 - 3)} ${y} h${dir * 9} q${dir * 3} 0 ${dir * 3} -3 v${-up * a}`;
  return (
    <g>
      {a1 > 0 && <path d={arm(-1, y1, a1, 13)} stroke="#58b368" strokeWidth="8" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      {a2 > 0 && <path d={arm(1, y2, a2, 11)} stroke="#58b368" strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      <rect x={60 - w / 2} y={top} width={w} height={h + 4} rx={w / 2} fill="#58b368" />
      {[-w / 4, 0, w / 4].map((dx) => (
        <line key={dx} x1={60 + dx} y1={top + w / 3} x2={60 + dx} y2={BASE} stroke="#46a057" strokeWidth="1" />
      ))}
      <rect x={60 - w / 2 + 2} y={top + 3} width="2.4" height={h * 0.6} rx="1.2" fill="#fff" opacity="0.18" />
      {Array.from({ length: Math.floor(h / 7) }, (_, j) => (
        <g key={j} fill="#effbe0">
          <circle cx={60 - w / 4 - 1.5} cy={top + 6 + j * 7} r="0.7" />
          <circle cx={60 + w / 4 + 1.5} cy={top + 9 + j * 7} r="0.7" />
          <circle cx={60} cy={top + 4 + j * 7 + 3.5} r="0.6" />
        </g>
      ))}
      {g >= 0.88 && (
        <g transform={`translate(60 ${top + 1}) scale(${0.4 + 0.6 * k(g, 0.88, 1)})`}>
          <g className="flower">
            {[0, 60, 120, 180, 240, 300].map((d) => <ellipse key={d} rx="2.6" ry="5.2" cy="-4.4" fill="#ff7aa8" transform={`rotate(${d})`} />)}
            <circle r="2.6" fill="#ffd166" />
          </g>
        </g>
      )}
    </g>
  );
}

function Fern({ g }: { g: number }) {
  const n = Math.min(9, 2 + Math.floor(g * 7.5));
  const L = 14 + 34 * g;
  const fronds = Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    return { a: t * 66, len: L * (1 - 0.3 * Math.abs(t)) };
  });
  return (
    <g>
      {fronds.map((f, i) => {
        const m = Math.max(3, Math.floor(f.len / 4));
        return (
          <g key={i} transform={`rotate(${f.a} 60 ${BASE})`}>
            <g className="frond" style={{ animationDelay: `${i * 0.05}s` }}>
              <path d={`M60 ${BASE} Q ${60 + f.len * 0.1} ${BASE - f.len * 0.5} 60 ${BASE - f.len}`} stroke="#3d9a5c" strokeWidth="1.4" fill="none" strokeLinecap="round" />
              {Array.from({ length: m }, (_, j) => {
                const p = (j + 1) / (m + 0.6);
                const y = BASE - f.len * p;
                const x = 60 + f.len * 0.1 * 2 * p * (1 - p);
                const l = 1.6 + 6.5 * (1 - p) * Math.min(1, f.len / 28);
                return (
                  <g key={j}>
                    <ellipse cx={x - l * 0.55} cy={y} rx={l * 0.62} ry="1.5" fill={j % 2 ? "#4fbf78" : "#45ad6c"} transform={`rotate(24 ${x - l * 0.55} ${y})`} />
                    <ellipse cx={x + l * 0.55} cy={y} rx={l * 0.62} ry="1.5" fill={j % 2 ? "#45ad6c" : "#4fbf78"} transform={`rotate(-24 ${x + l * 0.55} ${y})`} />
                  </g>
                );
              })}
            </g>
          </g>
        );
      })}
      {g < 1 && (
        <path d={`M60 ${BASE} q 1 -8 0 -12 a 3 3 0 1 1 3 -3`} stroke="#5ccf87" strokeWidth="1.6" fill="none" strokeLinecap="round" className="fiddle" />
      )}
    </g>
  );
}

const lerpHex = (a: string, b: string, t: number) => {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const x = p(a), y = p(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(",")})`;
};

function Lavender({ g }: { g: number }) {
  const n = Math.min(7, 1 + Math.floor(g * 6.5));
  const bloom = k(g, 0.3, 0.75);
  const c1 = lerpHex("#9cc48a", "#9070dc", bloom), c2 = lerpHex("#a9cf96", "#b597f3", bloom);
  return (
    <g>
      {[-1, 1, -0.5, 0.5].map((d, i) => (
        <path key={"b" + i} d={`M60 ${BASE} q ${d * 8} -3 ${d * 13} -${6 + i}`} stroke="#8fb59a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      ))}
      {Array.from({ length: n }, (_, i) => {
        const x = 60 + (i - (n - 1) / 2) * 4.2;
        const lean = (x - 60) * 0.6;
        const H = (14 + 46 * g) * (0.8 + 0.2 * rnd(i));
        const tx = x + lean, ty = BASE - H;
        return (
          <g key={i} className="gleaf" style={{ animationDelay: `${i * 0.06}s` }}>
            <path d={`M${x} ${BASE} Q ${x + lean * 0.2} ${BASE - H / 2} ${tx} ${ty}`} stroke="#7fa36b" strokeWidth="1.3" fill="none" />
            {Array.from({ length: 6 }, (_, j) => (
              <ellipse key={j} cx={tx - lean * 0.03 * j + (j % 2 ? 0.9 : -0.9)} cy={ty + j * 2.7} rx={1.4 + 0.7 * bloom} ry="2.2" fill={j % 2 ? c1 : c2} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

const MONSTERA = [
  { a: -8, f: 1 }, { a: -46, f: 0.82 }, { a: 40, f: 0.86 }, { a: -74, f: 0.62 }, { a: 70, f: 0.64 },
];

function Monstera({ g }: { g: number }) {
  const n = Math.min(5, 1 + Math.floor(g * 4.6));
  return (
    <g>
      {MONSTERA.slice(0, n).map((m, i) => {
        // A new leaf starts small and unfurls.
        const age = clamp((g - i / 4.6) * 2.2, 0.25, 1);
        const sl = (14 + 30 * g) * m.f;
        const r = (m.a * Math.PI) / 180;
        const x = 60 + Math.sin(r) * sl, y = BASE - Math.cos(r) * sl;
        const S = (7 + 11 * g) * m.f * age;
        const tilt = m.a + Math.sign(m.a || 1) * 18;
        return (
          <g key={i}>
            <path d={`M60 ${BASE} Q ${60 + Math.sin(r) * sl * 0.2} ${BASE - sl * 0.6} ${x} ${y}`} stroke="#3f8f57" strokeWidth="1.8" fill="none" strokeLinecap="round" />
            <g transform={`translate(${x} ${y}) rotate(${tilt})`}>
              <g className="gleaf" style={{ animationDelay: `${i * 0.08}s` }}>
                <path d={`M0 0 C ${-S * 1.15} ${S * 0.1}, ${-S * 1.15} ${-S * 1.55}, 0 ${-S * 1.75} C ${S * 1.15} ${-S * 1.55}, ${S * 1.15} ${S * 0.1}, 0 0 z`} fill={i % 2 ? "#47a86a" : "#3d9c5f"} />
                <path d={`M0 0 L0 ${-S * 1.6}`} stroke="#2f7d4b" strokeWidth="0.9" />
                {S > 9 && [0.42, 0.8, 1.15].map((p) => (
                  <g key={p} stroke="#2a7a47" strokeWidth={S * 0.09} strokeLinecap="round">
                    <line x1={-S * 0.72} y1={-S * p} x2={-S * 0.3} y2={-S * (p + 0.1)} />
                    <line x1={S * 0.72} y1={-S * p} x2={S * 0.3} y2={-S * (p + 0.1)} />
                  </g>
                ))}
                <path d={`M${-S * 0.5} ${-S * 1.3} q ${S * 0.2} ${-S * 0.2} ${S * 0.4} ${-S * 0.2}`} stroke="#fff" strokeOpacity="0.25" strokeWidth="1" fill="none" />
              </g>
            </g>
          </g>
        );
      })}
    </g>
  );
}

function Bamboo({ g }: { g: number }) {
  const stalks = [
    { x: 57, off: 0, max: 64 },
    { x: 65, off: 0.15, max: 52 },
    { x: 50, off: 0.35, max: 40 },
  ];
  return (
    <g>
      {stalks.map((s, i) => {
        const H = s.max * k(g, s.off, 1) + (g > s.off ? 4 : 0);
        if (H <= 0) return null;
        const nodes = Math.floor(H / 8);
        return (
          <g key={i}>
            <rect x={s.x - 2.3} y={BASE - H} width="4.6" height={H + 2} rx="2.2" fill={i === 1 ? "#a6d363" : "#97c957"} />
            <rect x={s.x - 1.4} y={BASE - H + 2} width="1.2" height={H - 2} rx="0.6" fill="#fff" opacity="0.22" />
            {Array.from({ length: nodes }, (_, j) => (
              <rect key={j} x={s.x - 2.8} y={BASE - 8 * (j + 1)} width="5.6" height="1.4" rx="0.7" fill="#6f9f37" />
            ))}
            {Array.from({ length: nodes }, (_, j) => j).filter((j) => j >= nodes - 3 && j > 0).map((j) => {
              const y = BASE - 8 * (j + 1);
              const d = (j + i) % 2 ? 1 : -1;
              return (
                <path key={"l" + j} className="gleaf" d={`M${s.x} ${y} q ${d * 7} -5 ${d * 15} -3 q ${-d * 8} 3 ${-d * 15} 3`} fill={j % 2 ? "#6fb24a" : "#7cc155"} />
              );
            })}
            <path className="gleaf" d={`M${s.x} ${BASE - H} q -1 -6 2 -9 q 0 5 -2 9`} fill="#7cc155" />
          </g>
        );
      })}
    </g>
  );
}

const TRAPS = [
  { a: -6, f: 1 }, { a: -46, f: 0.86 }, { a: 42, f: 0.9 }, { a: -72, f: 0.7 }, { a: 70, f: 0.72 }, { a: 18, f: 0.95 },
];

function Flytrap({ g }: { g: number }) {
  const n = Math.min(6, 1 + Math.floor(g * 5.4));
  const T = 4 + 6 * g;
  const lobe = (dir: number, i: number) => (
    <g transform={`rotate(${dir * 26})`}>
      <g className={`lobe ${i === 0 ? (dir < 0 ? "snap-l" : "snap-r") : ""}`}>
        <ellipse cx={dir * T * 0.1} cy={-T} rx={T * 0.56} ry={T} fill="#7cc45a" />
        <ellipse cx={dir * T * 0.18} cy={-T * 0.95} rx={T * 0.36} ry={T * 0.78} fill="#e8524a" />
        {[-0.75, -0.35, 0.05, 0.45].map((p) => (
          <line key={p} x1={dir * T * 0.5} y1={-T + p * T} x2={dir * T * 0.85} y2={-T + p * T - 1} stroke="#d9f2b8" strokeWidth="0.7" strokeLinecap="round" />
        ))}
      </g>
    </g>
  );
  return (
    <g>
      {TRAPS.slice(0, n).map((t, i) => {
        const len = (8 + 20 * g) * t.f;
        const r = (t.a * Math.PI) / 180;
        const x = 60 + Math.sin(r) * len, y = BASE - Math.cos(r) * len;
        return (
          <g key={i}>
            <path d={`M60 ${BASE} Q ${60 + Math.sin(r) * len * 0.4} ${BASE - len * 0.55} ${x} ${y}`} stroke="#6cb84d" strokeWidth="3" fill="none" strokeLinecap="round" />
            <g transform={`translate(${x} ${y}) rotate(${t.a})`}>
              <g className="gleaf" style={{ animationDelay: `${i * 0.07}s` }}>
                {lobe(-1, i)}
                {lobe(1, i)}
              </g>
            </g>
          </g>
        );
      })}
    </g>
  );
}

const CANOPY: [number, number, number][] = [
  [0, -6, 13], [-11, -1, 10], [11, -1, 10], [-7, -15, 10], [8, -14, 10], [0, -21, 8],
];
const LEMONS: [number, number][] = [[-9, 2], [7, -6], [-3, -14], [12, 4], [2, 3]];

function Lemon({ g }: { g: number }) {
  const th = 10 + 30 * g;
  const tx = 60, ty = BASE - th;
  const c = k(g, 0.1, 1);
  const shown = Math.max(1, Math.min(6, Math.ceil(c * 6)));
  const sc = 0.4 + 0.75 * c;
  const lemons = g >= 0.72 ? Math.max(1, Math.floor(k(g, 0.72, 1) * 5.99)) : 0;
  return (
    <g>
      <path d={`M60 ${BASE} C 58 ${BASE - th * 0.4}, 62 ${BASE - th * 0.7}, ${tx} ${ty}`} stroke="#8a5a3b" strokeWidth={2.5 + 3 * g} fill="none" strokeLinecap="round" />
      {g > 0.3 && (
        <g stroke="#8a5a3b" strokeWidth={1.6 + g} strokeLinecap="round" fill="none">
          <path d={`M${tx} ${ty + 6} q -6 -2 -9 -7`} />
          <path d={`M${tx} ${ty + 4} q 6 -2 9 -7`} />
        </g>
      )}
      <g transform={`translate(${tx} ${ty}) scale(${sc})`}>
        {CANOPY.slice(0, shown).map(([x, y, r], i) => (
          <g key={i} className="gleaf">
            <circle cx={x} cy={y} r={r} fill={i % 2 ? "#4fae57" : "#48a350"} />
            <circle cx={x - r * 0.3} cy={y - r * 0.35} r={r * 0.45} fill="#66c46d" opacity="0.6" />
          </g>
        ))}
        {g > 0.55 && g < 0.8 && [[-6, -8], [6, -2], [0, -16]].map(([x, y], i) => <circle key={"b" + i} cx={x} cy={y} r="1.4" fill="#fffaf0" />)}
        {LEMONS.slice(0, lemons).map(([x, y], i) => (
          <g key={"l" + i} className="fruit" style={{ animationDelay: `${0.2 + i * 0.1}s` }}>
            <ellipse cx={x} cy={y} rx="3.2" ry="2.5" fill="#ffd93b" />
            <circle cx={x - 1} cy={y - 0.8} r="0.8" fill="#fff6b8" />
          </g>
        ))}
      </g>
    </g>
  );
}

function Bonsai({ g }: { g: number }) {
  const hf = 0.45 + 0.55 * g;
  const P = (x: number, dy: number) => `${x} ${BASE - dy * hf}`;
  const pads: [number, number, number][] = [
    [57, 42, 15], [77, 32, 11], [42, 24, 10], [45, 39, 8],
  ];
  const n = Math.min(4, 1 + Math.floor(g * 3.99));
  const s = 0.5 + 0.5 * g;
  return (
    <g>
      <ellipse cx="60" cy={BASE} rx="20" ry="2.6" fill="#5c9a4e" />
      <circle cx="48" cy={BASE - 0.5} r="2.2" fill="#9aa0a6" />
      <path d={`M60 ${BASE} C ${P(50, 14)}, ${P(72, 26)}, ${P(58, 38)}`} stroke="#7a5236" strokeWidth={4 + 3 * g} fill="none" strokeLinecap="round" />
      {g > 0.25 && <path d={`M${P(64, 24)} Q ${P(72, 28)} ${P(77, 30)}`} stroke="#7a5236" strokeWidth={2 + 1.5 * g} fill="none" strokeLinecap="round" />}
      {g > 0.5 && <path d={`M${P(58, 14)} Q ${P(48, 18)} ${P(42, 22)}`} stroke="#7a5236" strokeWidth={2 + g} fill="none" strokeLinecap="round" />}
      {pads.slice(0, n).map(([x, dy, r], i) => {
        const R = r * s;
        const cy = BASE - dy * hf;
        return (
          <g key={i} className="gleaf" style={{ animationDelay: `${i * 0.1}s` }}>
            <ellipse cx={x - R * 0.45} cy={cy + 1} rx={R * 0.6} ry={R * 0.42} fill="#3a874b" />
            <ellipse cx={x + R * 0.45} cy={cy + 1} rx={R * 0.6} ry={R * 0.42} fill="#3a874b" />
            <ellipse cx={x} cy={cy - R * 0.15} rx={R * 0.7} ry={R * 0.5} fill="#449a55" />
            <ellipse cx={x - R * 0.15} cy={cy - R * 0.35} rx={R * 0.4} ry={R * 0.22} fill="#62b56f" />
          </g>
        );
      })}
    </g>
  );
}

function Moonflower({ g }: { g: number }) {
  const vh = 8 + 52 * g;
  const pts: string[] = [];
  for (let y = 0; y <= vh; y += 2) pts.push(`${(60 + 6 * Math.sin(y * 0.22)).toFixed(2)} ${(BASE - y).toFixed(2)}`);
  const leaves = Math.floor(vh / 8);
  const flowers = g >= 0.45 ? Math.max(1, Math.floor(k(g, 0.45, 1) * 4.99)) : 0;
  const fy = [0.95, 0.62, 0.8, 0.42, 0.25];
  return (
    <g>
      <line x1="60" y1={BASE + 1} x2="60" y2={BASE - Math.min(64, vh + 12)} stroke="#b08a5a" strokeWidth="1.6" strokeLinecap="round" />
      <path d={`M${pts.join(" L")}`} stroke="#4f9a5a" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {Array.from({ length: leaves }, (_, i) => {
        const y = 6 + i * 8;
        const x = 60 + 6 * Math.sin(y * 0.22);
        const d = i % 2 ? 1 : -1;
        return (
          <path key={i} className="gleaf" d={`M${x} ${BASE - y} c ${d * 3} -4 ${d * 9} -3 ${d * 8} 1 c ${-d * 1} 3 ${-d * 5} 3 ${-d * 8} -1`} fill={i % 2 ? "#58b06a" : "#4ea361"} />
        );
      })}
      {fy.slice(0, flowers).map((p, i) => {
        const y = vh * p;
        const x = 60 + 6 * Math.sin(y * 0.22) + (i % 2 ? 6 : -6);
        return (
          <g key={"f" + i} transform={`translate(${x} ${BASE - y})`}>
            <circle r="9" className="mf-glow" fill="url(#mf-glow)" />
            <g className="flower" style={{ animationDelay: `${0.2 + i * 0.12}s` }}>
              {[0, 72, 144, 216, 288].map((d) => <circle key={d} r="2.7" cy="-2.9" fill="#f7f4ff" transform={`rotate(${d})`} />)}
              <circle r="1.7" fill="#fff4a8" />
            </g>
          </g>
        );
      })}
    </g>
  );
}

function Body({ species, g }: { species: SpeciesId | null; g: number }) {
  if (!species) return <Mystery g={g} />;
  if (g < 0.05) return <Sprout t={g / 0.05} />;
  switch (species) {
    case "cactus": return <Cactus g={g} />;
    case "fern": return <Fern g={g} />;
    case "lavender": return <Lavender g={g} />;
    case "monstera": return <Monstera g={g} />;
    case "bamboo": return <Bamboo g={g} />;
    case "flytrap": return <Flytrap g={g} />;
    case "lemon": return <Lemon g={g} />;
    case "bonsai": return <Bonsai g={g} />;
    case "moonflower": return <Moonflower g={g} />;
  }
}

interface Props {
  species: SpeciesId | null;
  growth: number;
  pot?: PotId;
  size?: number;
  className?: string;
}

/** A plant from the garden in its pot. */
export default function GardenPlant({ species, growth, pot = "terracotta", size = 120, className = "" }: Props) {
  const g = clamp(growth);
  const name = species ? species : "seedling";
  return (
    <svg
      className={`plant gplant gp-${name} ${g >= 1 ? "grown" : ""} ${className}`}
      viewBox="0 0 120 140"
      width={size}
      height={(size * 140) / 120}
      role="img"
      aria-label={`${name}, ${Math.floor(g * 100)}% grown`}
    >
      <defs>
        <PotDefs />
        {species === "moonflower" && (
          <radialGradient id="mf-glow">
            <stop offset="0" stopColor="#e9e4ff" stopOpacity="0.9" />
            <stop offset="1" stopColor="#e9e4ff" stopOpacity="0" />
          </radialGradient>
        )}
      </defs>
      <ellipse cx="60" cy="134" rx="30" ry="3.5" className="plant-shadow" />
      <g className="plant-sway">
        <Body species={species} g={g} />
      </g>
      <Pot kind={pot} />
      {g >= 1 && (
        <g className="grown-glints" fill="#fff">
          <path d="M26 40 l1.2 2.8 2.8 1.2 -2.8 1.2 -1.2 2.8 -1.2 -2.8 -2.8 -1.2 2.8 -1.2 z" />
          <path d="M92 28 l1 2.2 2.2 1 -2.2 1 -1 2.2 -1 -2.2 -2.2 -1 2.2 -1 z" />
        </g>
      )}
    </svg>
  );
}
