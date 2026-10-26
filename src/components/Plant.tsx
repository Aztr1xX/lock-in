/** A little potted plant that grows a stage for every focused hour (0 to 12). */
export default function Plant({ stage, size = 120, wilted = false }: { stage: number; size?: number; wilted?: boolean }) {
  const s = Math.max(0, Math.min(12, stage));
  const stemTop = 92 - Math.min(64, 10 + s * 5.5);
  const leaves = Array.from({ length: Math.min(s, 9) }, (_, i) => {
    const y = 90 - (i + 1) * ((90 - stemTop) / (Math.min(s, 9) + 1));
    const left = i % 2 === 0;
    const len = 13 + Math.min(i, 4) * 1.5;
    return { y, left, len };
  });
  const flower = s >= 10;
  const bud = s >= 8 && !flower;
  const petals = s >= 12 ? 8 : 6;
  return (
    <svg
      className={`plant ${wilted ? "wilted" : ""}`}
      viewBox="0 0 120 140"
      width={size}
      height={(size * 140) / 120}
      role="img"
      aria-label={`Plant at stage ${s} of 12`}
    >
      <g className="plant-sway">
        {s === 0 ? (
          <g>
            <ellipse cx="60" cy="92" rx="5" ry="3.5" className="seed" />
            <path d="M60 90 q2 -6 6 -7" className="stem" strokeWidth="2" fill="none" />
          </g>
        ) : (
          <>
            <path d={`M60 94 C 58 ${(94 + stemTop) / 2}, 63 ${(94 + stemTop) / 2}, 60 ${stemTop}`} className="stem" strokeWidth="3" fill="none" strokeLinecap="round" />
            {leaves.map((l, i) => (
              <path
                key={i}
                className="leaf"
                style={{ animationDelay: `${i * 0.12}s` }}
                d={
                  l.left
                    ? `M60 ${l.y} q ${-l.len * 0.6} ${-l.len * 0.7} ${-l.len} ${-l.len * 0.15} q ${l.len * 0.5} ${l.len * 0.45} ${l.len} ${l.len * 0.15}`
                    : `M60 ${l.y} q ${l.len * 0.6} ${-l.len * 0.7} ${l.len} ${-l.len * 0.15} q ${-l.len * 0.5} ${l.len * 0.45} ${-l.len} ${l.len * 0.15}`
                }
              />
            ))}
            <path className="leaf" d={`M60 ${stemTop} q -5 -9 0 -14 q 5 5 0 14`} />
            {bud && <circle cx="60" cy={stemTop - 14} r="4" className="bud" />}
            {flower && (
              <g transform={`translate(60 ${stemTop - 14})`} className="flower">
                {Array.from({ length: petals }, (_, i) => (
                  <ellipse key={i} rx="4" ry="8" cy="-7" className="petal" transform={`rotate(${(360 / petals) * i})`} />
                ))}
                <circle r="4.5" className="flower-core" />
              </g>
            )}
          </>
        )}
      </g>
      <path d="M36 96 h48 l-6 34 a4 4 0 0 1 -4 3 h-28 a4 4 0 0 1 -4 -3 z" className="pot" />
      <rect x="32" y="92" width="56" height="9" rx="3" className="pot-rim" />
    </svg>
  );
}
