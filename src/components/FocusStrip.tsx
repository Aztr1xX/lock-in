import type { TracePoint } from "../lib/camera";

/** One bar per focused minute, coloured by how locked in the camera thought you were. */
export default function FocusStrip({ trace, height = 28 }: { trace: TracePoint[]; height?: number }) {
  if (!trace.length) return null;
  const avg = trace.reduce((a, p) => a + p.s, 0) / trace.length;
  return (
    <div className="strip-wrap">
      <div className="strip" style={{ height }} role="img" aria-label={`Focus score ${Math.round(avg * 100)} percent across ${trace.length} minutes`}>
        {trace.map((p) => (
          <span
            key={p.t}
            style={{ "--s": p.s } as React.CSSProperties}
            title={`${new Date(p.t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}: ${Math.round(p.s * 100)}%`}
          />
        ))}
      </div>
      <span className="strip-score">{Math.round(avg * 100)}%<small> focused</small></span>
    </div>
  );
}
