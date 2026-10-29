import type { VisitorId } from "../lib/garden";

/** A little animal drawn as its own tiny SVG. Movement comes from the wrapper's CSS. */
export function Sprite({ id, size = 34 }: { id: VisitorId | "firefly"; size?: number }) {
  const s = { width: size, height: size };
  switch (id) {
    case "bee":
      return (
        <svg viewBox="-12 -12 24 24" style={s} className="sp sp-bee" aria-hidden="true">
          <ellipse className="wing wl" cx="-2" cy="-6" rx="3.6" ry="5" fill="#fff" opacity="0.85" />
          <ellipse className="wing wr" cx="2.5" cy="-6" rx="3.2" ry="4.6" fill="#eaf6ff" opacity="0.85" />
          <ellipse rx="7" ry="5" fill="#ffd23f" />
          <path d="M-2.5 -4.7 v9.4 M1.5 -4.9 v9.8" stroke="#3a2a1a" strokeWidth="2" />
          <path d="M-7 0 l-2.6 0" stroke="#3a2a1a" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="5" cy="-1" r="1" fill="#3a2a1a" />
          <circle cx="4.6" cy="1.6" r="0.9" fill="#ff9aa8" opacity="0.8" />
        </svg>
      );
    case "butterfly":
      return (
        <svg viewBox="-12 -12 24 24" style={s} className="sp sp-butterfly" aria-hidden="true">
          <g className="bwing bl">
            <path d="M0 0 C -4 -10, -12 -10, -10 -2 C -9 1, -4 1, 0 0 z" fill="#ff8c5a" />
            <path d="M0 0 C -6 2, -9 8, -4 8 C -2 8, -1 4, 0 0 z" fill="#ffb35a" />
            <circle cx="-6.5" cy="-4.5" r="1.4" fill="#fff" opacity="0.8" />
          </g>
          <g className="bwing br">
            <path d="M0 0 C 4 -10, 12 -10, 10 -2 C 9 1, 4 1, 0 0 z" fill="#ff8c5a" />
            <path d="M0 0 C 6 2, 9 8, 4 8 C 2 8, 1 4, 0 0 z" fill="#ffb35a" />
            <circle cx="6.5" cy="-4.5" r="1.4" fill="#fff" opacity="0.8" />
          </g>
          <rect x="-0.9" y="-5" width="1.8" height="11" rx="0.9" fill="#3a2a1a" />
          <path d="M0 -5 q -2 -3 -3 -3.5 M0 -5 q 2 -3 3 -3.5" stroke="#3a2a1a" strokeWidth="0.6" fill="none" />
        </svg>
      );
    case "hummingbird":
      return (
        <svg viewBox="-14 -12 28 24" style={s} className="sp sp-humming" aria-hidden="true">
          <ellipse className="hwing" cx="-1" cy="-6" rx="3" ry="7" fill="#bfe9d8" opacity="0.7" />
          <path d="M-9 3 L -13 6 L -12 2 z" fill="#2c8a6e" />
          <ellipse rx="7.5" ry="4.2" fill="#2fb38a" transform="rotate(-12)" />
          <path d="M2 1.5 q 3 2.5 5 0.5" stroke="#e8445f" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <circle cx="5.5" cy="-2.6" r="3" fill="#3cc79a" />
          <path d="M8 -3 L 14 -2.2" stroke="#3a2a1a" strokeWidth="0.9" strokeLinecap="round" />
          <circle cx="6.3" cy="-3.2" r="0.8" fill="#13241e" />
        </svg>
      );
    case "ladybug":
      return (
        <svg viewBox="-8 -6 16 12" style={s} className="sp sp-ladybug" aria-hidden="true">
          <circle cx="5" cy="1" r="2.4" fill="#1f1f1f" />
          <path d="M-6 3 A 6 6 0 0 1 6 3 z" fill="#e8344a" />
          <path d="M0 -3 V 3" stroke="#1f1f1f" strokeWidth="0.6" />
          <circle cx="-3" cy="0.6" r="1" fill="#1f1f1f" /><circle cx="2.6" cy="0" r="0.9" fill="#1f1f1f" /><circle cx="-1.2" cy="-1.6" r="0.7" fill="#1f1f1f" />
          <circle cx="-3.5" cy="-1" r="0.7" fill="#fff" opacity="0.5" />
        </svg>
      );
    case "snail":
      return (
        <svg viewBox="-12 -10 24 20" style={s} className="sp sp-snail" aria-hidden="true">
          <path d="M-10 6 Q -2 7 9 6 Q 11 5 10 2 L 8 -2 Q 7 3 2 4 Z" fill="#f2d6a8" />
          <path d="M8 -1 L 9 -6 M 10 -0.5 L 12 -5" stroke="#e2c08e" strokeWidth="1" strokeLinecap="round" />
          <circle cx="9" cy="-6.2" r="1" fill="#3a2a1a" /><circle cx="12" cy="-5.2" r="1" fill="#3a2a1a" />
          <circle cx="-2" cy="-1" r="7" fill="#d98a5a" />
          <path d="M-2 -1 m -4.5 0 a 4.5 4.5 0 1 0 4.5 -4.5 a 3 3 0 1 0 1.5 5 a 1.5 1.5 0 1 0 -1.5 -1.5" stroke="#a65a32" strokeWidth="1.1" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "frog":
      return (
        <svg viewBox="-12 -12 24 24" style={s} className="sp sp-frog" aria-hidden="true">
          <ellipse cx="0" cy="4" rx="10" ry="6.5" fill="#5cbf5a" />
          <ellipse cx="0" cy="6" rx="6" ry="3.5" fill="#c8eba0" />
          <circle cx="-5" cy="-3" r="3.8" fill="#5cbf5a" /><circle cx="5" cy="-3" r="3.8" fill="#5cbf5a" />
          <g className="eyes"><circle cx="-5" cy="-3.2" r="2.2" fill="#fff" /><circle cx="5" cy="-3.2" r="2.2" fill="#fff" />
            <circle cx="-4.6" cy="-3" r="1.1" fill="#1f2a1f" /><circle cx="5.4" cy="-3" r="1.1" fill="#1f2a1f" /></g>
          <path d="M-3.5 2.5 q 3.5 2.4 7 0" stroke="#2e7a32" strokeWidth="0.9" fill="none" strokeLinecap="round" />
          <circle cx="-6.5" cy="2" r="1.2" fill="#ff9aa8" opacity="0.6" /><circle cx="6.5" cy="2" r="1.2" fill="#ff9aa8" opacity="0.6" />
        </svg>
      );
    case "robin":
      return (
        <svg viewBox="-12 -12 24 24" style={s} className="sp sp-robin" aria-hidden="true">
          <path d="M-8 2 L -12 0 L -11 4 z" fill="#6b4a36" />
          <ellipse cx="-1" cy="2" rx="8" ry="6" fill="#8a6248" />
          <ellipse cx="2" cy="3" rx="5" ry="4.4" fill="#f08a4b" />
          <g className="head"><circle cx="5" cy="-4" r="4" fill="#8a6248" />
            <path d="M8.6 -4.4 L 11.5 -3.4 L 8.6 -2.6 z" fill="#f2b33d" />
            <circle cx="6" cy="-5" r="0.9" fill="#1f1a16" /><circle cx="6.3" cy="-5.3" r="0.3" fill="#fff" /></g>
          <path d="M-1 8 v3 M2 8 v3" stroke="#c98a4a" strokeWidth="0.8" />
        </svg>
      );
    case "hedgehog":
      return (
        <svg viewBox="-13 -10 26 20" style={s} className="sp sp-hedgehog" aria-hidden="true">
          <path d="M-11 6 Q -12 -8 0 -8 Q 9 -8 10 2 L 6 6 Z" fill="#7a5a44" />
          {Array.from({ length: 9 }, (_, i) => <path key={i} d={`M${-9 + i * 2.2} ${-3 - Math.sin(i / 2.6) * 4} l -1.2 -3.2 l 2.4 0.8 z`} fill="#5e4434" />)}
          <g className="snout"><path d="M4 -1 Q 13 1 12 4 Q 8 7 3 6 Z" fill="#e9c9a2" />
            <circle cx="12.2" cy="3" r="1.2" fill="#2a1f18" /><circle cx="7.5" cy="1.4" r="0.9" fill="#2a1f18" /></g>
          <path d="M-6 6 v1.6 M2 6 v1.6" stroke="#5e4434" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "cat":
      return (
        <svg viewBox="-16 -12 32 24" style={s} className="sp sp-cat" aria-hidden="true">
          <path className="tail" d="M10 6 q 7 -1 5 -8" stroke="#f0a050" strokeWidth="3.2" fill="none" strokeLinecap="round" />
          <ellipse cx="0" cy="3" rx="12" ry="7" fill="#f0a050" />
          <path d="M-6 -1 q 2 3 0 7 M0 -3 q 2 4 0 9 M5 -2 q 2 3 0 7" stroke="#d9823a" strokeWidth="1.3" fill="none" />
          <circle cx="-9" cy="0" r="5.5" fill="#f0a050" />
          <path d="M-13.5 -3 L -13 -9 L -9.5 -5 z M -8 -5 L -5 -9 L -4.6 -3 z" fill="#f0a050" />
          <path d="M-12 0 q 1 1 2 0 M-8 0 q 1 1 2 0" stroke="#5a3a20" strokeWidth="0.8" fill="none" strokeLinecap="round" />
          <circle cx="-9" cy="2.2" r="0.7" fill="#e8708a" />
        </svg>
      );
    case "firefly":
      return (
        <svg viewBox="-6 -6 12 12" style={s} className="sp sp-firefly" aria-hidden="true">
          <circle r="4.5" fill="#fff59a" opacity="0.45" />
          <circle r="2.4" fill="#fffde6" />
        </svg>
      );
  }
}
