interface Props {
  size: number;
  stroke: number;
  progress: number; // 0..1
  ticks?: number;
  className?: string;
  children?: React.ReactNode;
}

/** Progress ring with optional minute ticks. Colors come from CSS (--ring, --ring-track). */
export default function Ring({ size, stroke, progress, ticks = 0, className, children }: Props) {
  const r = (size - stroke) / 2 - (ticks ? 10 : 0);
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  const cx = size / 2;
  return (
    <div className={`ring ${className ?? ""}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        {ticks > 0 &&
          Array.from({ length: ticks }, (_, i) => {
            const a = (i / ticks) * Math.PI * 2 - Math.PI / 2;
            const major = i % 5 === 0;
            const r1 = size / 2 - 2;
            const r2 = r1 - (major ? 7 : 4);
            const lit = i / ticks < p;
            return (
              <line
                key={i}
                x1={cx + Math.cos(a) * r1}
                y1={cx + Math.sin(a) * r1}
                x2={cx + Math.cos(a) * r2}
                y2={cx + Math.sin(a) * r2}
                className={lit ? "tick lit" : "tick"}
                strokeWidth={major ? 2 : 1.2}
              />
            );
          })}
        <circle cx={cx} cy={cx} r={r} fill="none" className="ring-track" strokeWidth={stroke} />
        <circle
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          className="ring-bar"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
          transform={`rotate(-90 ${cx} ${cx})`}
        />
        {p > 0.005 && (
          <circle
            className="ring-head"
            cx={cx + Math.cos(p * Math.PI * 2 - Math.PI / 2) * r}
            cy={cx + Math.sin(p * Math.PI * 2 - Math.PI / 2) * r}
            r={stroke / 2 + 2}
          />
        )}
      </svg>
      <div className="ring-inner">{children}</div>
    </div>
  );
}
