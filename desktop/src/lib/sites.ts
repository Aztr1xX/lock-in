// The sites Lock In blocks during a round. Most are on from the start; the person can switch any
// off and add their own. YouTube is special: it stays open for studying (search, channels and
// playlists work, the feed and fun videos don't).

export type Site = { id: string; name: string; hosts: string[]; on: boolean; note?: string; custom?: boolean };

export const DEFAULT_SITES: Site[] = [
  { id: "youtube", name: "YouTube", hosts: ["youtube.com"], on: true, note: "Study videos still play" },
  { id: "tiktok", name: "TikTok", hosts: ["tiktok.com"], on: true },
  { id: "instagram", name: "Instagram", hosts: ["instagram.com"], on: true },
  { id: "reddit", name: "Reddit", hosts: ["reddit.com", "redd.it"], on: true },
  { id: "x", name: "X (Twitter)", hosts: ["x.com", "twitter.com"], on: true },
  { id: "facebook", name: "Facebook", hosts: ["facebook.com", "fb.com"], on: true },
  { id: "snapchat", name: "Snapchat", hosts: ["snapchat.com"], on: true },
  { id: "pinterest", name: "Pinterest", hosts: ["pinterest.com"], on: true },
  { id: "twitch", name: "Twitch", hosts: ["twitch.tv"], on: true },
  { id: "kick", name: "Kick", hosts: ["kick.com"], on: true },
  { id: "netflix", name: "Netflix", hosts: ["netflix.com"], on: true },
  { id: "disney", name: "Disney+", hosts: ["disneyplus.com"], on: true },
  { id: "prime", name: "Prime Video", hosts: ["primevideo.com"], on: true },
  { id: "showmax", name: "Showmax", hosts: ["showmax.com"], on: true },
  { id: "9gag", name: "9GAG", hosts: ["9gag.com"], on: true },
  { id: "tumblr", name: "Tumblr", hosts: ["tumblr.com"], on: true },
  { id: "roblox", name: "Roblox", hosts: ["roblox.com"], on: true },
  { id: "chess", name: "Chess.com", hosts: ["chess.com", "lichess.org"], on: true },
  { id: "steam", name: "Steam store", hosts: ["store.steampowered.com", "steamcommunity.com"], on: true },
  { id: "discord", name: "Discord", hosts: ["discord.com"], on: false, note: "Off by default, since study groups use it" },
  { id: "whatsapp", name: "WhatsApp Web", hosts: ["web.whatsapp.com"], on: false },
  { id: "takealot", name: "Takealot", hosts: ["takealot.com"], on: false },
  { id: "amazon", name: "Amazon", hosts: ["amazon.com"], on: false },
];

const KEY = "lockin.sites";
type Saved = { on: Record<string, boolean>; custom: string[] };

/** Turns what someone typed into a bare site name, or null if it isn't one. */
export function cleanSite(input: string): string | null {
  let h = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "");
  h = h.split(/[/?#:]/)[0].replace(/\.$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || h.length > 253) return null;
  return h;
}

export function loadSites(): Site[] {
  let saved: Saved = { on: {}, custom: [] };
  try {
    saved = { on: {}, custom: [], ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    /* start from the defaults */
  }
  const list = DEFAULT_SITES.map((s) => ({ ...s, on: saved.on[s.id] ?? s.on }));
  for (const h of saved.custom) {
    const id = `custom:${h}`;
    list.push({ id, name: h, hosts: [h], on: saved.on[id] ?? true, custom: true });
  }
  return list;
}

export function saveSites(list: Site[]) {
  const saved: Saved = {
    on: Object.fromEntries(list.map((s) => [s.id, s.on])),
    custom: list.filter((s) => s.custom).map((s) => s.hosts[0]),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* works for this session, just isn't remembered */
  }
}

/** Every host to send to the Guard for the sites that are on. */
export function blockedHosts(list: Site[]): string[] {
  return [...new Set(list.filter((s) => s.on).flatMap((s) => s.hosts))];
}
