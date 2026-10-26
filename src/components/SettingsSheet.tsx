import { useEffect, useState } from "react";
import type { Settings } from "../lib/store";
import { uid } from "../lib/store";
import { fmtDur, MIN } from "../lib/timer";
import { IconClose, IconTrash } from "./Icons";

interface Props {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  onClose: () => void;
}

function Stepper({ id, value, min, max, step, unit, onChange }: { id: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div className="stepper" id={id}>
      <button aria-label="Less" onClick={() => onChange(Math.max(min, value - step))} disabled={value <= min}>−</button>
      <span>{value}<small>{unit}</small></span>
      <button aria-label="More" onClick={() => onChange(Math.min(max, value + step))} disabled={value >= max}>+</button>
    </div>
  );
}

export default function SettingsSheet({ settings: s, update, onClose }: Props) {
  const [examName, setExamName] = useState("");
  const [examDate, setExamDate] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const addExam = () => {
    if (!examName.trim() || !examDate) return;
    update({ exams: [...s.exams, { id: uid(), name: examName.trim(), date: examDate }] });
    setExamName("");
    setExamDate("");
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings"><IconClose /></button>
        </header>

        <section className="set-group">
          <h3>Timer</h3>
          <div className="seg" role="radiogroup" aria-label="Timer mode">
            <button role="radio" aria-checked={s.mode === "pomodoro"} className={s.mode === "pomodoro" ? "on" : ""} onClick={() => update({ mode: "pomodoro" })}>
              Pomodoro<small>Focus, break, repeat</small>
            </button>
            <button role="radio" aria-checked={s.mode === "flow"} className={s.mode === "flow" ? "on" : ""} onClick={() => update({ mode: "flow" })}>
              Flow<small>Count up, no breaks</small>
            </button>
          </div>
          {s.mode === "pomodoro" && (
            <>
              <div className="set-row"><span>Focus</span><Stepper id="focus-min" value={s.focusMin} min={5} max={90} step={5} unit="min" onChange={(v) => update({ focusMin: v })} /></div>
              <div className="set-row"><span>Short break</span><Stepper id="short-min" value={s.shortMin} min={1} max={20} step={1} unit="min" onChange={(v) => update({ shortMin: v })} /></div>
              <div className="set-row"><span>Long break</span><Stepper id="long-min" value={s.longMin} min={5} max={45} step={5} unit="min" onChange={(v) => update({ longMin: v })} /></div>
              <div className="set-row"><span>Long break every</span><Stepper id="rounds" value={s.roundsBeforeLong} min={2} max={8} step={1} unit="rounds" onChange={(v) => update({ roundsBeforeLong: v })} /></div>
              <div className="presets">
                {[[25, 5], [50, 10], [90, 15]].map(([f, b]) => (
                  <button key={f} className={`chip ${s.focusMin === f && s.shortMin === b ? "on" : ""}`} onClick={() => update({ focusMin: f, shortMin: b })}>
                    {f} / {b}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="set-group">
          <h3>Lock-in mode</h3>
          <label className="toggle-row">
            <span>
              Make me wait before ending early
              <small>You'll have to wait {s.lockInSec} seconds before you can end a session.</small>
            </span>
            <input id="lockin-toggle" type="checkbox" className="toggle" checked={s.lockIn} onChange={(e) => update({ lockIn: e.target.checked })} />
          </label>
          {s.lockIn && (
            <div className="set-row"><span>Wait time</span><Stepper id="lockin-sec" value={s.lockInSec} min={10} max={120} step={10} unit="s" onChange={(v) => update({ lockInSec: v })} /></div>
          )}
        </section>

        <section className="set-group">
          <h3>Camera</h3>
          <label className="toggle-row">
            <span>
              Use the camera during sessions
              <small>Everything is worked out inside this browser. No video or photos ever leave this PC.</small>
            </span>
            <input id="camera-toggle" type="checkbox" className="toggle" checked={s.camera} onChange={(e) => update({ camera: e.target.checked })} />
          </label>
          {s.camera && (
            <div className="cam-opts">
              {([
                ["timelapse", "Time-lapse", "A photo every 10 seconds, played back as a short video"],
                ["away", "Pause when I leave", "Stops the timer if you're gone for a minute, restarts when you're back"],
                ["phone", "Phone nudge", "A gentle nudge if you pick up your phone"],
                ["posture", "Posture reminder", "Only after a few minutes of hunching. Looking down at your iPad is fine"],
                ["drowsy", "Tired alert", "Suggests a break if you keep yawning or your eyes keep closing"],
              ] as const).map(([k, title, sub]) => (
                <label className="toggle-row" key={k}>
                  <span>{title}<small>{sub}</small></span>
                  <input id={`cam-${k}`} type="checkbox" className="toggle" checked={s.cam[k]} onChange={(e) => update({ cam: { ...s.cam, [k]: e.target.checked } })} />
                </label>
              ))}
            </div>
          )}
        </section>

        <section className="set-group">
          <h3>Daily goal</h3>
          <div className="set-row"><span>Study each day</span><Stepper id="daily-goal" value={s.dailyGoalMin} min={15} max={600} step={15} unit="min" onChange={(v) => update({ dailyGoalMin: v })} /></div>
          <p className="hint">That's {fmtDur(s.dailyGoalMin * MIN)}. Your streak only needs 25 minutes a day.</p>
        </section>

        <section className="set-group">
          <h3>Exams</h3>
          {s.exams.length > 0 && (
            <ul className="exam-list">
              {[...s.exams].sort((a, b) => a.date.localeCompare(b.date)).map((e) => (
                <li key={e.id}>
                  <span><b>{e.name}</b><small>{new Date(e.date + "T00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</small></span>
                  <button className="icon-btn small" aria-label={`Remove ${e.name}`} onClick={() => update({ exams: s.exams.filter((x) => x.id !== e.id) })}><IconTrash /></button>
                </li>
              ))}
            </ul>
          )}
          <div className="exam-add">
            <input id="exam-name" placeholder="Exam name, e.g. Biology" value={examName} onChange={(e) => setExamName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addExam()} />
            <input id="exam-date" type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} />
            <button className="ghost-btn" onClick={addExam} disabled={!examName.trim() || !examDate}>Add</button>
          </div>
        </section>

        <section className="set-group">
          <h3>You</h3>
          <label className="text-row">
            <span>Your name</span>
            <input id="your-name" value={s.name} maxLength={20} placeholder="For the greeting" onChange={(e) => update({ name: e.target.value })} />
          </label>
          <label className="toggle-row">
            <span>Sounds<small>A soft chime when breaks start and end.</small></span>
            <input id="sound-toggle" type="checkbox" className="toggle" checked={s.sound} onChange={(e) => update({ sound: e.target.checked })} />
          </label>
        </section>

        <p className="privacy">Everything you do here is saved in this browser on this PC. Nothing is uploaded.</p>
      </aside>
    </div>
  );
}
