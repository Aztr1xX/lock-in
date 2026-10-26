// Lets the Lock In web app talk to the extension. The app posts messages to its own
// window; this script (which runs on every page and frame) passes them on, but only
// on the Lock In site itself, so no other page can switch blocking off or read your history.
(() => {
  const h = location.hostname;
  const isLockIn = location.protocol === "https:" ? h === "lock-in-ten-roan.vercel.app" : h === "localhost" || h === "127.0.0.1";
  if (!isLockIn) return;

  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }));
  const reply = (msg) => window.postMessage({ source: "lockin-ext", ...msg }, location.origin);

  window.addEventListener("message", async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "lockin-app") return;
    if (d.type === "ping") {
      const r = await send({ kind: "helperStatus" });
      reply({ type: "hello", version: chrome.runtime.getManifest().version, helper: !!r?.helper, backup: r?.backup ?? null });
    } else if (d.type === "session") {
      const r = await send({ kind: "session", active: d.active, session: d.session ?? null });
      reply({ type: "ack", locked: r?.locked ?? false });
    } else if (d.type === "backup") {
      const r = await send({ kind: "backup", data: d.data });
      reply({ type: "backup-saved", backup: r?.backup ?? null, kept: !!r?.kept });
    } else if (d.type === "getBackup") {
      const r = await send({ kind: "getBackup" });
      reply({ type: "backup-data", data: r?.data ?? null });
    }
  });
})();
