// Apps Lock In closes during a round. The Guard finds what's installed; games and game launchers
// start switched on, chat and media start off, and anything else can be added by name.

export type InstalledApp = { name: string; exes: string[]; kind: "game" | "launcher" | "chat" | "media" | "other" };
export type AppRow = InstalledApp & { on: boolean; custom?: boolean };

const KEY = "lockin.apps";
type Saved = { on: Record<string, boolean>; added: InstalledApp[] };

export const KIND_LABEL: Record<string, string> = { game: "Game", launcher: "Game launcher", chat: "Chat", media: "Music and video", other: "App" };

function load(): Saved {
  try {
    return { on: {}, added: [], ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { on: {}, added: [] };
  }
}

export function saveApps(rows: AppRow[]) {
  const saved: Saved = {
    on: Object.fromEntries(rows.map((r) => [r.name, r.on])),
    added: rows.filter((r) => r.custom).map(({ name, exes, kind }) => ({ name, exes, kind })),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* works for this session, just isn't remembered */
  }
}

/** The list to show: distracting installed apps plus any the person added. */
export function buildRows(installed: InstalledApp[]): AppRow[] {
  const saved = load();
  const rows: AppRow[] = installed
    .filter((a) => a.kind !== "other")
    .map((a) => ({ ...a, on: saved.on[a.name] ?? (a.kind === "game" || a.kind === "launcher") }));
  for (const a of saved.added) {
    if (!rows.some((r) => r.name === a.name)) rows.push({ ...a, on: saved.on[a.name] ?? true, custom: true });
  }
  const order = ["game", "launcher", "chat", "media", "other"];
  return rows.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || x.name.localeCompare(y.name));
}

/** Turns "Discord" or "discord.exe" into a program name, or null. */
export function cleanExe(input: string): string | null {
  const t = input.trim().replace(/^.*[\\/]/, "");
  if (!t || /[<>:"|?*]/.test(t)) return null;
  return /\.exe$/i.test(t) ? t : `${t}.exe`;
}

export function closedExes(rows: AppRow[]): string[] {
  return [...new Set(rows.filter((r) => r.on).flatMap((r) => r.exes))];
}
