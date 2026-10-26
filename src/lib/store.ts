// All data lives in this browser on this PC. Nothing is sent anywhere.

export type Mode = "pomodoro" | "flow";
export type Phase = "focus" | "short" | "long";

export interface Exam {
  id: string;
  name: string;
  date: string; // YYYY-MM-DD
}

export interface Settings {
  mode: Mode;
  focusMin: number;
  shortMin: number;
  longMin: number;
  roundsBeforeLong: number;
  lockIn: boolean;
  lockInSec: number;
  dailyGoalMin: number;
  sound: boolean;
  subjects: string[];
  lastSubject: string;
  exams: Exam[];
  name: string;
}

export interface Session {
  id: string;
  subject: string;
  goal: string;
  start: number;
  end: number;
  focusMs: number;
  rounds: number;
  rating?: number;
}

export interface Active {
  id: string;
  subject: string;
  goal: string;
  mode: Mode;
  startedAt: number;
  phase: Phase;
  phaseStartedAt: number;
  phaseDurMs: number; // 0 in flow mode
  pausedAt: number | null;
  pausedMsInPhase: number;
  focusMsBanked: number;
  rounds: number; // completed focus rounds
  breakIdea: number;
}

export const defaultSettings: Settings = {
  mode: "pomodoro",
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  roundsBeforeLong: 4,
  lockIn: true,
  lockInSec: 30,
  dailyGoalMin: 120,
  sound: true,
  subjects: [],
  lastSubject: "General",
  exams: [],
  name: "",
};

const K = { settings: "lockin.settings", sessions: "lockin.sessions", active: "lockin.active" };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: keep running in memory */
  }
}

export const loadSettings = (): Settings => ({ ...defaultSettings, ...read<Partial<Settings>>(K.settings, {}) });
export const saveSettings = (s: Settings) => write(K.settings, s);
export const loadSessions = (): Session[] => read<Session[]>(K.sessions, []);
export const saveSessions = (s: Session[]) => write(K.sessions, s);
export const loadActive = (): Active | null => read<Active | null>(K.active, null);
export const saveActive = (a: Active | null) => write(K.active, a);

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
