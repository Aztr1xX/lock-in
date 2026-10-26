// Lets the Lock In web app talk to the extension. The app posts messages to its own
// window; this script (which runs on every page and frame) passes the app's ones on.
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== "lockin-app") return;
  if (d.type === "ping") {
    window.postMessage({ source: "lockin-ext", type: "hello", version: chrome.runtime.getManifest().version }, "*");
    return;
  }
  if (d.type === "session") {
    chrome.runtime.sendMessage({ kind: "session", active: d.active, session: d.session ?? null }, (r) => {
      void chrome.runtime.lastError;
      window.postMessage({ source: "lockin-ext", type: "ack", locked: r?.locked ?? false }, "*");
    });
  }
});
