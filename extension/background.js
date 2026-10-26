importScripts("shared.js");

const RULE_BASE = 1000;

async function getState() {
  const s = await chrome.storage.local.get(["sites", "lockUntil", "session", "allowChannels"]);
  return {
    sites: s.sites ?? DEFAULT_SITES,
    lockUntil: s.lockUntil ?? 0,
    session: s.session ?? null,
    allowChannels: s.allowChannels ?? [],
  };
}

const isLocked = (st) => st.lockUntil > Date.now();

// The Windows game closer listens on this PC only. It's optional: if it isn't
// installed these calls just fail quietly.
const HELPER = "http://127.0.0.1:47821";

async function helperCall(path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(HELPER + path, {
      method: body ? "POST" : "GET",
      headers: { "X-LockIn": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function syncHelper() {
  const st = await getState();
  return helperCall("/session", { active: isLocked(st), lockUntil: st.lockUntil, subject: st.session?.subject ?? "" });
}

async function applyRules() {
  const st = await getState();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = isLocked(st)
    ? st.sites.map((domain, i) => ({
        id: RULE_BASE + i,
        priority: 1,
        action: {
          type: "redirect",
          redirect: { extensionPath: `/blocked.html?site=${encodeURIComponent(domain)}` },
        },
        condition: { requestDomains: [domain], resourceTypes: ["main_frame"] },
      }))
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  chrome.action.setBadgeText({ text: isLocked(st) ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#14945c" });
}

function matches(url, sites) {
  try {
    const host = new URL(url).hostname;
    return sites.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

// Tabs already open on a blocked site get bounced when a session starts.
async function sweepTabs() {
  const st = await getState();
  if (!isLocked(st)) return;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id && t.url && matches(t.url, st.sites)) {
      const host = new URL(t.url).hostname.replace(/^www\./, "");
      chrome.tabs.update(t.id, { url: chrome.runtime.getURL(`/blocked.html?site=${encodeURIComponent(host)}`) });
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg?.kind === "session") {
      const wasLocked = isLocked(await getState());
      if (msg.active) {
        await chrome.storage.local.set({ lockUntil: Date.now() + GRACE_MS, session: msg.session });
        await applyRules();
        if (!wasLocked) await sweepTabs();
      } else {
        await chrome.storage.local.set({ lockUntil: 0, session: null });
        await applyRules();
      }
      const helper = await syncHelper();
      reply({ ok: true, locked: !!msg.active, helper: !!helper });
    } else if (msg?.kind === "status") {
      const st = await getState();
      reply({ locked: isLocked(st), ...st });
    } else if (msg?.kind === "helperStatus") {
      reply({ helper: !!(await helperCall("/status")) });
    } else if (msg?.kind === "allowChannel") {
      const st = await getState();
      if (!st.allowChannels.includes(msg.channel)) {
        await chrome.storage.local.set({ allowChannels: [...st.allowChannels, msg.channel] });
      }
      reply({ ok: true });
    } else if (msg?.kind === "sitesChanged") {
      await applyRules();
      await sweepTabs();
      reply({ ok: true });
    }
  })();
  return true;
});

chrome.alarms.create("lockin-tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => {
  await applyRules();
  await syncHelper();
});
chrome.runtime.onStartup.addListener(() => applyRules());
chrome.runtime.onInstalled.addListener(() => applyRules());


// After an install, update or reload, tabs that were already open lose their content
// scripts, so an open Lock In tab couldn't reach the blocker until you refreshed it.
// Put the scripts straight back into every open tab instead.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id || !t.url || !/^https?:/.test(t.url)) continue;
    chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ["bridge.js"] }).catch(() => {});
    if (/^https:\/\/([a-z0-9-]+\.)*youtube\.com\//.test(t.url)) {
      chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ["youtube.css"] }).catch(() => {});
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["youtube.js"] }).catch(() => {});
    }
  }
});
