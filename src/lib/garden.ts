// The garden that keeps growing past your first plant.
// Everything here is worked out from your saved sessions, so it always matches your real hours.
// The only thing saved is which seed you picked for each plot.

import type { Session, Settings } from "./store";
import { longestRun } from "./badges";
import { minutesByDay, streak, totalHours } from "./stats";

/** Your first plant is fully grown at 12 h. After that, every new plant takes 10 h. */
export const HERO_HOURS = 12;
export const PLOT_HOURS = 10;
/** One seed drops into the jar for every 25 focused minutes. */
export const SEED_MIN = 25;

// ---------- seeds ----------

export type SpeciesId = "cactus" | "fern" | "lavender" | "monstera" | "bamboo" | "flytrap" | "lemon" | "bonsai" | "moonflower";

export interface Species {
  id: SpeciesId;
  name: string;
  seeds: number; // seeds in the jar before you can plant it
  line: string;
}

export const SPECIES: Species[] = [
  { id: "cactus", name: "Cactus", seeds: 0, line: "Tough, spiky, flowers when you least expect it." },
  { id: "fern", name: "Fern", seeds: 0, line: "Unrolls a new frond as you work." },
  { id: "lavender", name: "Lavender", seeds: 0, line: "Calm purple spikes. Smells like a good day." },
  { id: "monstera", name: "Monstera", seeds: 30, line: "Big split leaves. Very fancy." },
  { id: "bamboo", name: "Bamboo", seeds: 60, line: "Grows taller every session." },
  { id: "flytrap", name: "Venus flytrap", seeds: 100, line: "Snaps at distractions." },
  { id: "lemon", name: "Lemon tree", seeds: 150, line: "Real lemons once it's grown." },
  { id: "bonsai", name: "Bonsai", seeds: 220, line: "Patience, shaped into a tree." },
  { id: "moonflower", name: "Moonflower", seeds: 300, line: "Glows at night. Very rare." },
];

export const speciesById = (id: SpeciesId) => SPECIES.find((s) => s.id === id)!;
export const seedsAt = (hours: number) => Math.floor((hours * 60) / SEED_MIN + 1e-9);
export const unlockedSpecies = (seeds: number) => SPECIES.filter((s) => seeds >= s.seeds);
export const nextSpecies = (seeds: number) => SPECIES.find((s) => seeds < s.seeds) ?? null;

// ---------- pots ----------

export type PotId = "terracotta" | "painted" | "glazed" | "striped" | "marble" | "gold" | "crystal";

export interface PotDef {
  id: PotId;
  name: string;
  hours: number;
}

export const POTS: PotDef[] = [
  { id: "terracotta", name: "Terracotta", hours: 0 },
  { id: "painted", name: "Painted", hours: 20 },
  { id: "glazed", name: "Glazed", hours: 35 },
  { id: "striped", name: "Striped", hours: 55 },
  { id: "marble", name: "Marble", hours: 80 },
  { id: "gold", name: "Gold", hours: 120 },
  { id: "crystal", name: "Crystal", hours: 200 },
];

export const potAt = (hours: number): PotId => [...POTS].reverse().find((p) => hours >= p.hours)!.id;
export const nextPot = (hours: number) => POTS.find((p) => hours < p.hours) ?? null;

// ---------- plots ----------

export interface Plot {
  n: number; // 1 = the first plant after your original one
  species: SpeciesId | null; // null until you pick a seed
  startH: number;
  endH: number;
  growth: number; // 0 to 1
  pot: PotId; // the best pot you had when it was planted
}

export const plotStart = (n: number) => HERO_HOURS + (n - 1) * PLOT_HOURS;

/** Every plot opened so far, oldest first. The last one is still growing. */
export function plotsAt(hours: number, picks: (SpeciesId | null)[]): Plot[] {
  const out: Plot[] = [];
  for (let n = 1; plotStart(n) <= hours + 1e-9; n++) {
    const startH = plotStart(n);
    const endH = startH + PLOT_HOURS;
    out.push({ n, species: picks[n - 1] ?? null, startH, endH, growth: Math.min(1, (hours - startH) / PLOT_HOURS), pot: potAt(startH) });
  }
  return out;
}

/** The plot a new seed goes into: the oldest one still waiting for a pick. */
export const pickTarget = (plots: Plot[]) => plots.find((p) => !p.species) ?? null;

