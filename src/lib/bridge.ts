// Talks to the Lock In Blocker extension through window messages. The extension's
// content script runs on every page, so this works wherever the app is hosted.

type Listener = (connected: boolean) => void;

let connected = false;
const listeners = new Set<Listener>();

addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== "lockin-ext") return;
  if (!connected) {
    connected = true;
    listeners.forEach((l) => l(true));
  }
});

const post = (msg: object) => window.postMessage({ source: "lockin-app", ...msg }, "*");

export function pingExtension() {
  post({ type: "ping" });
}

export function onExtension(l: Listener): () => void {
  listeners.add(l);
  l(connected);
  return () => listeners.delete(l);
}

export function sendSession(active: boolean, session?: { subject: string; goal: string; phase: string }) {
  post({ type: "session", active, session });
}
