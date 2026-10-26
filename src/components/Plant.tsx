import { flowersAt } from "../lib/flowers";
import { FlowerHead } from "./Flower";

/**
 * A little potted plant that grows a stage for every focused hour (0 to 12).
 * Past that it keeps earning flowers: the newest one crowns the stem and the
 * earlier ones bloom on side stems.
 */
export default function Plant({ stage, hours = 0, size = 120, wilted = false }: { stage: number; hours?: number; size?: number; wilted?: boolean }) {
  const s = Math.max(0, Math.min(12, stage));
  const stemTop = 92 - Math.min(64, 10 + s * 5.5);
  const leaves = Array.from({ length: Math.min(s, 9) }, (_, i) => {
    const y = 90 - (i + 1) * ((90 - stemTop) / (Math.min(s, 9) + 1));
    const left = i % 2 === 0;
    const len = 13 + Math.min(i, 4) * 1.5;
    return { y, left, len };
  });
  const earned = flowersAt(hours).filter((f) => f.kind !== "bloom");
  const crown = earned.length ? earned[earned.length - 1].kind : s >= 10 ? "bloom" : null;
  const bud = s >= 8 && !crown;
  // Earlier flowers on side stems, newest highest. Up to six.
  const side = earned.slice(0, -1).slice(-6).reverse().map((f, i) => {
    const left = i % 2 === 0;
    const y = stemTop + 14 + Math.floor(i / 2) * 15;
    return { kind: f.kind, left, y, x: left ? 60 - 22 - (i % 3) * 2 : 60 + 22 + (i % 3) * 2 };
  });
  const label = `Plant at stage ${s} of 12${earned.length ? ` with ${earned.length} ${earned.length === 1 ? "flower" : "flowers"}` : ""}`;

  return (
    <svg
      className={`plant ${wilted ? "wilted" : ""}`}
      viewBox="0 0 120 140"
      width={size}
      height={(size * 140) / 120}
      role="img"
      aria-label={label}
    >
      <defs>
        <radialGradient id="gold-glow">
          <stop offset="0" stopColor="#ffe680" stopOpacity="0.7" />
          <stop offset="1" stopColor="#ffe680" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="pot-shade" x1="0" x2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <ellipse cx="60" cy="134" rx="30" ry="3.5" className="plant-shadow" />
      <g className="plant-sway">
        {s === 0 ? (
          <g>
            <ellipse cx="60" cy="92" rx="5" ry="3.5" className="seed" />
            <path d="M60 90 q2 -6 6 -7" className="stem" strokeWidth="2" fill="none" />
          </g>
        ) : (
          <>
            {side.map((f, i) => (
              <path
                key={"st" + i}
                d={`M60 ${f.y + 10} Q ${(60 + f.x) / 2} ${f.y + 8}, ${f.x} ${f.y}`}
                className="stem"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
              />
            ))}
            <path d={`M60 94 C 58 ${(94 + stemTop) / 2}, 63 ${(94 + stemTop) / 2}, 60 ${stemTop}`} className="stem" strokeWidth="3" fill="none" strokeLinecap="round" />
            {leaves.map((l, i) => (
              <path
                key={i}
                className="leaf"
                style={{ animationDelay: `${i * 0.08}s` }}
                d={
                  l.left
                    ? `M60 ${l.y} q ${-l.len * 0.6} ${-l.len * 0.7} ${-l.len} ${-l.len * 0.15} q ${l.len * 0.5} ${l.len * 0.45} ${l.len} ${l.len * 0.15}`
                    : `M60 ${l.y} q ${l.len * 0.6} ${-l.len * 0.7} ${l.len} ${-l.len * 0.15} q ${-l.len * 0.5} ${l.len * 0.45} ${-l.len} ${l.len * 0.15}`
                }
              />
            ))}
            <path className="leaf" d={`M60 ${stemTop} q -5 -9 0 -14 q 5 5 0 14`} />
            {side.map((f, i) => (
              <g key={"sf" + i} transform={`translate(${f.x} ${f.y}) scale(0.5)`}>
                <g className="flower" style={{ animationDelay: `${0.3 + i * 0.1}s` }}>
                  <FlowerHead kind={f.kind} />
                </g>
              </g>
            ))}
            {bud && <circle cx="60" cy={stemTop - 14} r="4" className="bud" />}
            {crown && (
              <g transform={`translate(60 ${stemTop - 14}) scale(${crown === "bloom" ? 1 : 0.8})`}>
                <g className="flower">
                  <FlowerHead kind={crown} />
                </g>
              </g>
            )}
          </>
        )}
      </g>
      <path d="M36 96 h48 l-6 34 a4 4 0 0 1 -4 3 h-28 a4 4 0 0 1 -4 -3 z" className="pot" />
      <path d="M36 96 h48 l-6 34 a4 4 0 0 1 -4 3 h-28 a4 4 0 0 1 -4 -3 z" fill="url(#pot-shade)" />
      <rect x="32" y="92" width="56" height="9" rx="3" className="pot-rim" />
    </svg>
  );
}
