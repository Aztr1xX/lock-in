// YouTube during a session: study videos play, everything else gets a friendly wall.
const ALLOWED = ["Education", "Science & Technology"];
const WAIT_S = 30;
let checkedFor = "";
let overlay = null;

const locked = async () => {
  const s = await chrome.storage.local.get(["lockUntil", "session", "allowChannels"]);
  return { on: (s.lockUntil ?? 0) > Date.now(), session: s.session, allowChannels: s.allowChannels ?? [] };
};

async function videoInfo(url) {
  // Read the category YouTube gives the video from the watch page itself.
  const html = await (await fetch(url, { credentials: "include" })).text();
  const category = html.match(/"category":"([^"]+)"/)?.[1]?.replace(/\\u0026/g, "&") ?? "";
  const channelId = html.match(/"channelId":"([^"]+)"/)?.[1] ?? "";
  const channelName = html.match(/"ownerChannelName":"([^"]+)"/)?.[1] ?? "this channel";
  return { category, channelId, channelName };
}

function pauseVideos() {
  document.querySelectorAll("video").forEach((v) => v.pause());
}

function removeOverlay() {
  overlay?.remove();
  overlay = null;
}

function showOverlay({ title, reason, session, allowChannel }) {
  removeOverlay();
  pauseVideos();
  overlay = document.createElement("div");
  overlay.className = "lockin-wall";
  overlay.innerHTML = `
    <div class="lockin-card">
      <div class="lockin-ring"></div>
      <p class="lockin-eyebrow">Locked in${session?.subject ? " · " + escapeHtml(session.subject) : ""}</p>
      <h1>${title}</h1>
      <p class="lockin-reason">${reason}</p>
      ${session?.goal ? `<p class="lockin-goal">Your goal: <b>${escapeHtml(session.goal)}</b></p>` : ""}
      <div class="lockin-actions">
        <button class="lockin-primary" data-act="back">Back to studying</button>
        ${allowChannel ? `<button class="lockin-ghost" data-act="allow">This is for studying</button>` : ""}
      </div>
    </div>`;
  document.documentElement.appendChild(overlay);
  overlay.querySelector('[data-act="back"]').onclick = () => {
    if (history.length > 1) history.back();
    else location.href = "https://www.youtube.com/results?search_query=";
  };
  const allowBtn = overlay.querySelector('[data-act="allow"]');
  if (allowBtn) {
    allowBtn.onclick = () => {
      let left = WAIT_S;
      allowBtn.disabled = true;
      const tick = () => {
        if (!overlay) return;
        if (left <= 0) {
          allowBtn.disabled = false;
          allowBtn.textContent = `Allow ${allowChannel.name}`;
          allowBtn.onclick = () => {
            chrome.runtime.sendMessage({ kind: "allowChannel", channel: allowChannel.id }, () => {
              removeOverlay();
              document.querySelector("video")?.play();
            });
          };
          return;
        }
        allowBtn.textContent = `Wait ${left}s…`;
        left--;
        setTimeout(tick, 1000);
      };
      tick();
    };
  }
  // Keep the video paused while the wall is up.
  const keepPaused = setInterval(() => (overlay ? pauseVideos() : clearInterval(keepPaused)), 500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function check() {
  const st = await locked();
  if (!st.on) {
    removeOverlay();
    checkedFor = "";
    return;
  }
  const url = new URL(location.href);
  const key = url.pathname + url.search;
  if (key === checkedFor) return;
  checkedFor = key;

  if (url.pathname === "/" || url.pathname.startsWith("/feed/trending") || url.pathname.startsWith("/gaming")) {
    showOverlay({
      title: "The feed is off for now.",
      reason: "Search for what you need to learn instead. Study videos still play.",
      session: st.session,
    });
    return;
  }
  if (url.pathname.startsWith("/shorts")) {
    showOverlay({ title: "No Shorts mid-session.", reason: "They're designed to keep you scrolling. Save them for later.", session: st.session });
    return;
  }
  if (url.pathname === "/watch") {
    removeOverlay();
    try {
      const info = await videoInfo(location.href);
      if (checkedFor !== key) return; // navigated away meanwhile
      if (ALLOWED.includes(info.category) || st.allowChannels.includes(info.channelId)) return;
      showOverlay({
        title: "This one can wait.",
        reason: `YouTube files this video under <b>${escapeHtml(info.category || "Unknown")}</b>, not Education. If it really is for studying, you can allow ${escapeHtml(info.channelName)} after a short wait.`,
        session: st.session,
        allowChannel: info.channelId ? { id: info.channelId, name: info.channelName } : null,
      });
    } catch {
      /* If YouTube can't be read, don't get in the way. */
    }
    return;
  }
  removeOverlay();
}

document.addEventListener("yt-navigate-finish", () => check());
chrome.storage.onChanged.addListener(() => { checkedFor = ""; check(); });
setInterval(check, 1500);
check();
