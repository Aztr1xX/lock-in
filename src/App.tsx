import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Active, type Session, type Settings,
  loadActive, loadSessions, loadSettings, saveActive, saveSessions, saveSettings, uid,
} from "./lib/store";
import { advance, breakNow, fmtClock, focusMs, MIN, phaseDuration, phaseElapsed, sessionSettings } from "./lib/timer";
import { type CamEvent, type CamStatus, FocusCamera } from "./lib/camera";
import { canPopOut, openPopout } from "./lib/popout";
import { addFrame, deleteFrames } from "./lib/timelapse";
import Toast, { type ToastData } from "./components/Toast";
import { breakIdeas } from "./lib/content";
import { chime, primeAudio, setFavicon, swapScreen } from "./lib/fx";
import { type Helpers, fetchBackup, onExtension, pingExtension, sendBackup, sendSession } from "./lib/bridge";
import SetupSheet from "./components/SetupSheet";
import Home from "./components/Home";
import Focus from "./components/Focus";
import Done from "./components/Done";
import Stats from "./components/Stats";
import SettingsSheet from "./components/SettingsSheet";
import CamCheck from "./components/CamCheck";

type View = "home" | "stats";

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [sessions, setSessions] = useState<Session[]>(loadSessions);
  const [active, setActive] = useState<Active | null>(loadActive);
  const [done, setDone] = useState<{ session: Session; saved: boolean; test: boolean; prevSessions: Session[] } | null>(null);
  const [camCheck, setCamCheck] = useState(false);
  const [view, setView] = useState<View>("home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [setupOpen, setSetupOpen] = useState(false);
  const [helpers, setHelpers] = useState<Helpers>({ blocker: false, closer: false });
  const [toast, setToast] = useState<ToastData | null>(null);
  const [camStatus, setCamStatus] = useState<CamStatus>({ state: "off", present: false, faceVisible: false });
  const camRef = useRef<FocusCamera | null>(null);
  const framesRef = useRef(0);
  const popRef = useRef<Window | null>(null);
  const [popped, setPopped] = useState(false);
  // Camera events arrive outside React, so they act through the latest handlers.
  const handlers = useRef<{ onCam: (e: CamEvent) => void }>({ onCam: () => {} });

  const showToast = useCallback((t: Omit<ToastData, "id">) => setToast({ ...t, id: Date.now() }), []);

  useEffect(() => {
    const off = onExtension(setHelpers);
    pingExtension();
    const id = setInterval(pingExtension, 5000);
    return () => { off(); clearInterval(id); };
  }, []);

  // The blocker keeps a copy of your history, refreshed whenever it changes. If this browser
  // turns up with far less than that copy (site data cleared), Home offers to bring it back.
  const [restoreDismissed, setRestoreDismissed] = useState(false);
  const kept = helpers.blocker ? helpers.backup : undefined;
  const restoreOffer = !!kept && kept.count > 0 && (sessions.length === 0 || kept.count > sessions.length + 5) && !restoreDismissed;
  const canBackup = kept !== undefined && !restoreOffer && !(kept && kept.count > 0 && sessions.length === 0);
  useEffect(() => {
    if (!canBackup) return;
    const id = setTimeout(() => sendBackup(sessions, settings), 1500);
    return () => clearTimeout(id);
  }, [canBackup, sessions, settings]);

  const restoreFromBlocker = useCallback(async () => {
    const data = await fetchBackup();
    if (!data?.sessions?.length) {
      showToast({ icon: "🤔", text: "Couldn't read the copy from the blocker. Try again in a moment." });
      return;
    }
    const mine = loadSessions();
    const ids = new Set(mine.map((x) => x.id));
    const merged = [...mine, ...data.sessions.filter((x) => !ids.has(x.id))].sort((a, b) => a.start - b.start);
    saveSessions(merged);
    setSessions(merged);
    // A wiped browser lost its settings too, so those come back as well.
    if (!mine.length && data.settings) updateSettings({ ...data.settings });
    setRestoreDismissed(true);
    showToast({ icon: "🌱", text: `Brought back ${merged.length - mine.length} sessions. Your plant is home.` });
  }, [showToast]);

  // Keep the blocker in step with the session: on at Start, renewed every minute, off at End.
  const activeId = active?.id;
  const activeSubject = active?.subject;
  const activeGoal = active?.goal;
  const activePhase = active?.phase;
  useEffect(() => {
    if (!activeId) return;
    const send = () => sendSession(true, { subject: activeSubject ?? "", goal: activeGoal ?? "", phase: activePhase ?? "focus" });
    send();
    const id = setInterval(send, 60_000);
    return () => clearInterval(id);
  }, [activeId, activeSubject, activeGoal, activePhase, helpers.blocker]);

  // Camera: on for the whole session if it's switched on in Settings.
  const camOn = settings.camera;
  const activeTest = !!active?.test;
  useEffect(() => {
    if (!activeId || !camOn) return;
    framesRef.current = 0;
    const cam = new FocusCamera(
      settings.cam,
      (e) => handlers.current.onCam(e),
      setCamStatus,
      (blob) => void addFrame(activeId, framesRef.current++, blob),
    );
    camRef.current = cam;
    cam.setQuick(activeTest);
    cam.setAwayMs(settings.awaySec * 1000);
    void cam.setCamera(settings.cameraId);
    void cam.start();
    return () => {
      popRef.current?.close();
      cam.stop();
      if (camRef.current === cam) camRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, camOn]);

  useEffect(() => camRef.current?.setFeatures(settings.cam), [settings.cam]);
  useEffect(() => camRef.current?.setAwayMs(settings.awaySec * 1000), [settings.awaySec]);
  useEffect(() => void camRef.current?.setCamera(settings.cameraId), [settings.cameraId]);

  // Detection counts during focus only. While auto-paused it keeps watching for you to come back.
  const focusing = !!active && active.phase === "focus" && (!active.pausedAt || !!active.autoPaused);
  useEffect(() => camRef.current?.setFocusing(focusing), [focusing, camStatus.state]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  // Test runs swap in tiny timers; everything else reads the real settings.
  const eff = useMemo(() => sessionSettings(settings, active), [settings, active]);

  const commitActive = useCallback((a: Active | null) => {
    saveActive(a);
    setActive(a);
  }, []);

  // Clock: fast while a session runs, slow otherwise (for the greeting and day rollover).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), active ? 250 : 30_000);
    return () => clearInterval(id);
  }, [active]);

  // Pomodoro phase changes. Catches up properly if the PC slept mid-session.
  useEffect(() => {
    if (!active || active.mode !== "pomodoro" || active.pausedAt) return;
    let a = active;
    let changed = false;
    while (phaseElapsed(a, now) >= a.phaseDurMs) {
      const endedAt = a.phaseStartedAt + a.pausedMsInPhase + a.phaseDurMs;
      a = advance(a, eff, endedAt, breakIdeas.length);
      changed = true;
    }
    if (changed) {
      if (settings.sound) (a.phase === "focus" ? chime.backToWork : chime.breakTime)();
      commitActive(a);
    }
  }, [now, active, settings, eff, commitActive]);

  // Tab title and live favicon ring.
  useEffect(() => {
    if (!active) {
      document.title = "Lock In";
      setFavicon(null);
      return;
    }
    const el = phaseElapsed(active, now);
    const onBreak = active.phase !== "focus";
    if (active.mode === "pomodoro") {
      const left = active.phaseDurMs - el;
      document.title = `${active.pausedAt ? "⏸ " : ""}${fmtClock(left)} · ${onBreak ? "Break" : active.subject}`;
      setFavicon(Math.min(1, el / active.phaseDurMs), onBreak);
    } else {
      document.title = `${active.pausedAt ? "⏸ " : ""}${fmtClock(el)} · ${active.subject}`;
      setFavicon((el % (60 * MIN)) / (60 * MIN));
    }
  }, [now, active]);

  const start = useCallback(
    (subject: string, goal: string, test = false) => {
      primeAudio();
      const t = Date.now();
      const mode = test ? "pomodoro" : settings.mode;
      const a: Active = {
        id: uid(),
        subject: subject || "General",
        goal: goal.trim(),
        mode,
        startedAt: t,
        phase: "focus",
        phaseStartedAt: t,
        phaseDurMs: mode === "pomodoro" ? phaseDuration("focus", test ? sessionSettings(settings, { test } as Active) : settings) : 0,
        pausedAt: null,
        pausedMsInPhase: 0,
        focusMsBanked: 0,
        rounds: 0,
        breakIdea: 0,
        test,
      };
      const subjects = settings.subjects.includes(a.subject) || a.subject === "General"
        ? settings.subjects
        : [...settings.subjects, a.subject];
      if (!test) updateSettings({ lastSubject: a.subject, subjects });
      if (settings.sound) chime.start();
      swapScreen(() => {
        setNow(t);
        commitActive(a);
      });
    },
    [settings, updateSettings, commitActive],
  );

  const pause = useCallback((auto = false) => {
    if (!active || active.pausedAt) return;
    commitActive({ ...active, pausedAt: Date.now(), autoPaused: auto });
  }, [active, commitActive]);

  const resume = useCallback(() => {
    if (!active?.pausedAt) return;
    commitActive({ ...active, pausedMsInPhase: active.pausedMsInPhase + (Date.now() - active.pausedAt), pausedAt: null, autoPaused: false });
  }, [active, commitActive]);

  const takeBreak = useCallback(() => {
    if (!active) return;
    if (settings.sound) chime.breakTime();
    commitActive(breakNow(active, eff, Date.now(), breakIdeas.length));
  }, [active, settings, eff, commitActive]);

  handlers.current.onCam = (e: CamEvent) => {
    if (!active) return;
    if (e === "away" && !active.pausedAt) {
      pause(true);
      showToast({ icon: "👋", text: "Paused while you're away. It picks up when you're back." });
    } else if (e === "back" && active.autoPaused) {
      resume();
      showToast({ icon: "✨", text: "Welcome back. Timer's running again." });
    } else if (e === "phone") {
      showToast({ icon: "📵", text: "Phone down? It'll still be there at the break." });
    } else if (e === "posture") {
      showToast({ icon: "🪑", text: "Quick posture check. Sit back and drop your shoulders." });
    } else if (e === "drowsy") {
      showToast({
        icon: "😴",
        text: "You're looking tired. A break might help.",
        action: active.mode === "pomodoro" && active.phase === "focus" ? { label: "Break now", run: takeBreak } : undefined,
      });
    } else if (e === "calibrated") {
      showToast({ icon: "✅", text: "Got your normal posture. I'll nudge you if you hunch for a while." });
    }
  };

  const skipBreak = useCallback(() => {
    if (!active || active.phase === "focus") return;
    if (settings.sound) chime.backToWork();
    commitActive(advance(active, eff, Date.now(), breakIdeas.length));
  }, [active, settings, eff, commitActive]);

  const finish = useCallback(() => {
    if (!active) return;
    const t = Date.now();
    const session: Session = {
      id: active.id,
      subject: active.subject,
      goal: active.goal,
      start: active.startedAt,
      end: t,
      focusMs: focusMs(active, t),
      rounds: active.rounds,
    };
    const cam = camRef.current;
    if (cam && cam.status.state === "on") {
      session.trace = cam.takeTrace();
      session.counts = { ...cam.counts };
    }
    if (framesRef.current) session.frames = framesRef.current;
    const test = !!active.test;
    const saved = !test && session.focusMs >= MIN;
    const prev = sessions;
    if (saved) {
      const next = [...sessions, session];
      saveSessions(next);
      setSessions(next);
    }
    if (settings.sound) chime.done();
    sendSession(false);
    setToast(null);
    swapScreen(() => {
      commitActive(null);
      setDone({ session, saved, test, prevSessions: prev });
    });
  }, [active, sessions, settings.sound, commitActive]);

  const rate = useCallback((id: string, rating: number) => {
    setSessions((list) => {
      const next = list.map((s) => (s.id === id ? { ...s, rating } : s));
      saveSessions(next);
      return next;
    });
  }, []);

  const deleteSession = useCallback((id: string) => {
    void deleteFrames(id);
    setSessions((list) => {
      const next = list.filter((s) => s.id !== id);
      saveSessions(next);
      return next;
    });
  }, []);

  // The pop-out window reads the latest session state each frame.
  const live = useRef({ active, eff });
  live.current = { active, eff };
  const popOut = useCallback(async () => {
    const cam = camRef.current;
    if (!cam || popRef.current) return;
    try {
      const w = await openPopout(cam, {
        overlay: () => live.current.eff.overlay,
        info: () => {
          const a = live.current.active;
          if (!a) return null;
          const t = Date.now();
          const el = phaseElapsed(a, t);
          const onBreak = a.phase !== "focus";
          return {
            clock: fmtClock(a.mode === "pomodoro" ? a.phaseDurMs - el : el),
            label: a.pausedAt ? "Paused" : onBreak ? "Break" : a.subject,
            onBreak,
          };
        },
        onClose: () => {
          popRef.current = null;
          setPopped(false);
        },
      });
      if (w) {
        popRef.current = w;
        setPopped(true);
      }
    } catch {
      showToast({ icon: "🪟", text: "Couldn't pop the camera out. Try clicking the button again." });
    }
  }, [showToast]);

  const liveFocusMin = useMemo(() => (active ? focusMs(active, now) / MIN : 0), [active, now]);

  let screen;
  if (active) {
    screen = (
      <Focus
        active={active}
        settings={eff}
        now={now}
        sessions={sessions}
        onPause={() => pause()}
        onResume={resume}
        camStatus={camStatus}
        cam={camRef.current}
        onToggleSelf={() => updateSettings({ showSelf: !settings.showSelf })}
        popped={popped}
        onPopOut={canPopOut() ? popOut : null}
        onCamCheck={() => setCamCheck(true)}
        onSkipBreak={skipBreak}
        onFinish={finish}
      />
    );
  } else if (done) {
    screen = (
      <Done
        {...done}
        sessions={sessions}
        settings={settings}
        onRate={(r) => rate(done.session.id, r)}
        onClose={() => {
          // Test runs leave nothing behind, time-lapse included.
          if (done.test) void deleteFrames(done.session.id);
          swapScreen(() => setDone(null));
        }}
      />
    );
  } else if (view === "stats") {
    screen = <Stats sessions={sessions} settings={settings} onBack={() => swapScreen(() => setView("home"))} onDelete={deleteSession} />;
  } else {
    screen = (
      <Home
        settings={settings}
        sessions={sessions}
        now={now}
        liveFocusMin={liveFocusMin}
        onStart={start}
        onStats={() => swapScreen(() => setView("stats"))}
        onSettings={() => setSettingsOpen(true)}
        onSetup={() => setSetupOpen(true)}
        onTest={() => start(settings.lastSubject, "Test run", true)}
        onCamCheck={() => setCamCheck(true)}
        helpers={helpers}
        updateSettings={updateSettings}
        onToast={showToast}
        restore={restoreOffer && kept ? { count: kept.count, savedAt: kept.savedAt, onRestore: () => void restoreFromBlocker(), onDismiss: () => setRestoreDismissed(true) } : null}
      />
    );
  }

  return (
    <>
      {screen}
      {settingsOpen && <SettingsSheet settings={settings} update={updateSettings} onClose={() => setSettingsOpen(false)} autoBackup={!helpers.blocker ? "none" : kept === undefined ? "old" : kept} onSetup={() => { setSettingsOpen(false); setSetupOpen(true); }} />}
      <Toast toast={toast} onDone={() => setToast(null)} />
      {camCheck && (
        <CamCheck
          cam={active ? camRef.current : null}
          settings={settings}
          onClose={() => setCamCheck(false)}
          onOverlay={(overlay) => updateSettings({ overlay })}
          onCamera={(cameraId) => updateSettings({ cameraId })}
          onToggleSelf={active ? () => updateSettings({ showSelf: !settings.showSelf }) : undefined}
        />
      )}
      {setupOpen && <SetupSheet helpers={helpers} onClose={() => setSetupOpen(false)} />}
    </>
  );
}
