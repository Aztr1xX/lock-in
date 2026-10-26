import { useEffect, useRef, useState } from "react";
import type { CamStatus } from "../lib/camera";
import type { Active, Session, Settings } from "../lib/store";
import { fmtClock, fmtDur, focusMs, MIN, phaseElapsed } from "../lib/timer";
import { breakIdeas, lockInLines } from "../lib/content";
import { todayMinutes } from "../lib/stats";
import Ring from "./Ring";
import { IconLock, IconPause, IconPlay, IconSkip, IconStop } from "./Icons";

interface Props {
  active: Active;
  settings: Settings;
  now: number;
  sessions: Session[];
  onPause: () => void;
  onResume: () => void;
  onSkipBreak: () => void;
  onFinish: () => void;
  camStatus: CamStatus;
  camVideo: HTMLVideoElement | null;
  onCamCheck: () => void;
}

export default function Focus({ active, settings, now, sessions, onPause, onResume, onSkipBreak, onFinish, camStatus, camVideo, onCamCheck }: Props) {
  const [ending, setEnding] = useState(false);
  const [ideaShift, setIdeaShift] = useState(0);
  const onBreak = active.phase !== "focus";
  const paused = !!active.pausedAt;
  // The ring and clock follow every animation frame so they glide instead of stepping.
  const [frameNow, setFrameNow] = useState(now);
  useEffect(() => {
    if (paused) return;
    let raf = 0;
    const loop = () => {
      setFrameNow(Date.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paused]);
  const t = paused ? now : Math.max(now, frameNow);
  const el = phaseElapsed(active, t);
  const pomodoro = active.mode === "pomodoro";
  const left = pomodoro ? active.phaseDurMs - el : el;
  const progress = pomodoro ? el / active.phaseDurMs : (el % (60 * MIN)) / (60 * MIN);
  const focused = focusMs(active, t);
  const todayTotal = todayMinutes(sessions, now) + focused / MIN;
  const goalPct = Math.min(100, (todayTotal / settings.dailyGoalMin) * 100);
  const idea = breakIdeas[(active.breakIdea + ideaShift) % breakIdeas.length];
  const roundInSet = (active.rounds % settings.roundsBeforeLong) + (onBreak ? 0 : 1);
  const nextBreakLong = (active.rounds + 1) % settings.roundsBeforeLong === 0;

  useEffect(() => setIdeaShift(0), [active.phase, active.rounds]);

  const requestEnd = () => {
    if (settings.lockIn && !onBreak && focused >= (active.test ? 5000 : MIN)) setEnding(true);
    else onFinish();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ending) return;
      if (e.code === "Space") {
        e.preventDefault();
        (paused ? onResume : onPause)();
      }
      if (e.code === "Escape") requestEnd();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const label = onBreak
    ? active.phase === "long" ? "Long break" : "Break"
    : pomodoro ? `Focus · round ${roundInSet} of ${settings.roundsBeforeLong}` : "Flow";

  return (
    <div className={`focus screen-enter ${onBreak ? "is-break" : ""} ${paused ? "is-paused" : ""}`}>
      <div className="focus-glow" aria-hidden="true" />
      <header className="focus-top">
        <div className="focus-subject">
          <span className="live-dot" aria-hidden="true" />
          {active.subject}
          {active.goal && <span className="focus-goal">{active.goal}</span>}
        </div>
        <div className="focus-badges">
          {settings.camera && <CamBubble status={camStatus} video={camVideo} showSelf={settings.showSelf} onToggle={onCamCheck} />}
          {active.test && <div className="test-badge" title="Short timers, nothing gets saved">Test run</div>}
          {settings.lockIn && (
            <div className="lock-badge" title="Lock-in mode is on">
              <IconLock /> Locked in
            </div>
          )}
        </div>
      </header>

      <main className="focus-main">
        <p className="phase-label" key={label}>{paused ? (active.autoPaused ? "Paused · you stepped away" : "Paused") : label}</p>
        <Ring size={340} stroke={8} progress={progress} ticks={60} className="focus-ring">
          <div className="clock" aria-live="off">{fmtClock(left)}</div>
          <div className="clock-sub">
            {pomodoro
              ? onBreak
                ? "back to it after this"
                : `then a ${nextBreakLong ? settings.longMin : settings.shortMin} min break`
              : `${fmtDur(focused)} focused`}
          </div>
        </Ring>

        {onBreak && (
          <div className="break-card" key={idea.title}>
            <span className="break-eyebrow">Break idea</span>
            <h2>{idea.title}</h2>
            <p>{idea.detail}</p>
            <div className="break-actions">
              <button className="ghost-btn" onClick={() => setIdeaShift((n) => n + 1)}>Another idea</button>
              <span className="muted">Games stay blocked on breaks</span>
            </div>
          </div>
        )}

        <div className="controls">
          {onBreak ? (
            <button className="ctl" onClick={onSkipBreak}>
              <IconSkip /> Skip break
            </button>
          ) : paused ? (
            <button className="ctl primary" onClick={onResume}>
              <IconPlay /> Resume
            </button>
          ) : (
            <button className="ctl" onClick={onPause}>
              <IconPause /> Pause
            </button>
          )}
          <button className="ctl subtle" onClick={requestEnd}>
            <IconStop /> End
          </button>
        </div>
      </main>

      <footer className="focus-bottom">
        <div className="mini-goal" title="Today's goal">
          <div className="mini-goal-bar"><span style={{ width: `${goalPct}%` }} /></div>
          <span>{fmtDur(todayTotal * MIN)} / {fmtDur(settings.dailyGoalMin * MIN)} today</span>
        </div>
        {pomodoro && (
          <div className="round-dots" aria-label={`${active.rounds} rounds done`}>
            {Array.from({ length: settings.roundsBeforeLong }, (_, i) => (
              <span key={i} className={i < active.rounds % settings.roundsBeforeLong || (active.rounds > 0 && active.rounds % settings.roundsBeforeLong === 0 && onBreak) ? "is-done" : i === active.rounds % settings.roundsBeforeLong && !onBreak ? "is-now" : ""} />
            ))}
          </div>
        )}
      </footer>

      {ending && <LockInGate seconds={settings.lockInSec} focused={focused} onStay={() => setEnding(false)} onEnd={onFinish} />}
    </div>
  );
}

function LockInGate({ seconds, focused, onStay, onEnd }: { seconds: number; focused: number; onStay: () => void; onEnd: () => void }) {
  const [startAt] = useState(Date.now());
  const [t, setT] = useState(Date.now());
  const [line] = useState(() => lockInLines[Math.floor(Math.random() * lockInLines.length)]);
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onStay();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onStay]);
  const leftMs = Math.max(0, seconds * 1000 - (t - startAt));
  const ready = leftMs === 0;
  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <div className="gate-card">
        <Ring size={132} stroke={6} progress={1 - leftMs / (seconds * 1000)} className="gate-ring">
          <span className="gate-num">{ready ? <IconLock /> : Math.ceil(leftMs / 1000)}</span>
        </Ring>
        <h2 id="gate-title">{ready ? "Okay, your call." : "Hold up."}</h2>
        <p>{ready ? `You focused for ${fmtDur(focused)}. That still counts.` : line}</p>
        <div className="gate-actions">
          <button className="big-btn" onClick={onStay} autoFocus>
            Keep going
          </button>
          <button className="ghost-btn" disabled={!ready} onClick={onEnd}>
            {ready ? "End session" : `End in ${Math.ceil(leftMs / 1000)}s`}
          </button>
        </div>
      </div>
    </div>
  );
}

function CamBubble({ status, video, showSelf, onToggle }: { status: CamStatus; video: HTMLVideoElement | null; showSelf: boolean; onToggle: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || !video || !showSelf) return;
    video.className = "cam-video";
    el.appendChild(video);
    void video.play().catch(() => {});
    return () => { if (video.parentElement === el) el.removeChild(video); };
  }, [video, showSelf, status.state]);

  const label =
    status.state === "loading" ? "Starting camera…"
    : status.state === "denied" ? "Camera blocked. Allow it in Chrome's address bar to use the camera features."
    : status.state === "error" ? "Camera isn't available right now"
    : status.present ? "Camera sees you. Nothing leaves this PC."
    : "Can't see you right now";
  const tone = status.state !== "on" ? status.state : status.present ? "here" : "gone";
  return (
    <button className={`cam-bubble ${tone} ${showSelf ? "self" : ""}`} onClick={onToggle} title={`${label} Click to see what the camera sees.`} aria-label={label}>
      <div className="cam-face" ref={box}>
        {(!showSelf || status.state !== "on") && (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
          </svg>
        )}
      </div>
    </button>
  );
}
