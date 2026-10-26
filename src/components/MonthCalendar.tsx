import { useMemo, useState } from "react";
import type { Exam, Session } from "../lib/store";
import { minutesByDay, STREAK_MIN } from "../lib/stats";
import { dayKey, fmtDur, MIN } from "../lib/timer";

interface Props {
  sessions: Session[];
  exams: Exam[];
  goalMin: number;
  now: number;
  liveMin?: number;
}

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

/** This month at a glance: greener days are bigger days, amber rings are exams. */
export default function MonthCalendar({ sessions, exams, goalMin, now, liveMin = 0 }: Props) {
  const [offset, setOffset] = useState(0);
  const byDay = useMemo(() => minutesByDay(sessions), [sessions]);
  const examDays = useMemo(() => new Map(exams.map((e) => [e.date, e.name])), [exams]);

  const first = new Date(now);
  first.setHours(0, 0, 0, 0);
  first.setDate(1);
  first.setMonth(first.getMonth() + offset);
  const month = first.getMonth();
  const lead = (first.getDay() + 6) % 7; // Monday first
  const daysIn = new Date(first.getFullYear(), month + 1, 0).getDate();
  const todayKey = dayKey(now);

  let total = 0, studied = 0;
  const cells = Array.from({ length: daysIn }, (_, i) => {
    const d = new Date(first.getFullYear(), month, i + 1);
    const k = dayKey(d);
    const min = (byDay.get(k) ?? 0) + (k === todayKey ? liveMin : 0);
    total += min;
    if (min >= STREAK_MIN) studied++;
    const level = min <= 0 ? 0 : min < STREAK_MIN ? 1 : min < goalMin / 2 ? 2 : min < goalMin ? 3 : 4;
    const exam = examDays.get(k);
    const label = `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · ${min ? fmtDur(min * MIN) : "no study"}${exam ? ` · ${exam} exam` : ""}`;
    return { day: i + 1, k, level, exam, label, future: d.getTime() > now };
  });

  return (
    <section className="month-cal card" aria-label="This month">
      <header className="mc-head">
        <button className="icon-btn small" onClick={() => setOffset((o) => o - 1)} aria-label="Previous month">‹</button>
        <h3 key={offset}>{first.toLocaleDateString(undefined, { month: "long", year: first.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" })}</h3>
        <button className="icon-btn small" onClick={() => setOffset((o) => Math.min(0, o + 1))} disabled={offset === 0} aria-label="Next month">›</button>
      </header>
      <div className="mc-grid" key={"g" + offset}>
        {WEEKDAYS.map((w, i) => <span key={"w" + i} className="mc-wd">{w}</span>)}
        {Array.from({ length: lead }, (_, i) => <span key={"e" + i} />)}
        {cells.map((c, i) => (
          <span
            key={c.k}
            className={`mc-day l${c.level} ${c.k === todayKey ? "today" : ""} ${c.exam ? "exam" : ""} ${c.future ? "future" : ""}`}
            title={c.label}
            style={{ animationDelay: `${i * 12}ms` }}
          >
            {c.day}
          </span>
        ))}
      </div>
      <footer className="mc-foot">
        <span><b>{fmtDur(total * MIN)}</b> this month</span>
        <span><b>{studied}</b> {studied === 1 ? "day" : "days"} studied</span>
      </footer>
    </section>
  );
}