// ---------- saved picks ----------

const KEY = "lockin.garden";

export interface GardenSave {
  picks: (SpeciesId | null)[];
}

export function loadGarden(): GardenSave {
  try {
    const raw = localStorage.getItem(KEY);
    const g = raw ? (JSON.parse(raw) as Partial<GardenSave>) : {};
    return { picks: Array.isArray(g.picks) ? g.picks : [] };
  } catch {
    return { picks: [] };
  }
}

export function saveGarden(g: GardenSave) {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    /* storage blocked: keep it in memory */
  }
}

// ---------- visitors ----------

export type VisitorId = "bee" | "butterfly" | "hummingbird" | "ladybug" | "snail" | "frog" | "robin" | "hedgehog" | "cat";

export interface VisitorFacts {
  streakDays: number;
  bestStreak: number;
  goalDays: number;
  hours: number;
}

export interface VisitorDef {
  id: VisitorId;
  name: string;
  /** "streak" ones only visit while your streak lasts. "resident" ones move in for good. */
  kind: "streak" | "resident";
  how: string;
  has: (f: VisitorFacts) => boolean;
}

export const VISITORS: VisitorDef[] = [
  { id: "bee", name: "Bee", kind: "streak", how: "Visits while you're on a 3 day streak", has: (f) => f.streakDays >= 3 },
  { id: "butterfly", name: "Butterflies", kind: "streak", how: "Visit while you're on a 7 day streak", has: (f) => f.streakDays >= 7 },
  { id: "hummingbird", name: "Hummingbird", kind: "streak", how: "Visits while you're on a 14 day streak", has: (f) => f.streakDays >= 14 },
  { id: "ladybug", name: "Ladybug", kind: "resident", how: "Moves in when you first hit your daily goal", has: (f) => f.goalDays >= 1 },
  { id: "snail", name: "Snail", kind: "resident", how: "Moves in after 5 days of hitting your goal", has: (f) => f.goalDays >= 5 },
  { id: "frog", name: "Frog", kind: "resident", how: "Moves in after a 7 day streak", has: (f) => f.bestStreak >= 7 },
  { id: "robin", name: "Robin", kind: "resident", how: "Moves in at 50 hours", has: (f) => f.hours >= 50 },
  { id: "hedgehog", name: "Hedgehog", kind: "resident", how: "Moves in after 20 days of hitting your goal", has: (f) => f.goalDays >= 20 },
  { id: "cat", name: "Cat", kind: "resident", how: "Moves in after a 30 day streak", has: (f) => f.bestStreak >= 30 },
];

export function visitorFacts(sessions: Session[], settings: Settings, extraTodayMin = 0, now = Date.now()): VisitorFacts {
  const byDay = minutesByDay(sessions);
  const cur = streak(sessions, extraTodayMin, now).days;
  const best = Math.max(cur, longestRun([...byDay.entries()].filter(([, m]) => m >= 25).map(([k]) => k)));
  const goalDays = [...byDay.values()].filter((m) => m >= settings.dailyGoalMin).length;
  return { streakDays: cur, bestStreak: best, goalDays, hours: totalHours(sessions) + extraTodayMin / 60 };
}

export const visitorsFor = (f: VisitorFacts) => new Set(VISITORS.filter((v) => v.has(f)).map((v) => v.id));

// ---------- everything at once ----------

export interface GardenState {
  hours: number;
  plots: Plot[];
  current: Plot | null; // the plot still growing (null while the first plant is growing)
  target: Plot | null; // where the next seed you pick goes
  seeds: number;
  pot: PotId;
  facts: VisitorFacts;
  visitors: Set<VisitorId>;
}

export function gardenState(sessions: Session[], settings: Settings, picks: (SpeciesId | null)[], extraMin = 0, now = Date.now()): GardenState {
  const facts = visitorFacts(sessions, settings, extraMin, now);
  const hours = facts.hours;
  const plots = plotsAt(hours, picks);
  return {
    hours,
    plots,
    current: plots[plots.length - 1] ?? null,
    target: pickTarget(plots),
    seeds: seedsAt(hours),
    pot: potAt(hours),
    facts,
    visitors: visitorsFor(facts),
  };
}

export const hoursLeft = (h: number) => (h < 1 ? `${Math.max(1, Math.ceil(h * 60))} min` : `${Math.round(h * 10) / 10} h`);
