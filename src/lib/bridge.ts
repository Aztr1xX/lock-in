// Talks to the Lock In Blocker extension through window messages. The extension's
// content script runs on every page, so this works wherever the app is hosted.

export interface Helpers {
  blocker: boolean; // Chrome extension
  closer: boolean; // Windows game closer, reached through the extension
}
type Listener = (h: Helpers) => void;

let state: Helpers = { blocker: false, closer: false };
const listeners = new Set<Listener>();

addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== "lockin-ext") return;
  const next = { blocker: true, closer: e.data.type === "hello" ? !!e.data.helper : state.closer };
  if (next.blocker !== state.blocker || next.closer !== state.closer) {
    state = next;
    listeners.forEach((l) => l(state));
  }
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
