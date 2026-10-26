import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, Settings } from "../lib/store";
import { fmtDur, MIN } from "../lib/timer";
import { plantStage, streak, todayMinutes, totalHours } from "../lib/stats";
import { encouragements, greeting, subjectHue } from "../lib/content";
import { FLOWERS, flowersAt, nextFlower } from "../lib/flowers";
import MonthCalendar from "./MonthCalendar";
import Flower from "./Flower";
import Ring from "./Ring";
import type { Helpers } from "../lib/bridge";
import Plant from "./Plant";
import type { ToastData } from "./Toast";
import { IconChart, IconClose, IconGear, IconFlame, IconPlus } from "./Icons";

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
  onToast: (t: Omit<ToastData, "id">) => void;
  /** Shown above the greeting when the blocker kept a copy of history this browser lost. */
  restore?: { count: number; savedAt: number; onRestore: () => void; onDismiss: () => void } | null;
}

export default function Home({ settings, sessions, now, onStart, onStats, onSettings, onSetup, onTest, onCamCheck, helpers, updateSettings, onToast, restore }: Props) {
  const [subject, setSubject] = useState(settings.lastSubject || "General");
  const [adding, setAdding] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [pressed, setPressed] = useState(false);
  const [panel, setPanel] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);

  const today = todayMinutes(sessions, now);
  const goalMin = settings.dailyGoalMin;
  const progress = Math.min(1, today / goalMin);
  const st = streak(sessions, 0, now);
  const hours = totalHours(sessions);
  const stage = plantStage(hours);
  const toNext = stage >= 12 ? 0 : (stage + 1 - hours) * 60;

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
    setTimeout(() => onStart(subject, ""), 320);
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
      if (e.code === "Space" && !panel && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "BUTTON") {
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

  // Removing is one click, so it always comes with an Undo.
  const removeSubject = (name: string) => {
    const before = settings.subjects;
    const wasPicked = subject === name;
    updateSettings({ subjects: before.filter((s) => s !== name) });
    if (wasPicked) setSubject("General");
    onToast({
      icon: "🗑️",
      text: `Removed ${name}. Your past sessions keep their hours.`,
      action: {
        label: "Undo",
        run: () => {
          updateSettings({ subjects: before });
          if (wasPicked) setSubject(name);
        },
      },
    });
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
          {restore && (
            <div className="restore-banner" role="status">
              <span>
                <b>Your history isn't in this browser any more.</b>
                The blocker kept a copy: {restore.count} {restore.count === 1 ? "session" : "sessions"}, saved {new Date(restore.savedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}.
              </span>
              <span className="restore-btns">
                <button className="big-btn small" onClick={restore.onRestore}>Bring it back</button>
                <button className="link-btn" onClick={restore.onDismiss}>Not now</button>
              </span>
            </div>
          )}
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
                <span key={s} className={`chip-wrap ${s === "General" ? "" : "removable"}`}>
                  <button
                    role="radio"
                    aria-checked={s === subject}
                    className={`chip ${s === subject ? "on" : ""}`}
                    style={{ "--hue": subjectHue(s) } as React.CSSProperties}
                    onClick={() => setSubject(s)}
                    onKeyDown={(e) => {
                      if (s !== "General" && (e.key === "Delete" || e.key === "Backspace")) removeSubject(s);
                    }}
                  >
                    <span className="chip-dot" />
                    {s}
                  </button>
                  {s !== "General" && (
                    <button className="chip-x" aria-label={`Remove ${s}`} title={`Remove ${s}`} onClick={() => removeSubject(s)}>
                      <IconClose />
                    </button>
                  )}
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

            <SessionLine
              settings={settings}
              helpers={helpers}
              open={panel}
              setOpen={setPanel}
              updateSettings={updateSettings}
              onSettings={onSettings}
              onSetup={onSetup}
              onTest={onTest}
              onCamCheck={onCamCheck}
            />
          </section>
        </main>

        <aside className="garden card" aria-label="Your plant">
          <p className="speech" key={line} role="status">{line}</p>
          <button
            className={`garden-plant ${poke % 2 ? "poke-a" : poke ? "poke-b" : ""}`}
            onClick={() => { setPoke((p) => p + 1); setLineN((n) => n + 1); }}
            aria-label="Poke your plant"
          >
            <Plant stage={stage} hours={hours} size={210} wilted={!st.todayDone && st.days === 0 && sessions.length > 0} />
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

/** A minutes box you can type into or nudge with the arrows. */
function MinField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (raw: string) => {
    const n = Math.round(Number(raw));
    if (Number.isFinite(n) && n > 0) onChange(Math.max(min, Math.min(max, n)));
    else setText(String(value));
  };
  return (
    <div className="min-field">
      <span className="min-label">{label}</span>
      <button aria-label={`Less ${label.toLowerCase()} time`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <input
        id={`home-${label.toLowerCase()}`}
        inputMode="numeric"
        aria-label={`${label} minutes`}
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp") { e.preventDefault(); onChange(Math.min(max, value + step)); }
          if (e.key === "ArrowDown") { e.preventDefault(); onChange(Math.max(min, value - step)); }
        }}
      />
      <span className="min-unit">min</span>
      <button aria-label={`More ${label.toLowerCase()} time`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>+</button>
    </div>
  );
}

/** One tidy line under Start that sums up the session. Click it to change any of it. */
function SessionLine({ settings, helpers, open, setOpen, updateSettings, onSettings, onSetup, onTest, onCamCheck }: {
  settings: Settings; helpers: Helpers; open: boolean; setOpen: (v: boolean) => void; updateSettings: (p: Partial<Settings>) => void;
  onSettings: () => void; onSetup: () => void; onTest: () => void; onCamCheck: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", away); removeEventListener("keydown", esc); };
  }, [open, setOpen]);
  const go = (fn: () => void) => () => { setOpen(false); fn(); };
  const pomodoro = settings.mode === "pomodoro";
  const blocking = helpers.blocker && helpers.closer;
  return (
    <div className="session-line" ref={box}>
      <button className={`session-pill ${open ? "open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="session-panel">
        <span className="sp-what">
          {pomodoro ? <><b>{settings.focusMin}</b><i>/</i><b>{settings.shortMin}</b> min</> : <b>Flow</b>}
        </span>
        <span className="sp-sep" aria-hidden="true" />
        <span className={`sp-flag ${settings.lockIn ? "on" : ""}`} title={settings.lockIn ? "Lock-in on" : "Lock-in off"}>Lock-in</span>
        <span className={`sp-flag ${settings.camera ? "on" : ""}`} title={settings.camera ? "Camera coach on" : "Camera coach off"}>Camera</span>
        <span className={`sp-flag ${blocking ? "on" : helpers.blocker ? "half" : ""}`} title={blocking ? "Site blocker and game closer on" : helpers.blocker ? "Site blocker on, game closer off" : "Blocking isn't set up"}>Blocking</span>
        <svg className="sp-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
      </button>
      {open && (
        <div className="session-panel card" id="session-panel" role="dialog" aria-label="Session options">
          <div className="seg mini" role="radiogroup" aria-label="Timer mode">
            <button role="radio" aria-checked={pomodoro} className={pomodoro ? "on" : ""} onClick={() => updateSettings({ mode: "pomodoro" })}>Pomodoro</button>
            <button role="radio" aria-checked={!pomodoro} className={!pomodoro ? "on" : ""} onClick={() => updateSettings({ mode: "flow" })}>Flow</button>
          </div>
          {pomodoro ? (
            <div className="sp-fields">
              <MinField label="Focus" value={settings.focusMin} min={5} max={120} step={5} onChange={(v) => updateSettings({ focusMin: v })} />
              <MinField label="Break" value={settings.shortMin} min={1} max={30} step={1} onChange={(v) => updateSettings({ shortMin: v })} />
            </div>
          ) : (
            <p className="timer-note">Counts up with no breaks. End it when you're done.</p>
          )}
          <label className="toggle-row sp-row">
            <span>Lock-in<small>Wait {settings.lockInSec} s before you can end early</small></span>
            <input id="home-lockin" type="checkbox" className="toggle" checked={settings.lockIn} onChange={(e) => updateSettings({ lockIn: e.target.checked })} />
          </label>
          <label className="toggle-row sp-row">
            <span>Camera coach<small>Pauses when you leave, nudges you off your phone</small></span>
            <input id="home-camera" type="checkbox" className="toggle" checked={settings.camera} onChange={(e) => updateSettings({ camera: e.target.checked })} />
          </label>
          <button className="sp-row sp-helpers" onClick={go(onSetup)}>
            <span className={`helper ${helpers.blocker ? "on" : ""}`}><span className="helper-dot" />Site blocker</span>
            <span className={`helper ${helpers.closer ? "on" : ""}`}><span className="helper-dot" />Game closer</span>
            <span className="sp-go">{blocking ? "Details" : "Set up"} ›</span>
          </button>
          <div className="home-links">
            <button className="link-btn" onClick={go(onCamCheck)}>See what the camera sees</button>
            <span className="sep" aria-hidden="true">·</span>
            <button className="link-btn" onClick={go(onTest)} title="1 minute focus, 30 second break, nothing saved">Test session</button>
            <span className="sep" aria-hidden="true">·</span>
            <button className="link-btn" onClick={go(onSettings)}>All settings</button>
          </div>
        </div>
      )}
    </div>
  );
}
