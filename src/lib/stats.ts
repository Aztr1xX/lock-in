import type { Session } from "./store";
import { dayKey, MIN } from "./timer";

/** A day counts toward the streak once it has one full Pomodoro (25 min) of focus. */
export const STREAK_MIN = 25;

export function minutesByDay(sessions: Session[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions) {
    const k = dayKey(s.start);
    m.set(k, (m.get(k) ?? 0) + s.focusMs / MIN);
  }
  return m;
}

export function streak(sessions: Session[], extraTodayMin = 0, now = Date.now()): { days: number; todayDone: boolean } {
  const byDay = minutesByDay(sessions);
  const today = dayKey(now);
  byDay.set(today, (byDay.get(today) ?? 0) + extraTodayMin);
  const todayDone = (byDay.get(today) ?? 0) >= STREAK_MIN;
  let days = 0;
  const d = new Date(now);
  if (!todayDone) d.setDate(d.getDate() - 1);
  while ((byDay.get(dayKey(d)) ?? 0) >= STREAK_MIN) {
    days++;
    d.setDate(d.getDate() - 1);
  }
  return { days, todayDone };
}

export function todayMinutes(sessions: Session[], now = Date.now()): number {
  return minutesByDay(sessions).get(dayKey(now)) ?? 0;
}

export function totalHours(sessions: Session[]): number {
  return sessions.reduce((a, s) => a + s.focusMs, 0) / (60 * MIN);
}

export function subjectMinutes(sessions: Session[], sinceMs: number): [string, number][] {
  const m = new Map<string, number>();
  for (const s of sessions) if (s.start >= sinceMs) m.set(s.subject, (m.get(s.subject) ?? 0) + s.focusMs / MIN);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function startOfWeek(now = Date.now()): number {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // Monday first
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}

/** Plant grows one stage per focused hour, up to 12. */
export const plantStage = (hours: number) => Math.min(12, Math.floor(hours));
