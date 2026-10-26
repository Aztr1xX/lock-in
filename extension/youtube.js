// YouTube during a session: the search bar works, the feed is hidden, study searches
// and study videos go through, and anything else is shut and sent back.
const ALLOWED = ["Education", "Science & Technology"];
const WAIT_S = 30;
const LEAVE_S = 5; // a blocked page closes itself after this long
let checkedFor = "";
let overlay = null;
let prompt = null;

// Quick reads of the search itself. Clear study words win; clear fun words lose;
// anything else is judged by what YouTube actually returns for it.
const STUDY = /\b(lectures?|lessons?|tutorials?|explained|explanation|how to|revision|revise|exams?|gcse|a ?levels?|ib|sat|hsc|vce|atar|past papers?|worked examples?|practice questions?|course|crash course|khan|physics|chemistry|biology|maths?|mathematics|calculus|algebra|geometry|trig|trigonometry|statistics|equations?|derivatives?|integrals?|integration|differentiation|history|geography|economics|psychology|english|essays?|grammar|literature|shakespeare|poetry|spanish|french|german|japanese|chinese|programming|coding|python|javascript|java|computer science|study|notes|summary|science|cells?|atoms?|molecules?|organic|vectors?|matri(x|ces)|probability|thermodynamics|quantum|electricity|circuits?|genetics|dna|evolution|photosynthesis|mitosis|meiosis|enzymes?|anatomy|physiology|study with me|pomodoro)\b/i;
const FUN = /\b(minecraft|valorant|fortnite|roblox|gta|call of duty|cod|warzone|csgo|cs2|counter[- ]strike|league of legends|apex|overwatch|rocket league|fifa|ea fc|clash royale|clash of clans|brawl stars|among us|gameplay|let'?s play|speedrun|stream|twitch|funny|prank|memes?|compilation|fails|reacts?|reaction|vlogs?|mrbeast|tiktok|shorts|asmr|music video|official video|lyrics|songs?|playlist|album|movies?|trailer|episode|anime|highlights|nba|nfl|ufc|wwe|f1|unboxing|try not to laugh|drama|edits?)\b/i;

const locked = async () => {
  const s = await chrome.storage.local.get(["lockUntil", "session", "allowChannels", "allowQueries"]);
  return { on: (s.lockUntil ?? 0) > Date.now(), session: s.session, allowChannels: s.allowChannels ?? [], allowQueries: s.allowQueries ?? [] };
};

const norm = (q) => q.trim().toLowerCase().replace(/\s+/g, " ");

/** Is this search for studying? "study", "fun", or undefined when the words don't say. */
function judgeQuery(q) {
  if (STUDY.test(q)) return "study";
  if (FUN.test(q)) return "fun";
  return undefined;
}

/** Waits for the search results to show up, then checks what kind of videos the top few are. */
async function resultsLookStudy() {
  let links = [];
  for (let i = 0; i < 20 && links.length < 3; i++) {
    links = [...document.querySelectorAll('ytd-video-renderer a#thumbnail[href^="/watch"], a[href^="/watch?v="]')]
      .map((a) => a.getAttribute("href")).filter((h, j, all) => h && all.indexOf(h) === j);
    if (links.length < 3) await new Promise((r) => setTimeout(r, 300));
  }
  const top = links.slice(0, 5);
  if (!top.length) return true; // nothing to judge; don't get in the way
  const infos = await Promise.all(top.map((h) => videoInfo(new URL(h, location.origin).href).catch(() => null)));
  const study = infos.filter((i) => i && ALLOWED.includes(i.category)).length;
  return study >= 2;
}

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

function leave(to) {
  removeOverlay();
  // Back only if this tab came from another YouTube page; otherwise to the (feed-free) home page.
  if (to === "back" && sessionStorage.getItem("lockin.seen")) history.back();
  else location.href = "https://www.youtube.com/";
}

function showOverlay({ title, reason, session, allowChannel, allowQuery, leaveTo }) {
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
        ${allowChannel || allowQuery ? `<button class="lockin-ghost" data-act="allow">This is for studying</button>` : ""}
      </div>
      ${leaveTo ? `<p class="lockin-leave">Closing this in <b>${LEAVE_S}</b>s</p>` : ""}
    </div>`;
  document.documentElement.appendChild(overlay);
  overlay.querySelector('[data-act="back"]').onclick = () => leave(leaveTo ?? "back");
  // "Close it": the page shuts itself after a few seconds unless you say it's for studying.
  let leaveTimer = null;
  if (leaveTo) {
    const me = overlay;
    let left = LEAVE_S;
    const count = me.querySelector(".lockin-leave b");
    leaveTimer = setInterval(() => {
      if (overlay !== me) return clearInterval(leaveTimer);
      left--;
      if (count) count.textContent = String(Math.max(0, left));
      if (left <= 0) {
        clearInterval(leaveTimer);
        leave(leaveTo);
      }
    }, 1000);
  }
  const allowBtn = overlay.querySelector('[data-act="allow"]');
  if (allowBtn) {
    allowBtn.onclick = () => {
      clearInterval(leaveTimer);
      overlay.querySelector(".lockin-leave")?.remove();
      let left = WAIT_S;
      allowBtn.disabled = true;
      const tick = () => {
        if (!overlay) return;
        if (left <= 0) {
          allowBtn.disabled = false;
          allowBtn.textContent = allowChannel ? `Allow ${allowChannel.name}` : "Allow this search";
          allowBtn.onclick = async () => {
            if (allowChannel) {
              chrome.runtime.sendMessage({ kind: "allowChannel", channel: allowChannel.id }, () => {
                removeOverlay();
                document.querySelector("video")?.play();
              });
            } else {
              const { allowQueries = [] } = await chrome.storage.local.get("allowQueries");
              await chrome.storage.local.set({ allowQueries: [...allowQueries, allowQuery] });
              removeOverlay();
            }
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

/** Hides the home feed and puts a search prompt in its place. */
function setNoFeed(on) {
  document.documentElement.classList.toggle("lockin-nofeed", on);
  if (!on) {
    prompt?.remove();
    prompt = null;
    return;
  }
  if (prompt?.isConnected) return;
  prompt = document.createElement("div");
  prompt.className = "lockin-search-prompt";
  prompt.innerHTML = `
    <div class="lockin-ring small"></div>
    <h2>Your feed is hidden while you're locked in.</h2>
    <p>Search for what you're studying. Study videos play as normal.</p>
    <button>Search YouTube</button>`;
  prompt.querySelector("button").onclick = () => {
    const box = document.querySelector('input[name="search_query"], input#search');
    box?.focus();
    box?.click();
  };
  document.documentElement.appendChild(prompt);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function check() {
  const st = await locked();
  document.documentElement.classList.toggle("lockin-on", st.on);
  if (!st.on) {
    setNoFeed(false);
    removeOverlay();
    checkedFor = "";
    return;
  }
  const url = new URL(location.href);
  const key = url.pathname + url.search;
  if (key === checkedFor) return;
  if (checkedFor) sessionStorage.setItem("lockin.seen", "1");
  checkedFor = key;

  // Home: the feed is hidden, the search bar stays.
  setNoFeed(url.pathname === "/");
  if (url.pathname.startsWith("/feed/trending") || url.pathname.startsWith("/gaming") || url.pathname.startsWith("/feed/explore")) {
    showOverlay({
      title: "The feed is off for now.",
      reason: "Search for what you need to learn instead. Study videos still play.",
      session: st.session,
      leaveTo: "home",
    });
    return;
  }
  if (url.pathname === "/results") {
    removeOverlay();
    const q = norm(url.searchParams.get("search_query") ?? "");
    if (!q || st.allowQueries.includes(q)) return;
    let verdict = judgeQuery(q);
    if (!verdict) verdict = (await resultsLookStudy()) ? "study" : "fun";
    if (checkedFor !== key) return; // searched again meanwhile
    if (verdict === "study") return;
    showOverlay({
      title: "That search can wait.",
      reason: `<b>${escapeHtml(q)}</b> doesn't look like studying. Search for what you're learning instead.`,
      session: st.session,
      allowQuery: q,
      leaveTo: "home",
    });
    return;
  }
  if (url.pathname.startsWith("/shorts")) {
    showOverlay({ title: "No Shorts mid-session.", reason: "They're designed to keep you scrolling. Save them for later.", session: st.session, leaveTo: "home" });
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
        leaveTo: "back",
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
