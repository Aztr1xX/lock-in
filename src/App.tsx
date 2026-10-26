import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Active, type Session, type Settings,
  loadActive, loadSessions, loadSettings, saveActive, saveSessions, saveSettings, uid,
} from "./lib/store";
import { advance, fmtClock, focusMs, MIN, phaseDuration, phaseElapsed } from "./lib/timer";
import { breakIdeas } from "./lib/content";
import { chime, primeAudio, setFavicon } from "./lib/fx";
import { type Helpers, onExtension, pingExtension, sendSession } from "./lib/bridge";
import SetupSheet from "./components/SetupSheet";
import Home from "./components/Home";
import Focus from "./components/Focus";
import Done from "./components/Done";
import Stats from "./components/Stats";
import SettingsSheet from "./components/SettingsSheet";

type View = "home" | "stats";

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [sessions, setSessions] = useState<Session[]>(loadSessions);
  const [active, setActive] = useState<Active | null>(loadActive);
  const [done, setDone] = useState<{ session: Session; saved: boolean; prevSessions: Session[] } | null>(null);
  const [view, setView] = useState<View>("home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [setupOpen, setSetupOpen] = useState(false);
  const [helpers, setHelpers] = useState<Helpers>({ blocker: false, closer: false });

  useEffect(() => {
    const off = onExtension(setHelpers);
    pingExtension();
    const id = setInterval(pingExtension, 5000);
    return () => { off(); clearInterval(id); };
  }, []);

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

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

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
      a = advance(a, settings, endedAt, breakIdeas.length);
      changed = true;
    }
    if (changed) {
      if (settings.sound) (a.phase === "focus" ? chime.backToWork : chime.breakTime)();
      commitActive(a);
    }
  }, [now, active, settings, commitActive]);

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
    (subject: string, goal: string) => {
      primeAudio();
      const t = Date.now();
      const a: Active = {
        id: uid(),
        subject: subject || "General",
        goal: goal.trim(),
        mode: settings.mode,
        startedAt: t,
        phase: "focus",
        phaseStartedAt: t,
        phaseDurMs: settings.mode === "pomodoro" ? phaseDuration("focus", settings) : 0,
        pausedAt: null,
        pausedMsInPhase: 0,
        focusMsBanked: 0,
        rounds: 0,
        breakIdea: 0,
      };
      const subjects = settings.subjects.includes(a.subject) || a.subject === "General"
        ? settings.subjects
        : [...settings.subjects, a.subject];
      updateSettings({ lastSubject: a.subject, subjects });
      if (settings.sound) chime.start();
      setNow(t);
      commitActive(a);
    },
    [settings, updateSettings, commitActive],
  );

  const pause = useCallback(() => {
    if (!active || active.pausedAt) return;
    commitActive({ ...active, pausedAt: Date.now() });
  }, [active, commitActive]);

  const resume = useCallback(() => {
    if (!active?.pausedAt) return;
    commitActive({ ...active, pausedMsInPhase: active.pausedMsInPhase + (Date.now() - active.pausedAt), pausedAt: null });
  }, [active, commitActive]);

  const skipBreak = useCallback(() => {
    if (!active || active.phase === "focus") return;
    if (settings.sound) chime.backToWork();
    commitActive(advance(active, settings, Date.now(), breakIdeas.length));
  }, [active, settings, commitActive]);

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
    const saved = session.focusMs >= MIN;
    const prev = sessions;
    if (saved) {
      const next = [...sessions, session];
      saveSessions(next);
      setSessions(next);
    }
    if (settings.sound) chime.done();
    sendSession(false);
    commitActive(null);
    setDone({ session, saved, prevSessions: prev });
  }, [active, sessions, settings.sound, commitActive]);

  const rate = useCallback((id: string, rating: number) => {
    setSessions((list) => {
      const next = list.map((s) => (s.id === id ? { ...s, rating } : s));
      saveSessions(next);
      return next;
    });
  }, []);

  const deleteSession = useCallback((id: string) => {
    setSessions((list) => {
      const next = list.filter((s) => s.id !== id);
      saveSessions(next);
      return next;
    });
  }, []);

  const liveFocusMin = useMemo(() => (active ? focusMs(active, now) / MIN : 0), [active, now]);

  let screen;
  if (active) {
    screen = (
      <Focus
        active={active}
        settings={settings}
        now={now}
        sessions={sessions}
        onPause={pause}
        onResume={resume}
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
        onClose={() => setDone(null)}
      />
    );
  } else if (view === "stats") {
    screen = <Stats sessions={sessions} settings={settings} onBack={() => setView("home")} onDelete={deleteSession} />;
  } else {
    screen = (
      <Home
        settings={settings}
        sessions={sessions}
        now={now}
        liveFocusMin={liveFocusMin}
        onStart={start}
        onStats={() => setView("stats")}
        onSettings={() => setSettingsOpen(true)}
        onSetup={() => setSetupOpen(true)}
        helpers={helpers}
        updateSettings={updateSettings}
      />
    );
  }

  return (
    <>
      {screen}
      {settingsOpen && <SettingsSheet settings={settings} update={updateSettings} onClose={() => setSettingsOpen(false)} />}
      {setupOpen && <SetupSheet helpers={helpers} onClose={() => setSetupOpen(false)} />}
    </>
  );
}
