import type { Active, Phase, Settings } from "./store";

export const MIN = 60_000;

export function phaseElapsed(a: Active, now: number): number {
  const pausedNow = a.pausedAt ? now - a.pausedAt : 0;
  return Math.max(0, now - a.phaseStartedAt - a.pausedMsInPhase - pausedNow);
}

export function focusMs(a: Active, now: number): number {
  return a.focusMsBanked + (a.phase === "focus" ? Math.min(phaseElapsed(a, now), a.phaseDurMs || Infinity) : 0);
}

/** Test runs use tiny timers so every part can be tried in a couple of minutes. */
export function sessionSettings(s: Settings, a: Active | null): Settings {
  return a?.test ? { ...s, focusMin: 1, shortMin: 0.5, longMin: 0.5, roundsBeforeLong: 2, lockInSec: 5 } : s;
}

export function phaseDuration(phase: Phase, s: Settings): number {
  if (phase === "focus") return s.focusMin * MIN;
  if (phase === "short") return s.shortMin * MIN;
  return s.longMin * MIN;
}

/** Moves a pomodoro session to its next phase. Returns the new state. */
export function advance(a: Active, s: Settings, at: number, ideaCount: number): Active {
  if (a.phase === "focus") {
    const rounds = a.rounds + 1;
    const next: Phase = rounds % s.roundsBeforeLong === 0 ? "long" : "short";
    return {
      ...a,
      rounds,
      focusMsBanked: a.focusMsBanked + a.phaseDurMs,
      phase: next,
      phaseStartedAt: at,
      phaseDurMs: phaseDuration(next, s),
      pausedAt: null,
      pausedMsInPhase: 0,
      breakIdea: Math.floor(Math.random() * ideaCount),
    };
  }
  return {
    ...a,
    phase: "focus",
    phaseStartedAt: at,
    phaseDurMs: phaseDuration("focus", s),
    pausedAt: null,
    pausedMsInPhase: 0,
  };
}

/** Ends the current focus round now and starts its break (used by "Break now"). */
export function breakNow(a: Active, s: Settings, at: number, ideaCount: number): Active {
  if (a.phase !== "focus" || a.mode !== "pomodoro") return a;
  return advance({ ...a, phaseDurMs: phaseElapsed(a, at) }, s, at, ideaCount);
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m).padStart(2, "0");
  return (h ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

export function fmtDur(ms: number): string {
  const totalMin = Math.round(ms / MIN);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export const dayKey = (t: number | Date) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
