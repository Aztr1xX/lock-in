import { useEffect, useRef, useState } from "react";
import type { CamStatus, FocusCamera } from "../lib/camera";
import { drawCam } from "../lib/camDraw";
import type { Active, Overlay, Session, Settings } from "../lib/store";
import { fmtClock, fmtDur, focusMs, MIN, phaseElapsed } from "../lib/timer";
import { breakIdeas, lockInLines } from "../lib/content";
import { todayMinutes } from "../lib/stats";
import Ring from "./Ring";
import GrowWidget from "./GrowWidget";
import type { GardenState } from "../lib/garden";
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
  cam: FocusCamera | null;
  onToggleSelf: () => void;
  popped: boolean;
  onPopOut: (() => void) | null;
  onCamCheck: () => void;
  garden: GardenState | null;
}

export default function Focus({ active, settings, now, sessions, onPause, onResume, onSkipBreak, onFinish, camStatus, cam, onCamCheck, onToggleSelf, popped, onPopOut, garden }: Props) {
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
          {settings.camera && <CamBubble status={camStatus} cam={cam} showSelf={settings.showSelf} overlay={settings.overlay} popped={popped} onOpen={onCamCheck} onToggle={onToggleSelf} onPopOut={onPopOut} />}
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
                : `then a ${((m) => (m < 1 ? `${Math.round(m * 60)} s` : `${m} min`))(nextBreakLong ? settings.longMin : settings.shortMin)} break`
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
        {garden && <GrowWidget garden={garden} rounds={active.rounds} />}
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

function CamBubble({ status, cam, showSelf, overlay, popped, onOpen, onToggle, onPopOut }: { status: CamStatus; cam: FocusCamera | null; showSelf: boolean; overlay: Overlay; popped: boolean; onOpen: () => void; onToggle: () => void; onPopOut: (() => void) | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const show = useRef(overlay);
  show.current = overlay;
  const on = status.state === "on" && !!cam;
  // Drag it anywhere; it remembers where you left it. A press without a drag opens the full view.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem("lockin.pip") || "null"); } catch { return null; }
  });
  const drag = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const clamp = (x: number, y: number) => {
    const el = box.current;
    const w = el?.offsetWidth ?? 200, h = el?.offsetHeight ?? 150;
    return { x: Math.max(8, Math.min(innerWidth - w - 8, x)), y: Math.max(8, Math.min(innerHeight - h - 8, y)) };
  };
  useEffect(() => {
    const fit = () => setPos((p) => (p ? clamp(p.x, p.y) : p));
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, []);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".cam-pip-btns")) return;
    const r = box.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
    box.current!.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return;
    d.moved = true;
    box.current!.classList.add("dragging");
    setPos(clamp(e.clientX - d.dx, e.clientY - d.dy));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    box.current?.classList.remove("dragging");
    if (!d) return;
    if (!d.moved) return onOpen();
    setPos((p) => {
      try { localStorage.setItem("lockin.pip", JSON.stringify(p)); } catch { /* fine */ }
      return p;
    });
  };
  useEffect(() => {
    if (!on || !showSelf || !cam || popped) return;
    let raf = 0, last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 66) return; // ~15 fps is plenty for a preview
      last = t;
      if (canvas.current) drawCam(canvas.current, cam, show.current);
      // Border flashes red while it sees you on your phone, orange for a long hunch.
      const a = cam.debug.alert;
      box.current?.classList.toggle("alert-phone", a === "phone");
      box.current?.classList.toggle("alert-posture", a === "posture");
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [on, showSelf, cam, popped]);

  const label =
    status.state === "loading" ? "Starting camera…"
    : status.state === "denied" ? "Camera blocked. Allow it in Chrome's address bar."
    : status.state === "error" ? "Camera isn't available right now"
    : status.present ? "Sees you"
    : "Can't see you";
  const tone = status.state !== "on" ? status.state : status.present ? "here" : "gone";

  if (popped && on) {
    return (
      <button className="cam-bubble here popped" onClick={onOpen} title="The camera is in its own window. Click for the full camera check." aria-label="Camera is popped out">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="4" width="20" height="16" rx="2" /><rect x="12" y="11" width="8" height="7" rx="1" fill="currentColor" />
        </svg>
      </button>
    );
  }
  if (!showSelf || !on) {
    return (
      <button className={`cam-bubble ${tone}`} onClick={on ? onToggle : onOpen} title={on ? "Show the camera" : label} aria-label={on ? "Show the camera" : label}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
        </svg>
      </button>
    );
  }
  return (
    <div
      ref={box}
      className={`cam-pip ${tone}`}
      style={pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div
        className="cam-pip-view"
        role="button"
        tabIndex={0}
        title="Drag to move. Click for the full camera check."
        aria-label="Camera preview. Drag to move, click for the full camera check."
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
      >
        <canvas ref={canvas} width={320} height={240} />
      </div>
      <span className="cam-pip-status"><i />{label}</span>
      <div className="cam-pip-btns">
        {onPopOut && (
          <button className="cam-pip-btn" onClick={onPopOut} aria-label="Pop out into its own window" title="Pop out: floats over everything, drag it to any screen">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 4h6v6" /><path d="M20 4l-8 8" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
            </svg>
          </button>
        )}
        <button className="cam-pip-btn cam-pip-hide" onClick={onToggle} aria-label="Hide the camera preview" title="Hide">–</button>
      </div>
    </div>
  );
}
