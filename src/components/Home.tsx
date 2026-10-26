import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, Settings } from "../lib/store";
import { fmtDur, MIN } from "../lib/timer";
import { plantStage, streak, todayMinutes, totalHours } from "../lib/stats";
import { encouragements, goalPlaceholders, greeting, subjectHue } from "../lib/content";
import { FLOWERS, flowersAt, nextFlower } from "../lib/flowers";
import MonthCalendar from "./MonthCalendar";
import Flower from "./Flower";
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
  onTest: () => void;
  onCamCheck: () => void;
  helpers: Helpers;
  updateSettings: (p: Partial<Settings>) => void;
}

export default function Home({ settings, sessions, now, onStart, onStats, onSettings, onSetup, onTest, onCamCheck, helpers, updateSettings }: Props) {
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
    if (pressed) return;
    setPressed(true);
    // Let the press animation land before the screen swaps.
    setTimeout(() => onStart(subject, goal), 320);
  };

  // The plant's speech bubble: what's going on today, plus a bit of pep. Changes every 9 s.
  const next = nextFlower(hours);
  const lines = useMemo(
    () => encouragements({
      name: settings.name, todayMin: today, goalMin, streakDays: st.days, streakSafe: st.todayDone,
      exam: exam ? { name: exam.name, days: exam.days } : undefined, hours, nextFlower: next, hour: new Date(now).getHours(),
    }),
    // Re-word only when the facts change, not on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.name, Math.round(today), goalMin, st.days, st.todayDone, exam?.name, exam?.days, Math.floor(hours * 4)],
  );
  const [lineN, setLineN] = useState(0);
  const [poke, setPoke] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setLineN((n) => n + 1), 9000);
    return () => clearInterval(id);
  }, [lineN]);
  const line = lines[lineN % lines.length];
  const earnedFlowers = flowersAt(hours);
  const growth = stage < 12
    ? { pct: (hours - stage) * 100, text: `${Math.max(1, Math.ceil(toNext))} min to the next leaf` }
    : next
      ? (() => {
          const prev = earnedFlowers.length ? earnedFlowers[earnedFlowers.length - 1].hours : 12;
          const h = next.hours - hours;
          return { pct: ((hours - prev) / (next.hours - prev)) * 100, text: `${h < 1 ? `${Math.ceil(h * 60)} min` : `${Math.ceil(h)} h`} to ${next.name === "First bloom" ? "its first flower" : `a ${next.name.toLowerCase()}`}` };
        })()
      : { pct: 100, text: "Every flower collected" };

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

      <div className="home-grid">
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

            <div className="helper-row">
            <button className={`helpers ${settings.camera ? "ok" : ""}`} onClick={onSettings} title="Camera coach settings">
              <span className={`helper ${settings.camera ? "on" : ""}`}>
                <span className="helper-dot" />
                {settings.camera ? "Camera coach on" : "Camera coach off"}
              </span>
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
            </div>
            <div className="home-links">
              <button className="link-btn" onClick={onCamCheck}>See what the camera sees</button>
              <span className="sep" aria-hidden="true">·</span>
              <button className="link-btn" onClick={onTest} title="1 minute focus, 30 second break, nothing saved">Test session</button>
            </div>
          </section>
        </main>

        <aside className="garden card" aria-label="Your plant">
          <p className="speech" key={line} role="status">{line}</p>
          <button
            className={`garden-plant ${poke % 2 ? "poke-a" : poke ? "poke-b" : ""}`}
            onClick={() => { setPoke((p) => p + 1); setLineN((n) => n + 1); }}
            aria-label="Poke your plant"
          >
            <Plant stage={stage} hours={hours} size={230} wilted={!st.todayDone && st.days === 0 && sessions.length > 0} />
          </button>
          <div className="garden-info">
            <b>{stage >= 12 ? (earnedFlowers.length > 1 ? `${earnedFlowers.length} flowers` : "Fully grown") : `Stage ${stage} of 12`}</b>
            <span className="growth"><span style={{ width: `${Math.min(100, Math.max(3, growth.pct))}%` }} /></span>
            <small>{growth.text}</small>
          </div>
          <button className="flower-shelf" onClick={onStats} aria-label="Your flower collection">
            {FLOWERS.map((f) => (
              <span key={f.kind} title={hours >= f.hours ? `${f.name} · earned at ${f.hours} h` : `${f.name} · unlocks at ${f.hours} h`}>
                <Flower kind={f.kind} size={24} locked={hours < f.hours} />
              </span>
            ))}
          </button>
        </aside>

        <aside className="home-side">
          <MonthCalendar sessions={sessions} exams={settings.exams} goalMin={goalMin} now={now} />
          <div className="side-pills">
            <div className={`stat-pill ${st.days ? "hot" : ""}`}>
              <IconFlame />
              <span>
                <b>{st.days}</b> day streak
                {!st.todayDone && st.days > 0 && <em> · 25 min keeps it</em>}
              </span>
            </div>
            {exam && (
              <div className={`stat-pill exam ${exam.days <= 7 ? "soon" : ""}`}>
                <b>{exam.days === 0 ? "Today" : exam.days}</b>
                <span>{exam.days === 0 ? exam.name : `days to ${exam.name}`}</span>
              </div>
            )}
          </div>
        </aside>
      </div>

      <p className="kbd-hint">
        Press <kbd>Space</kbd> to start
      </p>
    </div>
  );
}
