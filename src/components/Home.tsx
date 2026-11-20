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
import GardenPlant from "./GardenPlant";
import Shrubert, { useShrubMood } from "./Shrubert";
import SkyLayer from "./Sky";
import SeedJar, { jarFill } from "./SeedJar";
import { Sprite } from "./Visitors";
import { type GardenState, hoursLeft, speciesById } from "../lib/garden";
import { skyAt, skyVars } from "../lib/sky";
import { IconChart, IconGear, IconFlame, IconPlus } from "./Icons";
import { aName, lower } from "../lib/words";

interface Props {
  settings: Settings;
  sessions: Session[];
  now: number;
  liveFocusMin: number;
  onStart: (subject: string, goal: string) => void;
  onStats: () => void;
  garden: GardenState;
  onGarden: () => void;
  onPickSeed: () => void;
  onSettings: () => void;
  onSetup: () => void;
  onTest: () => void;
  onCamCheck: () => void;
  helpers: Helpers;
  updateSettings: (p: Partial<Settings>) => void;
}

export default function Home({ settings, sessions, now, onStart, onStats, garden, onGarden, onPickSeed, onSettings, onSetup, onTest, onCamCheck, helpers, updateSettings }: Props) {
  const [subject, setSubject] = useState(settings.lastSubject || "General");
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
  const cur = garden.current;
  const jar = jarFill(garden.seeds);
  const lines = useMemo(
    () => {
      const g: string[] = [];
      if (cur && !cur.species) g.push("A new seed is ready. Pick what grows next!");
      else if (cur && cur.growth < 1 && cur.species && cur.endH - hours <= 3) g.push(`${hoursLeft(cur.endH - hours)} until your ${lower(speciesById(cur.species).name)} is fully grown.`);
      if (jar.next && jar.next.seeds - garden.seeds <= 6) g.push(`${jar.next.seeds - garden.seeds} more seeds and you unlock ${lower(jar.next.name)}.`);
      const base = encouragements({
      name: settings.name, todayMin: today, goalMin, streakDays: st.days, streakSafe: st.todayDone,
      exam: exam ? { name: exam.name, days: exam.days } : undefined, hours, nextFlower: next, hour: new Date(now).getHours(),
      });
      return [base[0], ...g, ...base.slice(1)];
    },
    // Re-word only when the facts change, not on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.name, Math.round(today), goalMin, st.days, st.todayDone, exam?.name, exam?.days, Math.floor(hours * 4), cur?.species, garden.seeds],
  );
  const [lineN, setLineN] = useState(0);
  const [poke, setPoke] = useState(0);
  const [poke2, setPoke2] = useState(0);
  const sky = useMemo(() => skyAt(new Date(now)), [now]);
  const shrub = useShrubMood(sky.night);
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
          return { pct: ((hours - prev) / (next.hours - prev)) * 100, text: `${h < 1 ? `${Math.ceil(h * 60)} min` : `${Math.ceil(h)} h`} to ${next.name === "First bloom" ? "its first flower" : aName(next.name)}` };
        })()
      : { pct: 100, text: "Every flower collected" };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      // Not while a sheet or pop-up is open on top of Home.
      if (document.querySelector("[aria-modal='true']")) return;
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

            <div className="timer-edit" aria-label="Timer">
            <div className="seg mini" role="radiogroup" aria-label="Timer mode">
              <button role="radio" aria-checked={settings.mode === "pomodoro"} className={settings.mode === "pomodoro" ? "on" : ""} onClick={() => updateSettings({ mode: "pomodoro" })}>Pomodoro</button>
              <button role="radio" aria-checked={settings.mode === "flow"} className={settings.mode === "flow" ? "on" : ""} onClick={() => updateSettings({ mode: "flow" })}>Flow</button>
            </div>
            {settings.mode === "pomodoro" ? (
              <>
                <MinField label="Focus" value={settings.focusMin} min={5} max={120} step={5} onChange={(v) => updateSettings({ focusMin: v })} />
                <MinField label="Break" value={settings.shortMin} min={1} max={30} step={1} onChange={(v) => updateSettings({ shortMin: v })} />
              </>
            ) : (
              <span className="timer-note">Counts up, no breaks</span>
            )}
            <button className="link-btn" onClick={onSettings}>{settings.lockIn ? "Lock-in on" : "Lock-in off"}</button>
          </div>

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

        <aside className="garden card" aria-label="Your garden">
          <p className="speech" key={line} role="status">{line}</p>
          <div className={`garden-scene ${sky.night ? "is-night" : ""}`} style={skyVars(sky)}>
            <SkyLayer sky={sky} />
            <span className="gs-hill" />
            <span className="gs-ground" />
            <div className={`gs-plants ${cur ? "two" : ""}`}>
              <button
                className={`garden-plant ${poke % 2 ? "poke-a" : poke ? "poke-b" : ""}`}
                onClick={() => { setPoke((p) => p + 1); setLineN((n) => n + 1); }}
                aria-label="Poke your plant"
              >
                <Plant stage={stage} hours={hours} size={cur ? 150 : 200} pot={garden.pot} wilted={!st.todayDone && st.days === 0 && sessions.length > 0} />
                {garden.visitors.has("ladybug") && <span className="gs-ladybug"><Sprite id="ladybug" size={18} /></span>}
              </button>
              {cur && (
                <button
                  className={`garden-plant cur ${poke2 % 2 ? "poke-a" : poke2 ? "poke-b" : ""}`}
                  onClick={() => (cur.species ? setPoke2((p) => p + 1) : onPickSeed())}
                  aria-label={cur.species ? `Poke your ${lower(speciesById(cur.species).name)}` : "Pick a seed for your new plant"}
                >
                  <GardenPlant species={cur.species} growth={cur.growth} pot={cur.pot} size={150} />
                </button>
              )}
            </div>
            {sky.stars <= 0.4 && garden.visitors.has("bee") && <span className="gs-flyer gs-bee"><Sprite id="bee" size={24} /></span>}
            {sky.stars <= 0.4 && garden.visitors.has("butterfly") && <span className="gs-flyer gs-butterfly"><Sprite id="butterfly" size={26} /></span>}
            {sky.stars <= 0.4 && garden.visitors.has("hummingbird") && <span className="gs-flyer gs-humming"><Sprite id="hummingbird" size={30} /></span>}
            {sky.stars > 0.4 && [0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="gs-firefly" style={{ left: `${12 + i * 19}%`, top: `${38 + ((i * 37) % 30)}%`, animationDelay: `${i * 0.7}s` }}><Sprite id="firefly" size={12} /></span>
            ))}
            <button className="gs-shrub" onClick={() => (sky.night ? undefined : shrub.react("hum"))} aria-label="Shrubert" title={sky.night ? "Shrubert is asleep" : "Shrubert"}>
              <Shrubert shrub={garden.shrub} mood={shrub.mood} flash={shrub.flash} size={62} />
            </button>
            <span className="gs-time">{sky.name}</span>
            <button className="gs-jar" onClick={onGarden} title={jar.next ? `${jar.next.seeds - garden.seeds} more seeds until ${lower(jar.next.name)}` : "Every seed unlocked"}>
              <SeedJar seeds={garden.seeds} size={18} />
              <span><b>{garden.seeds}</b> seeds</span>
            </button>
          </div>
          <div className="garden-info">
            {cur && !cur.species ? (
              <>
                <b>A new seed is ready</b>
                <button className="seed-btn" onClick={onPickSeed}>Pick a seed</button>
                <small>It has already grown {Math.floor(cur.growth * 100)}% while it waited</small>
              </>
            ) : cur && cur.species ? (
              <>
                <b>{speciesById(cur.species).name} · {Math.floor(cur.growth * 100)}%</b>
                <span className="growth"><span style={{ width: `${Math.min(100, Math.max(3, cur.growth * 100))}%` }} /></span>
                <small>{cur.growth >= 1 ? "Fully grown" : `${hoursLeft(cur.endH - hours)} until it's fully grown`}</small>
              </>
            ) : (
              <>
                <b>{stage >= 12 ? (earnedFlowers.length > 1 ? `${earnedFlowers.length} flowers` : "Fully grown") : `Stage ${stage} of 12`}</b>
                <span className="growth"><span style={{ width: `${Math.min(100, Math.max(3, growth.pct))}%` }} /></span>
                <small>{growth.text}</small>
              </>
            )}
          </div>
          <div className="garden-actions">
            <button className="garden-walk" onClick={onGarden}>
              Walk in your garden
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
            </button>

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
