import { useCallback, useEffect, useState } from "react";
import type { ShrubState } from "../lib/garden";

export type ShrubMood = "idle" | "hum" | "shocked" | "sleep";

// Leaf clumps around his middle, in the order they grow in. He starts with 5 and ends with 14.
const CLUMPS: [number, number, number][] = [
  [-20, -14, 16], [20, -14, 16], [0, -26, 17], [-24, 6, 14], [24, 6, 14],
  [-11, -36, 13], [12, -37, 13], [-34, -6, 12], [34, -6, 12],
  [-30, -27, 11], [30, -27, 11], [0, -46, 11], [-37, 14, 10], [37, 14, 10],
];
const GREENS = ["#3f9a55", "#4aa35e", "#378d4c", "#459f59"];
const CY = -46; // the middle of his body

/** Shrubert: a little shrub with feet. Bushier the more you study; his face shows how he feels. */
export default function Shrubert({ shrub, mood = "idle", size = 110, flash = 0 }: { shrub: ShrubState; mood?: ShrubMood; size?: number; flash?: number }) {
  const n = 5 + Math.round(shrub.bush * (CLUMPS.length - 5));
  const clumps = CLUMPS.slice(0, n);
  const grow = 0.84 + shrub.bush * 0.26;
  const top = Math.min(...clumps.map(([x, y, r]) => (Math.abs(x) < 14 ? CY + y - r : 0)));
  return (
    <svg
      key={flash}
      viewBox="-62 -130 124 134"
      width={size}
      height={(size * 134) / 124}
      className={`shb mood-${mood}`}
      aria-hidden="true"
    >
      <ellipse cx="0" cy="1" rx={30 * grow} ry="4.5" fill="rgba(0,0,0,0.2)" />
      <g className="shb-all">
        <g transform={`scale(${grow})`}>
          {/* little root feet */}
          <g className="shb-feet" fill="#8a5a3b">
            <path d="M-12 -12 q -2 8 -8 11 q 6 2 12 0 q 2 -5 1 -11 z" />
            <path d="M12 -12 q 2 8 8 11 q -6 2 -12 0 q -2 -5 -1 -11 z" />
          </g>
          <g className="shb-leaves">
            {clumps.map(([x, y, r], i) => (
              <g key={i}>
                <circle cx={x} cy={CY + y} r={r} fill={GREENS[i % GREENS.length]} />
                <circle cx={x - r * 0.3} cy={CY + y - r * 0.32} r={r * 0.42} fill="#6cc27a" opacity="0.45" />
              </g>
            ))}
            {shrub.berries && clumps.filter((_, i) => i % 3 === 1).map(([x, y, r], i) => (
              <g key={`b${i}`} fill="#e2435a">
                <circle cx={x + r * 0.35} cy={CY + y + r * 0.2} r="2.6" />
                <circle cx={x + r * 0.35 + 3.4} cy={CY + y + r * 0.2 + 1.6} r="2.3" />
                <circle cx={x + r * 0.35 + 0.6} cy={CY + y + r * 0.2 + 3.8} r="2.2" />
              </g>
            ))}
            {shrub.flowers && clumps.filter((_, i) => i % 2 === 0).map(([x, y, r], i) => (
              <g key={`f${i}`} transform={`translate(${x - r * 0.45} ${CY + y - r * 0.55})`}>
                {[0, 72, 144, 216, 288].map((a) => <circle key={a} cx={Math.cos((a * Math.PI) / 180) * 2.8} cy={Math.sin((a * Math.PI) / 180) * 2.8} r="2.3" fill={i % 2 ? "#fff3f8" : "#ff9fc2"} />)}
                <circle r="1.7" fill="#ffd166" />
              </g>
            ))}
          </g>
          {/* body and face */}
          <g className="shb-body">
            <circle cx="0" cy={CY} r="26" fill="#57b06a" />
            <circle cx="-7" cy={CY - 8} r="13" fill="#7fcf8a" opacity="0.4" />
            <circle cx="-14" cy={CY + 5} r="3.6" fill="#ff9aa8" opacity="0.65" />
            <circle cx="14" cy={CY + 5} r="3.6" fill="#ff9aa8" opacity="0.65" />
            {mood === "shocked" ? (
              <g>
                <path d={`M-14 ${CY - 13} l 8 -3 M14 ${CY - 13} l -8 -3`} stroke="#10201a" strokeWidth="1.8" strokeLinecap="round" />
                <circle cx="-8" cy={CY - 3} r="5.4" fill="#fff" /><circle cx="8" cy={CY - 3} r="5.4" fill="#fff" />
                <circle className="shb-pupil" cx="-8" cy={CY - 3} r="2" fill="#10201a" /><circle className="shb-pupil" cx="8" cy={CY - 3} r="2" fill="#10201a" />
                <ellipse cx="0" cy={CY + 10} rx="3.6" ry="4.6" fill="#10201a" />
              </g>
            ) : mood === "hum" ? (
              <g stroke="#10201a" strokeWidth="2" fill="none" strokeLinecap="round">
                <path d={`M-11 ${CY - 2} q 3 -4 6 0 M5 ${CY - 2} q 3 -4 6 0`} />
                <ellipse className="shb-mouth-hum" cx="0" cy={CY + 9} rx="2.4" ry="2.8" fill="#10201a" stroke="none" />
              </g>
            ) : mood === "sleep" ? (
              <g stroke="#10201a" strokeWidth="2" fill="none" strokeLinecap="round">
                <path d={`M-11 ${CY - 3} q 3 3.5 6 0 M5 ${CY - 3} q 3 3.5 6 0`} />
                <path d={`M-2 ${CY + 9} q 2 1.4 4 0`} strokeWidth="1.6" />
              </g>
            ) : (
              <g>
                <g className="shb-eyes">
                  <ellipse cx="-8" cy={CY - 2} rx="2.8" ry="3.7" fill="#10201a" /><ellipse cx="8" cy={CY - 2} rx="2.8" ry="3.7" fill="#10201a" />
                  <circle cx="-7.1" cy={CY - 3.5} r="1" fill="#fff" /><circle cx="8.9" cy={CY - 3.5} r="1" fill="#fff" />
                </g>
                <path d={`M-4.5 ${CY + 7} q 4.5 4 9 0`} stroke="#10201a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
              </g>
            )}
          </g>
          {/* a little curl of leaf on top, or a golden flower once he's grand */}
          {mood !== "sleep" && <g transform={`translate(2 ${top + 3})`}><g className="shb-tuft">
            {shrub.crown ? (
              <g transform="translate(0 -4)">
                {[0, 60, 120, 180, 240, 300].map((a) => <ellipse key={a} cx="0" cy="-5" rx="2.8" ry="5" fill="#ffc94a" transform={`rotate(${a})`} />)}
                <circle r="3.2" fill="#ff9a3c" />
              </g>
            ) : (
              <>
                <path d="M0 0 q -1 -7 2 -11" stroke="#2f7d45" strokeWidth="2.2" fill="none" strokeLinecap="round" />
                <path d="M2 -11 q 9 -5 12 2 q -7 4 -12 -2" fill="#5ec274" />
              </>
            )}
          </g></g>}
          {mood === "sleep" && (
            <g transform={`translate(-4 ${top + 6}) rotate(-14)`}><g className="shb-cap">
              <path d="M-15 0 Q -4 -6 14 0 Q 6 -14 -2 -24 Q -8 -12 -15 0 z" fill="#6c7ee8" />
              <path d="M-10.5 -7 Q 0 -11 9 -7" stroke="#fff" strokeWidth="2.4" fill="none" opacity="0.7" />
              <path d="M-16 0 Q -1 -5 15 0" stroke="#e8ecff" strokeWidth="4.5" fill="none" strokeLinecap="round" />
              <circle cx="-2" cy="-25" r="3.6" fill="#fff" />
            </g></g>
          )}
        </g>
      </g>
      {mood === "hum" && (
        <g className="shb-notes" fill="#2f7d45" stroke="#fff" strokeWidth="3" paintOrder="stroke" fontWeight="800">
          <text x="26" y="-72" fontSize="22">♪</text>
          <text x="36" y="-90" fontSize="18">♫</text>
          <text x="-44" y="-80" fontSize="20">♪</text>
        </g>
      )}
      {mood === "shocked" && (
        <g>
          <text className="shb-bang" x="30" y="-90" fontSize="26" fontWeight="900" fill="#ff5a4d">!</text>
          <g className="shb-falling">
            <ellipse cx="-28" cy="-70" rx="5" ry="2.6" fill="#4aa35e" />
            <ellipse cx="26" cy="-62" rx="4.4" ry="2.4" fill="#3f9a55" />
          </g>
        </g>
      )}
      {mood === "sleep" && (
        <text className="shb-zz" x="22" y="-86" fontSize="13" fontWeight="800" fill="#e6e9ff">z<tspan fontSize="10" dx="2" dy="-6">z</tspan></text>
      )}
    </svg>
  );
}

/**
 * His mood right now: asleep while the sky is dark, otherwise awake.
 * `react` makes him hum or look shocked for a few seconds, then he settles back.
 */
export function useShrubMood(night: boolean) {
  const [flash, setFlash] = useState<{ mood: "hum" | "shocked"; n: number } | null>(null);
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), flash.mood === "hum" ? 5200 : 3800);
    return () => clearTimeout(id);
  }, [flash]);
  const react = useCallback((mood: "hum" | "shocked") => setFlash({ mood, n: Date.now() }), []);
  const mood: ShrubMood = flash?.mood ?? (night ? "sleep" : "idle");
  return { mood, react, flash: flash?.n ?? 0 };
}
