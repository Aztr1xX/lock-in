import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, Settings } from "../lib/store";
import { fmtDur, MIN } from "../lib/timer";
import { plantStage, streak, todayMinutes, totalHours } from "../lib/stats";
import { goalPlaceholders, greeting, subjectHue } from "../lib/content";
import Ring from "./Ring";
import type { Helpers } from "../lib/bridge";
import Plant from "./Plant";
import { IconChart, IconGear, IconFlame, IconPlus } from "./Icons";

interface Props {
  settings: Settings;
  sessions: Session[];
  now: number;
  liveFocusMin: number;
  onStart: (subject: string, goal: string) => void;
  onStats: () => void;
  onSettings: () => void;
  onSetup: () => void;
  helpers: Helpers;
  updateSettings: (p: Partial<Settings>) => void;
}

export default function Home({ settings, sessions, now, onStart, onStats, onSettings, onSetup, helpers, updateSettings }: Props) {
  const [subject, setSubject] = useState(settings.lastSubject || "General");
  const [goal, setGoal] = useState("");
  const [adding, setAdding] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [pressed, setPressed] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);

  const today = todayMinutes(sessions, now);
  const goalMin = settings.dailyGoalMin;
  const progress = Math.min(1, today / goalMin);
  const st = streak(sessions, 0, now);
  const hours = totalHours(sessions);
  const stage = plantStage(hours);
  const toNext = stage >= 12 ? 0 : (stage + 1 - hours) * 60;
  const placeholder = useMemo(() => goalPlaceholders[Math.floor(Math.random() * goalPlaceholders.length)], []);

  const exam = useMemo(() => {
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    return settings.exams
      .map((e) => ({ ...e, days: Math.round((new Date(e.date + "T00:00").getTime() - todayStart.getTime()) / 86_400_000) }))
      .filter((e) => e.days >= 0)
      .sort((a, b) => a.days - b.days)[0];
  }, [settings.exams, now]);

  const subjects = useMemo(() => {
    const list = ["General", ...settings.subjects.filter((s) => s !== "General")];
    return list;
  }, [settings.subjects]);

  useEffect(() => {
    if (adding) addRef.current?.focus();
  }, [adding]);

  const go = () => {
    setPressed(true);
    // Let the press animation land before the screen swaps.
    setTimeout(() => onStart(subject, goal), 260);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.code === "Space" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "BUTTON") {
        e.preventDefault();
        go();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const addSubject = () => {
    const name = newSubject.trim().slice(0, 24);
    if (name && !subjects.includes(name)) updateSettings({ subjects: [...settings.subjects, name] });
    if (name) setSubject(name);
    setNewSubject("");
    setAdding(false);
  };

  const removeSubject = (name: string) => {
    updateSettings({ subjects: settings.subjects.filter((s) => s !== name) });
    if (subject === name) setSubject("General");
  };

  const goalHit = today >= goalMin;

  return (
    <div className="home screen-enter">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Lock In
        </div>
        <nav className="topbar-actions">
          <button className="icon-btn" onClick={onStats} aria-label="Stats">
            <IconChart />
            <span>Stats</span>
          </button>
          <button className="icon-btn" onClick={onSettings} aria-label="Settings">
            <IconGear />
          </button>
        </nav>
      </header>

      <main className="home-main">
        <p className="greeting">{greeting(settings.name, new Date(now))}</p>

        <div className={`start-wrap ${pressed ? "pressed" : ""}`}>
          <Ring size={300} stroke={10} progress={progress} className="goal-ring">
            <button className="start-btn" onClick={go} aria-label={`Start studying ${subject}`}>
              <span className="start-label">Start</span>
              <span className="start-sub">{subject}</span>
            </button>
          </Ring>
          <div className="goal-caption">
            {goalHit ? (
              <span className="goal-hit">Daily goal smashed · {fmtDur(today * MIN)}</span>
            ) : (
              <>
                <b>{fmtDur(today * MIN)}</b> of {fmtDur(goalMin * MIN)} today
              </>
            )}
          </div>
        </div>

        <section className="setup" aria-label="Session setup">
          <div className="chips" role="radiogroup" aria-label="Subject">
            {subjects.map((s) => (
              <span key={s} className="chip-wrap">
                <button
                  role="radio"
                  aria-checked={s === subject}
                  className={`chip ${s === subject ? "on" : ""}`}
                  style={{ "--hue": subjectHue(s) } as React.CSSProperties}
                  onClick={() => setSubject(s)}
                  onContextMenu={(e) => {
                    if (s === "General") return;
                    e.preventDefault();
                    removeSubject(s);
                  }}
                  title={s === "General" ? undefined : "Right-click to remove"}
                >
                  <span className="chip-dot" />
                  {s}
                </button>
              </span>
            ))}
            {adding ? (
              <input
                ref={addRef}
                id="new-subject"
                className="chip chip-input"
                value={newSubject}
                placeholder="Subject name"
                maxLength={24}
                onChange={(e) => setNewSubject(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addSubject();
                  if (e.key === "Escape") setAdding(false);
                }}
                onBlur={addSubject}
              />
            ) : (
              <button className="chip chip-add" onClick={() => setAdding(true)}>
                <IconPlus /> Add subject
              </button>
            )}
          </div>

          <label className="goal-field">
            <span className="sr-only">What are you working on?</span>
            <input
              id="session-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={`What's the goal? e.g. ${placeholder}`}
              maxLength={80}
              onKeyDown={(e) => e.key === "Enter" && go()}
            />
          </label>

          <button className="mode-line" onClick={onSettings}>
            {settings.mode === "pomodoro"
              ? `Pomodoro ${settings.focusMin} / ${settings.shortMin}`
              : "Flow mode, no breaks"}
            <span className="sep">·</span>
            {settings.lockIn ? "Lock-in on" : "Lock-in off"}
            <span className="edit">Change</span>
          </button>

          <button className={`helpers ${helpers.blocker && helpers.closer ? "ok" : ""}`} onClick={onSetup}>
            {helpers.blocker ? (
              <>
                <span className="helper on"><span className="helper-dot" />Site blocker</span>
                <span className={`helper ${helpers.closer ? "on" : ""}`}><span className="helper-dot" />Game closer</span>
              </>
            ) : (
              <>
                <span className="helper"><span className="helper-dot" />Turn on blocking</span>
                <span className="helpers-time">5 min setup</span>
              </>
            )}
          </button>
        </section>
      </main>

      <footer className="home-footer">
        <div className={`stat-pill ${st.days ? "hot" : ""}`}>
          <IconFlame />
          <span>
            <b>{st.days}</b> day streak
            {!st.todayDone && st.days > 0 && <em> · study 25 min to keep it</em>}
          </span>
        </div>
        {exam && (
          <div className={`stat-pill exam ${exam.days <= 7 ? "soon" : ""}`}>
            <b>{exam.days === 0 ? "Today" : exam.days}</b>
            <span>{exam.days === 0 ? exam.name : `days to ${exam.name}`}</span>
          </div>
        )}
        <button className="plant-card" onClick={onStats} aria-label="Your plant">
          <Plant stage={stage} size={54} wilted={!st.todayDone && st.days === 0 && sessions.length > 0} />
          <span>
            <b>Stage {stage}</b>
            <small>{stage >= 12 ? "Fully grown" : `${Math.max(1, Math.ceil(toNext))} min to next leaf`}</small>
          </span>
        </button>
      </footer>
      <p className="kbd-hint">
        Press <kbd>Space</kbd> to start
      </p>
    </div>
  );
}
