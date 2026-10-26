import type { Session, Settings } from "./store";
import { MIN } from "./timer";
import { minutesByDay, plantStage, streak, totalHours } from "./stats";

export interface Badge {
  id: string;
  icon: string;
  name: string;
  how: string;
}

export const BADGES: Badge[] = [
  { id: "first", icon: "🌱", name: "First step", how: "Finish your first session" },
  { id: "streak3", icon: "🔥", name: "Warming up", how: "Study 3 days in a row" },
  { id: "streak7", icon: "⚡", name: "On a roll", how: "Study 7 days in a row" },
  { id: "streak30", icon: "🏆", name: "Unstoppable", how: "Study 30 days in a row" },
  { id: "goal", icon: "🎯", name: "Goal getter", how: "Hit your daily goal" },
  { id: "week", icon: "📅", name: "Perfect week", how: "Hit your daily goal 7 days in a row" },
  { id: "marathon", icon: "🏃", name: "Marathon", how: "Do 4 Pomodoro rounds in one session" },
  { id: "subject10", icon: "📚", name: "Specialist", how: "Put 10 hours into one subject" },
  { id: "hours50", icon: "🧠", name: "Big brain", how: "Study 50 hours in total" },
  { id: "owl", icon: "🦉", name: "Night owl", how: "Start a session after 10pm" },
  { id: "bird", icon: "🐦", name: "Early bird", how: "Start a session before 8am" },
  { id: "lockedin", icon: "😤", name: "Locked in", how: "Rate a session 5 out of 5" },
  { id: "nophone", icon: "📵", name: "Phone? What phone?", how: "50+ focused minutes with no phone pickups" },
  { id: "bloom", icon: "🌸", name: "In bloom", how: "Grow your plant to full size (12 hours)" },
];

/** Every badge these sessions have earned. Worked out fresh each time, so nothing can drift. */
export function earned(sessions: Session[], settings: Settings): Set<string> {
  const got = new Set<string>();
  if (!sessions.length) return got;
  got.add("first");

  const byDay = minutesByDay(sessions);
  const best = longestRun([...byDay.entries()].filter(([, m]) => m >= 25).map(([k]) => k));
  const cur = streak(sessions).days;
  const run = Math.max(best, cur);
  if (run >= 3) got.add("streak3");
  if (run >= 7) got.add("streak7");
  if (run >= 30) got.add("streak30");

  const goalDays = [...byDay.entries()].filter(([, m]) => m >= settings.dailyGoalMin).map(([k]) => k);
  if (goalDays.length) got.add("goal");
  if (longestRun(goalDays) >= 7) got.add("week");

  const perSubject = new Map<string, number>();
  for (const s of sessions) {
    perSubject.set(s.subject, (perSubject.get(s.subject) ?? 0) + s.focusMs);
    if (s.rounds >= 4) got.add("marathon");
    const h = new Date(s.start).getHours();
    if (h >= 22) got.add("owl");
    if (h >= 4 && h < 8) got.add("bird");
    if (s.rating === 5) got.add("lockedin");
    if (s.counts && s.counts.phone === 0 && s.focusMs >= 50 * MIN) got.add("nophone");
  }
  if ([...perSubject.values()].some((ms) => ms >= 10 * 60 * MIN)) got.add("subject10");
  const hours = totalHours(sessions);
  if (hours >= 50) got.add("hours50");
  if (plantStage(hours) >= 12) got.add("bloom");
  return got;
}

function longestRun(dayKeys: string[]): number {
  const days = dayKeys.map((k) => new Date(k + "T12:00").getTime()).sort((a, b) => a - b);
  let best = 0, run = 0, prev: number | null = null;
  for (const t of days) {
    run = prev !== null && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}
