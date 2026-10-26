import type { FlowerKind } from "../lib/flowers";

const ring = (n: number, fn: (deg: number) => React.ReactElement) =>
  Array.from({ length: n }, (_, i) => fn((360 / n) * i));

/** One flower head drawn around (0, 0), about 28 units across. Use inside an <svg>. */
export function FlowerHead({ kind }: { kind: FlowerKind }) {
  switch (kind) {
    case "daisy":
      return (
        <g className="fl fl-daisy">
          {ring(14, (d) => <ellipse key={d} rx="2.2" ry="7.5" cy="-7.5" fill="#f7f7f2" transform={`rotate(${d})`} />)}
          <circle r="4.4" fill="#f5c542" />
        </g>
      );
    case "tulip":
      return (
        <g className="fl fl-tulip" transform="translate(0 2)">
          <path d="M-8 -2 C -9 -10, -6 -14, -4 -15 L 0 -9 L 4 -15 C 6 -14, 9 -10, 8 -2 C 7 4, -7 4, -8 -2 z" fill="#ff5d73" />
          <path d="M-3 -1 C -4 -9, -1 -15, 0 -16 C 1 -15, 4 -9, 3 -1 z" fill="#ff8597" />
        </g>
      );
    case "sunflower":
      return (
        <g className="fl fl-sunflower">
          {ring(16, (d) => <path key={d} d="M0 -6 C 2.5 -9, 2 -13, 0 -15 C -2 -13, -2.5 -9, 0 -6 z" fill="#ffc22e" transform={`rotate(${d})`} />)}
          {ring(16, (d) => <path key={"b" + d} d="M0 -6 C 2 -8.5, 1.6 -11, 0 -12.5 C -1.6 -11, -2 -8.5, 0 -6 z" fill="#ffa81e" transform={`rotate(${d + 11.25})`} />)}
          <circle r="6.5" fill="#6b3f1d" />
          <circle r="4" fill="#4e2c12" />
        </g>
      );
    case "rose":
      return (
        <g className="fl fl-rose">
          {ring(5, (d) => <circle key={d} r="5.5" cy="-6" fill="#d9304f" transform={`rotate(${d})`} />)}
          <circle r="7" fill="#e8445f" />
          <path d="M-4 0 a4 4 0 1 1 6 3.4 M -1.5 -1 a 2 2 0 1 1 3 1.6" stroke="#a81f3a" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        </g>
      );
    case "lotus":
      return (
        <g className="fl fl-lotus" transform="translate(0 3)">
          {[-50, -25, 25, 50].map((d) => <path key={d} d="M0 0 C 4 -5, 4 -11, 0 -15 C -4 -11, -4 -5, 0 0 z" fill="#f7a8c8" transform={`rotate(${d})`} />)}
          <path d="M0 0 C 5 -5, 5 -12, 0 -17 C -5 -12, -5 -5, 0 0 z" fill="#ffc4dc" />
          <ellipse rx="9" ry="2.4" cy="1" fill="#e47fa9" />
        </g>
      );
    case "sakura":
      return (
        <g className="fl fl-sakura">
          {ring(5, (d) => <path key={d} d="M0 -1 C 6 -4, 6 -11, 2 -13 L 0 -11 L -2 -13 C -6 -11, -6 -4, 0 -1 z" fill="#ffd1e1" transform={`rotate(${d})`} />)}
          <circle r="2.6" fill="#ff8fb5" />
          {ring(5, (d) => <circle key={"s" + d} r="0.9" cy="-4.5" fill="#d9447c" transform={`rotate(${d + 36})`} />)}
        </g>
      );
    case "orchid":
      return (
        <g className="fl fl-orchid">
          {[0, 120, 240].map((d) => <ellipse key={d} rx="3.6" ry="8.5" cy="-8" fill="#c79bff" transform={`rotate(${d})`} />)}
          {[60, 300].map((d) => <ellipse key={d} rx="5.5" ry="7" cy="-7" fill="#b07cf7" transform={`rotate(${d})`} />)}
          <path d="M-4 1 C -4 8, 4 8, 4 1 C 2 3, -2 3, -4 1 z" fill="#7d3fd1" />
          <circle r="2" fill="#ffe27a" />
        </g>
      );
    case "golden":
      return (
        <g className="fl fl-golden">
          <circle r="15" fill="url(#gold-glow)" />
          {ring(12, (d) => <path key={d} d="M0 -4 L 2.6 -10 L 0 -15 L -2.6 -10 z" fill="#ffd54a" transform={`rotate(${d})`} />)}
          {ring(12, (d) => <path key={"i" + d} d="M0 -3 L 1.8 -7 L 0 -10 L -1.8 -7 z" fill="#fff1a8" transform={`rotate(${d + 15})`} />)}
          <circle r="4" fill="#ffb300" />
        </g>
      );
    default:
      return (
        <g className="fl fl-bloom">
          {ring(8, (d) => <ellipse key={d} rx="4" ry="8" cy="-7" className="petal" transform={`rotate(${d})`} />)}
          <circle r="4.5" className="flower-core" />
        </g>
      );
  }
}

/** A flower on its own, for the collection shelf and unlock cards. */
export default function Flower({ kind, size = 40, locked = false }: { kind: FlowerKind; size?: number; locked?: boolean }) {
  return (
    <svg viewBox="-18 -18 36 36" width={size} height={size} className={`flower-icon ${locked ? "locked" : ""}`} aria-hidden="true">
      <defs>
        <radialGradient id="gold-glow">
          <stop offset="0" stopColor="#ffe680" stopOpacity="0.7" />
          <stop offset="1" stopColor="#ffe680" stopOpacity="0" />
        </radialGradient>
      </defs>
      <FlowerHead kind={kind} />
    </svg>
  );
}
