import type { PotId } from "../lib/garden";

// The pot body is a trapezoid: 36..84 wide at the top (y 96), 42..78 at the bottom (y 130).
const BODY = "M36 96 h48 l-6 34 a4 4 0 0 1 -4 3 h-28 a4 4 0 0 1 -4 -3 z";
const left = (y: number) => 36 + ((y - 96) * 6) / 34;
const right = (y: number) => 84 - ((y - 96) * 6) / 34;
/** A horizontal band across the pot body, from y0 to y1. */
const band = (y0: number, y1: number) => `M${left(y0)} ${y0} L${right(y0)} ${y0} L${right(y1)} ${y1} L${left(y1)} ${y1} z`;

const COLORS: Record<PotId, { body: string; rim: string }> = {
  terracotta: { body: "#d27a52", rim: "#e08d66" },
  painted: { body: "#f4e6c8", rim: "#ead4a6" },
  glazed: { body: "#2c9f96", rim: "#3dbdb1" },
  striped: { body: "#f5f6fa", rim: "#e4e7f0" },
  marble: { body: "#eceef1", rim: "#f7f8fa" },
  gold: { body: "url(#pot-gold)", rim: "#ffd96b" },
  crystal: { body: "url(#pot-crystal)", rim: "#d9ccff" },
};

/** The pot, drawn in the 120 x 140 plant frame. Each pot style is a milestone. */
export default function Pot({ kind = "terracotta" }: { kind?: PotId }) {
  const c = COLORS[kind];
  return (
    <g className={`pot-g pot-${kind}`}>
      {kind === "gold" && (
        <defs>
          <linearGradient id="pot-gold" x1="0" x2="1">
            <stop offset="0" stopColor="#ffe48a" />
            <stop offset="0.45" stopColor="#f6c443" />
            <stop offset="1" stopColor="#c8901c" />
          </linearGradient>
        </defs>
      )}
      {kind === "crystal" && (
        <defs>
          <linearGradient id="pot-crystal" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#e7dcff" />
            <stop offset="0.5" stopColor="#b9a4ff" />
            <stop offset="1" stopColor="#8fd3ff" />
          </linearGradient>
        </defs>
      )}
      <path d={BODY} fill={c.body} />
      {kind === "painted" && (
        <g>
          <path d={band(108, 112)} fill="#4a7fd4" />
          {[45, 54, 63, 72].map((x, i) => <circle key={x} cx={x + 2} cy={i % 2 ? 103 : 102} r="1.8" fill="#ff7a8a" />)}
          {[47, 56, 65, 74].map((x) => <circle key={x} cx={x - 1} cy={120} r="1.6" fill="#4a7fd4" />)}
        </g>
      )}
      {kind === "glazed" && (
        <g>
          <path d={band(120, 133)} fill="#1f7f78" />
          <path d="M41 100 q2 14 5 26" stroke="#ffffff" strokeOpacity="0.45" strokeWidth="3" strokeLinecap="round" fill="none" />
        </g>
      )}
      {kind === "striped" && (
        <g fill="#2f4a8a">
          <path d={band(104, 108)} />
          <path d={band(114, 118)} />
          <path d={band(124, 128)} />
        </g>
      )}
      {kind === "marble" && (
        <g stroke="#9aa3ae" strokeWidth="0.9" fill="none" strokeLinecap="round" opacity="0.75">
          <path d="M40 102 q8 4 12 12 t10 14" />
          <path d="M70 99 q-4 8 2 14 q5 5 2 13" />
          <path d="M52 100 q4 3 3 7" />
        </g>
      )}
      {kind === "gold" && (
        <g>
          <path d={band(110, 113)} fill="#fff1b8" opacity="0.8" />
          <path d="M42 100 q2 14 5 26" stroke="#fff8d6" strokeOpacity="0.8" strokeWidth="3" strokeLinecap="round" fill="none" />
          <path className="pot-glint" d="M70 104 l1.4 3.2 3.2 1.4 -3.2 1.4 -1.4 3.2 -1.4 -3.2 -3.2 -1.4 3.2 -1.4 z" fill="#fff" />
        </g>
      )}
      {kind === "crystal" && (
        <g>
          <path d="M36 96 L52 116 L46 133" stroke="#fff" strokeOpacity="0.55" strokeWidth="1" fill="none" />
          <path d="M84 96 L66 112 L74 133" stroke="#fff" strokeOpacity="0.45" strokeWidth="1" fill="none" />
          <path d="M52 116 L66 112" stroke="#fff" strokeOpacity="0.4" strokeWidth="1" />
          <path d="M44 100 L50 98 L48 108 z" fill="#fff" opacity="0.55" />
          <path className="pot-glint" d="M64 120 l1.2 2.8 2.8 1.2 -2.8 1.2 -1.2 2.8 -1.2 -2.8 -2.8 -1.2 2.8 -1.2 z" fill="#fff" />
        </g>
      )}
      {kind !== "gold" && kind !== "crystal" && <path d={BODY} fill="url(#pot-shade)" />}
      <rect x="32" y="92" width="56" height="9" rx="3" fill={c.rim} />
      {kind === "painted" && <rect x="32" y="97.5" width="56" height="1.6" fill="#4a7fd4" opacity="0.8" />}
      {kind === "gold" && <rect x="34" y="93" width="30" height="2" rx="1" fill="#fff6c9" opacity="0.8" />}
    </g>
  );
}

/** Shared gradient for the pot shading. Put once inside each plant <svg>. */
export function PotDefs() {
  return (
    <linearGradient id="pot-shade" x1="0" x2="1">
      <stop offset="0" stopColor="#000" stopOpacity="0" />
      <stop offset="1" stopColor="#000" stopOpacity="0.22" />
    </linearGradient>
  );
}
