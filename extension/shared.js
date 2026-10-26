// Shared by the background worker and the popup.
const DEFAULT_SITES = [
  "twitch.tv", "poki.com", "crazygames.com", "miniclip.com", "roblox.com",
  "store.steampowered.com", "steamcommunity.com", "epicgames.com", "coolmathgames.com",
  "y8.com", "kongregate.com", "friv.com", "itch.io", "armorgames.com", "addictinggames.com",
];
// If the app tab closes without pressing End, blocking carries on for this long.
const GRACE_MS = 15 * 60 * 1000;
