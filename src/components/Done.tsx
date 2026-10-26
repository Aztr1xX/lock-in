import { useEffect, useRef, useState } from "react";
import type { Session, Settings } from "../lib/store";
import { fmtDur, MIN } from "../lib/timer";
import { plantStage, streak, todayMinutes, totalHours } from "../lib/stats";
import { confetti } from "../lib/fx";
import Plant from "./Plant";

interface Props {
  session: Session;
  saved: boolean;
  prevSessions: Session[];
  sessions: Session[];
  settings: Settings;
  onRate: (r: number) => void;
  onClose: () => void;
}

const faces = [
  { n: 1, label: "Distracted", face: "😵‍💫" },
  { n: 2, label: "Meh", face: "😕" },
  { n: 3, label: "Okay", face: "🙂" },
  { n: 4, label: "Good", face: "😤" },
  { n: 5, label: "Locked in", face: "🔥" },
];

export default function Done({ session, saved, prevSessions, sessions, settings, onRate, onClose }: Props) {
  const [rating, setRating] = useState<number | null>(null);
  const fired = useRef(false);
  const beforeStage = plantStage(totalHours(prevSessions));
  const afterStage = plantStage(totalHours(sessions));
  const grew = afterStage > beforeStage;
  const todayBefore = todayMinutes(prevSessions);
  const todayAfter = todayMinutes(sessions);
  const hitGoal = saved && todayBefore < settings.dailyGoalMin && todayAfter >= settings.dailyGoalMin;
  const st = streak(sessions);
  const stBefore = streak(prevSessions);
  const streakUp = saved && st.days > stBefore.days;

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    if (hitGoal || grew || streakUp) setTimeout(() => confetti({ x: innerWidth / 2, y: innerHeight * 0.3 }), 350);
  }, [hitGoal, grew, streakUp]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 5) pick(n);
      if (e.key === "Enter") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const pick = (n: number) => {
    setRating(n);
    if (saved) onRate(n);
  };

  const headline = !saved
    ? "That one was too short to count."
    : session.focusMs >= 90 * MIN
      ? "Huge session."
      : session.focusMs >= 45 * MIN
        ? "Solid work."
        : "Nice, that counts.";

  return (
    <div className="done screen-enter">
      <main className="done-main">
        <p className="eyebrow">{session.subject}{session.goal ? ` · ${session.goal}` : ""}</p>
        <h1>{headline}</h1>
        <div className="done-stats">
          <div><b>{fmtDur(session.focusMs)}</b><span>focused</span></div>
          <div><b>{session.rounds}</b><span>{session.rounds === 1 ? "round" : "rounds"}</span></div>
          <div><b>{fmtDur(todayAfter * MIN)}</b><span>today</span></div>
          <div><b>{st.days}</b><span>day streak</span></div>
        </div>

        {(hitGoal || grew || streakUp) && (
          <ul className="wins">
            {hitGoal && <li>Daily goal of {fmtDur(settings.dailyGoalMin * MIN)} done</li>}
            {streakUp && <li>Streak is now {st.days} {st.days === 1 ? "day" : "days"}</li>}
            {grew && <li>Your plant reached stage {afterStage}</li>}
          </ul>
        )}

        {saved && (
          <section className="checkin">
            <h2>How focused were you?</h2>
            <div className="faces" role="radiogroup" aria-label="Focus rating">
              {faces.map((f) => (
                <button
                  key={f.n}
                  role="radio"
                  aria-checked={rating === f.n}
                  className={`face ${rating === f.n ? "on" : ""} ${rating && rating !== f.n ? "dim" : ""}`}
                  onClick={() => pick(f.n)}
                >
                  <span className="face-emoji" aria-hidden="true">{f.face}</span>
                  <span className="face-label">{f.label}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="done-plant">
          <Plant stage={afterStage} size={110} />
        </div>

        <button className="big-btn" onClick={onClose}>
          Done
        </button>
      </main>
    </div>
  );
}
