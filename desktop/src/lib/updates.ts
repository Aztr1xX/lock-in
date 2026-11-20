// Automatic updates. The app asks GitHub for a newer signed version, downloads it in the
// background and installs it on restart, so nobody has to download Lock In twice.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "downloading"; version: string; pct: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

/** How often a running app looks for updates. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let pending: Update | null = null;

export async function checkAndDownload(on: (s: UpdateState) => void) {
  if (pending) return on({ kind: "ready", version: pending.version });
  on({ kind: "checking" });
  try {
    const u = await check();
    if (!u) return on({ kind: "none" });
    let total = 0;
    let got = 0;
    await u.download((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        on({ kind: "downloading", version: u.version, pct: total ? got / total : 0 });
      }
    });
    pending = u;
    on({ kind: "ready", version: u.version });
  } catch (e) {
    on({ kind: "error", message: String(e) });
  }
}

/** Installs the downloaded update. On Windows the installer closes the app and opens the new one. */
export async function installNow() {
  if (!pending) return;
  await pending.install();
  await relaunch();
}
