import { useMemo, useState } from "react";
import type { Session, Settings } from "../lib/store";
import { dayKey, fmtDur, MIN } from "../lib/timer";
import { minutesByDay, plantStage, startOfWeek, streak, STREAK_MIN, subjectMinutes, totalHours } from "../lib/stats";
import { subjectHue } from "../lib/content";
import Plant from "./Plant";
import { IconBack, IconTrash } from "./Icons";

interface Props {
  sessions: Session[];
  settings: Settings;
  onBack: () => void;
  onDelete: (id: string) => void;
}

const WEEKS = 18;
const dayNames = ["Mon", "", "Wed", "", "Fri", "", "Sun"];

export default function Stats({ sessions, settings, onBack, onDelete }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const now = Date.now();
  const week0 = startOfWeek(now);
  const weekMin = sessions.filter((s) => s.start >= week0).reduce((a, s) => a + s.focusMs / MIN, 0);
  const lastWeekMin = sessions.filter((s) => s.start >= week0 - 7 * 86_400_000 && s.start < week0).reduce((a, s) => a + s.focusMs / MIN, 0);
  const st = streak(sessions);
  const hours = totalHours(sessions);
  const stage = plantStage(hours);
  const rated = sessions.filter((s) => s.rating);
  const avgRating = rated.length ? rated.reduce((a, s) => a + (s.rating ?? 0), 0) / rated.length : 0;
  const subjects = subjectMinutes(sessions, week0);
  const maxSubject = Math.max(1, ...subjects.map(([, m]) => m));

  const byDay = useMemo(() => minutesByDay(sessions), [sessions]);
  const best = useMemo(() => {
    const keys = [...byDay.entries()].filter(([, m]) => m >= STREAK_MIN).map(([k]) => k).sort();
    let bestRun = 0, run = 0, prev: number | null = null;
    for (const k of keys) {
      const t = new Date(k + "T12:00").getTime();
      run = prev !== null && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1;
      bestRun = Math.max(bestRun, run);
      prev = t;
    }
    return bestRun;
  }, [byDay]);

  const grid = useMemo(() => {
    const start = week0 - (WEEKS - 1) * 7 * 86_400_000;
    return Array.from({ length: WEEKS }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => {
        const t = new Date(start);
        t.setDate(t.getDate() + w * 7 + d);
        const key = dayKey(t);
        return { key, min: byDay.get(key) ?? 0, future: t.getTime() > now, date: t };
      }),
    );
  }, [byDay, week0, now]);

  const cells = grid.flat().filter((c) => !c.future);
  const daysStudied = cells.filter((c) => c.min > 0).length;
  const bestDay = Math.max(0, ...cells.map((c) => c.min));
  const goalDays = cells.filter((c) => c.min >= settings.dailyGoalMin).length;
  const level = (m: number) => (m <= 0 ? 0 : m < STREAK_MIN ? 1 : m < settings.dailyGoalMin / 2 ? 2 : m < settings.dailyGoalMin ? 3 : 4);
  const recent = [...sessions].sort((a, b) => b.start - a.start).slice(0, 12);
  const ratingTrend = [...rated].sort((a, b) => a.start - b.start).slice(-20);
  const weekDelta = weekMin - lastWeekMin;

  return (
    <div className="stats screen-enter">
      <header className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back to home">
          <IconBack />
          <span>Home</span>
        </button>
        <h1 className="stats-title">Your stats</h1>
        <span style={{ width: 80 }} />
      </header>

      {sessions.length === 0 ? (
        <div className="empty">
          <Plant stage={0} size={120} />
          <h2>Nothing here yet</h2>
          <p>Finish your first session and your hours, streak and plant will show up here.</p>
          <button className="big-btn" onClick={onBack}>Start a session</button>
        </div>
      ) : (
        <main className="stats-main">
          <section className="tiles">
            <div className="tile">
              <span className="tile-label">This week</span>
              <b>{fmtDur(weekMin * MIN)}</b>
              <small className={weekDelta >= 0 ? "up" : "down"}>
                {lastWeekMin > 0 ? `${weekDelta >= 0 ? "▲" : "▼"} ${fmtDur(Math.abs(weekDelta) * MIN)} vs last week` : "First week, nice"}
              </small>
            </div>
            <div className="tile">
              <span className="tile-label">Streak</span>
              <b>{st.days} {st.days === 1 ? "day" : "days"}</b>
              <small>Best {best} {best === 1 ? "day" : "days"}</small>
            </div>
            <div className="tile">
              <span className="tile-label">All time</span>
              <b>{fmtDur(hours * 60 * MIN)}</b>
              <small>{sessions.length} {sessions.length === 1 ? "session" : "sessions"}</small>
            </div>
            <div className="tile">
              <span className="tile-label">Avg focus</span>
              <b>{avgRating ? avgRating.toFixed(1) : "–"}<span className="of"> / 5</span></b>
              <small>{rated.length} rated</small>
            </div>
          </section>

          <section className="panel">
            <h2>Every day you studied</h2>
            <div className="cal-row">
            <div className="cal-wrap">
              <div className="cal">
                <div className="cal-days">{dayNames.map((d, i) => <span key={i}>{d}</span>)}</div>
                {grid.map((week, w) => (
                  <div className="cal-week" key={w}>
                    {week.map((c) => (
                      <span
                        key={c.key}
                        className={`cal-cell l${c.future ? "x" : level(c.min)} ${c.key === dayKey(now) ? "today" : ""}`}
                        title={c.future ? "" : `${c.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}: ${fmtDur(c.min * MIN)}`}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <dl className="cal-facts">
              <div><dt>Days studied</dt><dd>{daysStudied} <small>of last {WEEKS * 7}</small></dd></div>
              <div><dt>Best day</dt><dd>{fmtDur(bestDay * MIN)}</dd></div>
              <div><dt>Goal hit</dt><dd>{goalDays} <small>{goalDays === 1 ? "day" : "days"}</small></dd></div>
            </dl>
            </div>
            <div className="legend">
              <span>Less</span>
              {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`cal-cell l${l}`} />)}
              <span>Goal hit</span>
            </div>
          </section>

          <div className="two-col">
            <section className="panel">
              <h2>Subjects this week</h2>
              {subjects.length === 0 ? (
                <p className="muted">No sessions yet this week.</p>
              ) : (
                <ul className="bars">
                  {subjects.map(([name, m]) => (
                    <li key={name} style={{ "--hue": subjectHue(name) } as React.CSSProperties}>
                      <span className="bar-name">{name}</span>
                      <span className="bar-track"><span style={{ width: `${(m / maxSubject) * 100}%` }} /></span>
                      <span className="bar-val">{fmtDur(m * MIN)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel plant-panel">
              <h2>Your plant</h2>
              <Plant stage={stage} size={120} />
              <p>
                <b>Stage {stage} of 12.</b>{" "}
                {stage >= 12 ? "Fully grown. Legend." : `Grows a stage for every hour you focus. ${Math.ceil((stage + 1 - hours) * 60)} min to the next one.`}
              </p>
            </section>
          </div>

          {ratingTrend.length >= 2 && (
            <section className="panel">
              <h2>How focused you felt</h2>
              <RatingChart sessions={ratingTrend} />
            </section>
          )}

          <section className="panel">
            <h2>Recent sessions</h2>
            <ul className="session-list">
              {recent.map((s) => (
                <li key={s.id} style={{ "--hue": subjectHue(s.subject) } as React.CSSProperties}>
                  <span className="chip-dot" />
                  <span className="sl-main">
                    <b>{s.subject}</b>
                    {s.goal && <span className="muted"> · {s.goal}</span>}
                    <small>{new Date(s.start).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</small>
                  </span>
                  <span className="sl-rating">{s.rating ? "●".repeat(s.rating) + "○".repeat(5 - s.rating) : ""}</span>
                  <span className="sl-dur">{fmtDur(s.focusMs)}</span>
                  {confirmId === s.id ? (
                    <button className="ghost-btn danger" onClick={() => { onDelete(s.id); setConfirmId(null); }}>Delete?</button>
                  ) : (
                    <button className="icon-btn small" aria-label="Delete session" onClick={() => setConfirmId(s.id)}><IconTrash /></button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </main>
      )}
    </div>
  );
}

function RatingChart({ sessions }: { sessions: Session[] }) {
  const w = 640, h = 140, pad = { l: 28, r: 10, t: 10, b: 20 };
  const x = (i: number) => pad.l + (i / Math.max(1, sessions.length - 1)) * (w - pad.l - pad.r);
  const y = (r: number) => pad.t + ((5 - r) / 4) * (h - pad.t - pad.b);
  const pts = sessions.map((s, i) => [x(i), y(s.rating ?? 3)] as const);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0]},${h - pad.b} L${pts[0][0]},${h - pad.b} Z`;
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} className="rating-chart" role="img" aria-label="Focus rating per session">
        {[1, 2, 3, 4, 5].map((r) => (
          <g key={r}>
            <line x1={pad.l} x2={w - pad.r} y1={y(r)} y2={y(r)} className="grid" />
            <text x={pad.l - 10} y={y(r) + 4} className="axis" textAnchor="end">{r}</text>
          </g>
        ))}
        <path d={area} className="area" />
        <path d={line} className="line" />
        {pts.map(([px, py], i) => (
          <circle key={i} cx={px} cy={py} r={i === pts.length - 1 ? 5 : 3} className={i === pts.length - 1 ? "pt last" : "pt"} />
        ))}
        <text x={pad.l} y={h - 4} className="axis">Older</text>
        <text x={w - pad.r} y={h - 4} className="axis" textAnchor="end">Latest</text>
      </svg>
    </div>
  );
}
