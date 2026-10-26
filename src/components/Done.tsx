import { useEffect, useRef, useState } from "react";
import type { Session, Settings } from "../lib/store";
import { fmtDur, MIN } from "../lib/timer";
import { plantStage, streak, todayMinutes, totalHours } from "../lib/stats";
import { chime, confetti } from "../lib/fx";
import Plant from "./Plant";
import FocusStrip from "./FocusStrip";
import Timelapse from "./Timelapse";
import { BADGES, earned } from "../lib/badges";
import { flowersAt } from "../lib/flowers";
import Flower from "./Flower";

interface Props {
  session: Session;
  saved: boolean;
  test?: boolean;
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

export default function Done({ session, saved, test = false, prevSessions, sessions, settings, onRate, onClose }: Props) {
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
  const had = earned(prevSessions, settings);
  const now = earned(sessions, settings);
  const newBadges = BADGES.filter((b) => now.has(b.id) && !had.has(b.id));
  const hoursAfter = totalHours(sessions);
  const hadFlowers = flowersAt(totalHours(prevSessions)).length;
  const newFlowers = flowersAt(hoursAfter).slice(hadFlowers);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    if ((newFlowers.length || newBadges.length) && settings.sound) setTimeout(chime.sparkle, 900);
    if (hitGoal || grew || streakUp || newBadges.length || newFlowers.length) setTimeout(() => confetti({ x: innerWidth / 2, y: innerHeight * 0.3 }), 350);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const headline = test
    ? "Test run done. Nothing was saved."
    : !saved
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

        {(saved || test) && (session.trace?.length || session.frames) ? (
          <section className="cam-recap">
            {!!session.frames && <Timelapse sessionId={session.id} durationMs={session.end - session.start} />}
            {!!session.trace?.length && <FocusStrip trace={session.trace} />}
            {session.counts && (
              <p className="recap-counts">
                <span>📵 {session.counts.phone} phone {session.counts.phone === 1 ? "pickup" : "pickups"}</span>
                <span>🪑 {session.counts.posture} posture {session.counts.posture === 1 ? "nudge" : "nudges"}</span>
                <span>👋 stepped away {session.counts.away}×</span>
              </p>
            )}
          </section>
        ) : null}

        {(hitGoal || grew || streakUp) && (
          <ul className="wins">
            {hitGoal && <li>Daily goal of {fmtDur(settings.dailyGoalMin * MIN)} done</li>}
            {streakUp && <li>Streak is now {st.days} {st.days === 1 ? "day" : "days"}</li>}
            {grew && <li>Your plant reached stage {afterStage}</li>}
          </ul>
        )}

        {newFlowers.map((f, i) => (
          <div className="flower-unlock" key={f.kind} style={{ animationDelay: `${0.3 + i * 0.2}s` }}>
            <Flower kind={f.kind} size={72} />
            <span><small>New flower</small><b>{f.name}</b><em>{f.line}</em></span>
          </div>
        ))}

        {newBadges.length > 0 && (
          <div className="new-badges">
            {newBadges.map((b, i) => (
              <div className="badge new" key={b.id} style={{ animationDelay: `${0.4 + i * 0.15}s` }}>
                <span className="badge-icon">{b.icon}</span>
                <span><small>Badge unlocked</small><b>{b.name}</b></span>
              </div>
            ))}
          </div>
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
          <Plant stage={afterStage} hours={hoursAfter} size={130} />
        </div>

        <button className="big-btn" onClick={onClose}>
          Done
        </button>
      </main>
    </div>
  );
}
