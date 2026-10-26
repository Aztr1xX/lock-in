// Talks to the Lock In Blocker extension through window messages. The extension's
// content script runs on every page, but it only passes on messages from the Lock In site.

import type { Session, Settings } from "./store";

export interface BackupMeta {
  count: number; // sessions in the copy
  savedAt: number;
}

export interface BackupData {
  sessions: Session[];
  settings: Settings;
  savedAt: number;
}

export interface Helpers {
  blocker: boolean; // Chrome extension
  closer: boolean; // Windows game closer, reached through the extension
  /** The copy of your history the blocker keeps. Undefined if this blocker is too old to keep one. */
  backup?: BackupMeta | null;
}
type Listener = (h: Helpers) => void;

let state: Helpers = { blocker: false, closer: false };
const listeners = new Set<Listener>();
let backupWaiter: ((d: BackupData | null) => void) | null = null;

const set = (patch: Partial<Helpers>) => {
  const next = { ...state, blocker: true, ...patch };
  if (next.closer === state.closer && next.blocker === state.blocker && JSON.stringify(next.backup) === JSON.stringify(state.backup)) return;
  state = next;
  listeners.forEach((l) => l(state));
};

addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== "lockin-ext") return;
  const d = e.data;
  if (d.type === "hello") set({ closer: !!d.helper, ...("backup" in d ? { backup: d.backup ?? null } : {}) });
  else if (d.type === "backup-saved") set({ backup: d.backup ?? null });
  else if (d.type === "backup-data") {
    backupWaiter?.(d.data ?? null);
    backupWaiter = null;
  } else set({});
});

const post = (msg: object) => window.postMessage({ source: "lockin-app", ...msg }, "*");

export function pingExtension() {
  post({ type: "ping" });
}

export function onExtension(l: Listener): () => void {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}

export function sendSession(active: boolean, session?: { subject: string; goal: string; phase: string }) {
  post({ type: "session", active, session });
}

/** Hands the blocker a fresh copy of your history. It won't swap a big copy for a much smaller one. */
export function sendBackup(sessions: Session[], settings: Settings) {
  post({ type: "backup", data: { sessions, settings, savedAt: Date.now() } });
}

/** Asks the blocker for the copy it kept. */
export function fetchBackup(): Promise<BackupData | null> {
  return new Promise((resolve) => {
    backupWaiter?.(null);
    backupWaiter = resolve;
    post({ type: "getBackup" });
    setTimeout(() => {
      if (backupWaiter === resolve) {
        backupWaiter = null;
        resolve(null);
      }
    }, 5_000);
  });
}
