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

const MAX_AHEAD = 12;

/** A month at a glance: greener days are bigger days, amber rings are exams. Flip forward to see what's coming up. */
export default function MonthCalendar({ sessions, exams, goalMin, now, liveMin = 0 }: Props) {
  const [offset, setOffset] = useState(0);
  const byDay = useMemo(() => minutesByDay(sessions), [sessions]);
  const examDays = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of exams) m.set(e.date, m.has(e.date) ? `${m.get(e.date)} + ${e.name}` : e.name);
    return m;
  }, [exams]);

  const first = new Date(now);
  first.setHours(0, 0, 0, 0);
  first.setDate(1);
  first.setMonth(first.getMonth() + offset);
  const month = first.getMonth();
  const lead = (first.getDay() + 6) % 7; // Monday first
  const daysIn = new Date(first.getFullYear(), month + 1, 0).getDate();
  const todayKey = dayKey(now);
  const today = new Date(now);
  // How far forward you can flip: a year, or further if an exam is booked later than that.
  const maxAhead = exams.reduce((m, e) => {
    const [y, mo] = e.date.split("-").map(Number);
    return Math.max(m, (y - today.getFullYear()) * 12 + (mo - 1 - today.getMonth()));
  }, MAX_AHEAD);

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
    return { day: i + 1, k, level, exam, label, future: d.getTime() > now, date: d };
  });
  const monthExams = cells.filter((c) => c.exam && c.k >= todayKey);
  const ahead = (side: number) => exams.some((e) => {
    const [y, mo] = e.date.split("-").map(Number);
    const m = (y - first.getFullYear()) * 12 + (mo - 1 - month);
    return side > 0 ? m > 0 && e.date >= todayKey : m < 0 && e.date >= todayKey;
  });
  const daysTo = (d: Date) => Math.round((d.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 864e5);

  return (
    <section className="month-cal card" aria-label="Calendar">
      <header className="mc-head">
        <button className={`icon-btn small ${ahead(-1) ? "has-exam" : ""}`} onClick={() => setOffset((o) => o - 1)} aria-label="Previous month"><Chevron dir={-1} /></button>
        <div className="mc-title">
          <h3 key={offset}>{first.toLocaleDateString(undefined, { month: "long", year: first.getFullYear() === today.getFullYear() ? undefined : "numeric" })}</h3>
          {offset !== 0 && <button className="mc-today" onClick={() => setOffset(0)}>Today</button>}
        </div>
        <button className={`icon-btn small ${ahead(1) ? "has-exam" : ""}`} onClick={() => setOffset((o) => Math.min(maxAhead, o + 1))} disabled={offset >= maxAhead} aria-label={ahead(1) ? "Next month (exams ahead)" : "Next month"}><Chevron dir={1} /></button>
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
      {offset <= 0 && (
        <footer className="mc-foot">
          <span><b>{fmtDur(total * MIN)}</b> {offset === 0 ? "this month" : "that month"}</span>
          <span><b>{studied}</b> {studied === 1 ? "day" : "days"} studied</span>
        </footer>
      )}
      {monthExams.length > 0 ? (
        <ul className="mc-exams" key={"x" + offset}>
          {monthExams.map((c) => {
            const n = daysTo(c.date);
            return (
              <li key={c.k}>
                <i />
                <b>{c.exam}</b>
                <span>{c.date.toLocaleDateString(undefined, { weekday: "short" })} {c.day} · {n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`}</span>
              </li>
            );
          })}
        </ul>
      ) : offset > 0 && (
        <p className="mc-none" key={"n" + offset}>{ahead(1) ? "No exams this month. More further on." : exams.some((e) => e.date >= todayKey) ? "No exams this month." : "No exams coming up. Add them in Settings."}</p>
      )}
    </section>
  );
}

function Chevron({ dir }: { dir: number }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d={dir < 0 ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
