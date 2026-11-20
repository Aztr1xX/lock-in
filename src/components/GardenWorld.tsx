import { useEffect, useMemo, useRef, useState } from "react";
import type { Settings } from "../lib/store";
import {
  type GardenState, type Plot,
  HERO_HOURS, POTS, PLOT_HOURS, hoursLeft, nextPot, nextSpecies, plotStart, speciesById,
} from "../lib/garden";
import { plantStage } from "../lib/stats";
import { flowersAt } from "../lib/flowers";
import { skyAt, skyVars } from "../lib/sky";
import { chime, confetti } from "../lib/fx";
import Plant from "./Plant";
import GardenPlant from "./GardenPlant";
import SkyLayer from "./Sky";
import { Sprite } from "./Visitors";
import SeedJar from "./SeedJar";
import Shrubert, { useShrubMood } from "./Shrubert";
import { lower } from "../lib/words";

interface Props {
  garden: GardenState;
  settings: Settings;
  onPickSeed: () => void;
  onCollection: () => void;
  onBack: () => void;
}

// World layout, in pixels along the garden path.
const GATE_X = 90;
const SHED_X = 250;
const JAR_X = 430;
const SHRUB_X = 575;
const HERO_X = 740;
const POND_X = 930;
const PLOT_X0 = 1120;
const PLOT_GAP = 230;
const SPEED = 280;
const GROUND = 200;

type Thing =
  | { kind: "gate"; x: number }
  | { kind: "jar"; x: number }
  | { kind: "shrub"; x: number }
  | { kind: "hero"; x: number }
  | { kind: "pond"; x: number }
  | { kind: "plot"; x: number; plot: Plot }
  | { kind: "next"; x: number; n: number };

// What Shrubert says when you stop by. One line at a time: he's a shrub, not a chatbot.
function shrubLine(garden: GardenState, night: boolean) {
  const { shrub, hours } = garden;
  if (night) return pick(["Zzz… five more minutes.", "Mmh… is it morning?", "*snores in leaf*", "Zzz… photosynthesis…"]);
  const lines = [
    "Hi! I'm Shrubert.",
    "Every hour you focus, I get a bit bushier.",
    "Phones make me nervous. Just so you know.",
    "I hum when a round ends. Listen closely.",
    "Nice garden. I helped. Mostly by standing here.",
  ];
  if (shrub.next) lines.push(`${shrub.next.what} at ${shrub.next.hours} h. I can feel it coming.`);
  if (hours < 1) lines.push("I'm small now, but I believe in us.");
  if (shrub.berries) lines.push("Berry? Don't eat it, it's decorative.");
  if (shrub.crown) lines.push("Look at my golden flower. Look at it.");
  return pick(lines);
}
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];

const thanks: Record<string, string[]> = {
  any: ["Ahh, thank you!", "So refreshing.", "I feel taller already.", "Best gardener ever.", "Mmm, water."],
  hero: ["I was your first. Never forget.", "My flowers say hi."],
  cactus: ["I'm fine, honestly. But thanks.", "Careful, I'm pointy."],
  fern: ["Unrolling with joy."],
  lavender: ["Smell that? That's calm."],
  monstera: ["Look at my holes. Fancy, right?"],
  bamboo: ["Taller. Always taller."],
  flytrap: ["Got any flies? No? Okay.", "*snap*"],
  lemon: ["When life gives you lemons..."],
  bonsai: ["Patience, young gardener."],
  moonflower: ["I glow at night, you know."],
  seedling: ["What will I be? You decide!"],
};

export default function GardenWorld({ garden, settings, onPickSeed, onCollection, onBack }: Props) {
  const { hours, plots } = garden;
  const sky = useMemo(() => skyAt(), []);
  // The whole garden scales with the window height, so it fills a big screen nicely.
  const [win, setWin] = useState({ w: innerWidth, h: innerHeight });
  const scale = Math.max(0.75, Math.min(1.7, win.h / 640, win.w / 520));
  const vw = win.w / scale;
  const lastPlotX = PLOT_X0 + Math.max(0, plots.length - 1) * PLOT_GAP;
  const nextX = hours >= HERO_HOURS ? lastPlotX + PLOT_GAP : PLOT_X0;
  const worldW = Math.max(vw, nextX + 330);
  const hasFrog = garden.visitors.has("frog");

  const things = useMemo<Thing[]>(() => {
    const t: Thing[] = [{ kind: "gate", x: GATE_X }, { kind: "jar", x: JAR_X }, { kind: "shrub", x: SHRUB_X }, { kind: "hero", x: HERO_X }];
    if (hasFrog) t.push({ kind: "pond", x: POND_X });
    plots.forEach((p, i) => t.push({ kind: "plot", x: PLOT_X0 + i * PLOT_GAP, plot: p }));
    t.push({ kind: "next", x: nextX, n: plots.length + 1 });
    return t;
  }, [plots, nextX, hasFrog]);

  // Walking. Positions live in refs so the loop doesn't re-render the whole garden every frame.
  const pos = useRef({ x: GATE_X + 60, vx: 0, target: null as number | null, cam: 0, face: 1 });
  const keys = useRef({ left: false, right: false });
  const worldRef = useRef<HTMLDivElement>(null);
  const farRef = useRef<HTMLDivElement>(null);
  const midRef = useRef<HTMLDivElement>(null);
  const meRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState<number>(-1);
  const [walking, setWalking] = useState(false);
  const [watered, setWatered] = useState<{ i: number; line: string; n: number } | null>(null);
  const [petted, setPetted] = useState<{ id: string; n: number } | null>(null);
  const [moved, setMoved] = useState(false);
  const shrub = useShrubMood(sky.night);
  const [stir, setStir] = useState(0);

  useEffect(() => {
    const onResize = () => setWin({ w: innerWidth, h: innerHeight });
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    let raf = 0, last = performance.now();
    let nearNow = -1, walkNow = false;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const p = pos.current;
      let dir = (keys.current.right ? 1 : 0) - (keys.current.left ? 1 : 0);
      if (dir) p.target = null;
      else if (p.target !== null) {
        const d = p.target - p.x;
        if (Math.abs(d) < 4) p.target = null;
        else dir = Math.sign(d);
      }
      // Ease into and out of a walk so it never jerks.
      p.vx += (dir * SPEED - p.vx) * Math.min(1, dt * 9);
      if (!dir && Math.abs(p.vx) < 6) p.vx = 0;
      p.x = Math.max(40, Math.min(worldW - 40, p.x + p.vx * dt));
      if (dir) p.face = dir;
      const camTarget = Math.max(0, Math.min(worldW - vw, p.x - vw * 0.42));
      p.cam += (camTarget - p.cam) * Math.min(1, dt * 5);
      if (worldRef.current) worldRef.current.style.transform = `translate3d(${-p.cam * scale}px,0,0) scale(${scale})`;
      if (farRef.current) farRef.current.style.transform = `translate3d(${-p.cam * scale * 0.15}px,0,0)`;
      if (midRef.current) midRef.current.style.transform = `translate3d(${-p.cam * scale * 0.4}px,0,0)`;
      if (meRef.current) meRef.current.style.transform = `translate3d(${p.x}px,0,0) scaleX(${p.face})`;
      const isWalking = Math.abs(p.vx) > 20;
      if (isWalking !== walkNow) { walkNow = isWalking; setWalking(isWalking); }
      let best = -1, bestD = 95;
      things.forEach((th, i) => {
        const d = Math.abs(th.x - p.x);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best !== nearNow) { nearNow = best; setNear(best); }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [things, worldW, vw, scale]);

  const act = (i = near) => {
    const th = things[i];
    if (!th) return;
    if (th.kind === "plot" && !th.plot.species) return onPickSeed();
    if (th.kind === "next" || th.kind === "gate") return;
    if (th.kind === "jar") return onCollection();
    if (th.kind === "shrub") {
      // Awake, he hums a little tune for you. Asleep, he just stirs and mumbles.
      if (sky.night) setStir(Date.now());
      else {
        shrub.react("hum");
        if (settings.sound) chime.hum();
      }
      setWatered({ i, line: shrubLine(garden, sky.night), n: Date.now() });
      return;
    }
    if (th.kind === "pond") {
      setPetted({ id: "frog", n: Date.now() });
      return;
    }
    const sp = th.kind === "hero" ? "hero" : th.kind === "plot" ? th.plot.species ?? "seedling" : "any";
    const pool = [...(thanks[sp] ?? []), ...thanks.any];
    setWatered({ i, line: pool[Math.floor(Math.random() * pool.length)], n: Date.now() });
    if (settings.sound) chime.sparkle();
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || (tag === "BUTTON" && (e.code === "Space" || e.key === "Enter"))) return;
      if (document.querySelector(".sheet-backdrop")) return;
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") { keys.current.left = true; setMoved(true); e.preventDefault(); }
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") { keys.current.right = true; setMoved(true); e.preventDefault(); }
      if (e.code === "Space" || e.key === "e" || e.key === "E" || e.key === "Enter") { e.preventDefault(); if (!e.repeat) act(); }
      if (e.key === "Escape") onBack();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") keys.current.left = false;
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") keys.current.right = false;
    };
    const blur = () => { keys.current.left = keys.current.right = false; };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    return () => { removeEventListener("keydown", down); removeEventListener("keyup", up); removeEventListener("blur", blur); };
  });

  useEffect(() => {
    if (!watered) return;
    const id = setTimeout(() => setWatered(null), 2600);
    return () => clearTimeout(id);
  }, [watered]);
  useEffect(() => {
    if (!petted) return;
    const id = setTimeout(() => setPetted(null), 1600);
    return () => clearTimeout(id);
  }, [petted]);

  // Celebrate a fresh pick: the new plant pops in with confetti.
  const pickedCount = plots.filter((p) => p.species).length;
  const prevPicked = useRef(pickedCount);
  useEffect(() => {
    if (pickedCount > prevPicked.current) {
      const i = things.findIndex((t) => t.kind === "plot" && t.plot.n === pickedCount);
      const th = things[i];
      if (th) confetti({ x: (th.x - pos.current.cam) * scale, y: innerHeight - 330 * scale });
      if (settings.sound) chime.sparkle();
    }
    prevPicked.current = pickedCount;
  }, [pickedCount, things, settings.sound, scale]);

  const walkTo = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, .gw-thing-hit")) return;
    pos.current.target = e.clientX / scale + pos.current.cam;
    setMoved(true);
  };

  const th = things[near];
  const flowers = flowersAt(hours).length;
  const stage = plantStage(hours);
  const v = garden.visitors;
  const nightFlies = sky.stars > 0.4;

  return (
    <div className={`gw screen-enter ${sky.night ? "is-night" : ""}`} style={{ ...skyVars(sky), "--gpx": `${GROUND * scale}px` } as React.CSSProperties}>
      <SkyLayer sky={sky} />
      <div className="gw-layer gw-far" ref={farRef} aria-hidden="true">
        <svg viewBox="0 0 1600 300" preserveAspectRatio="none" style={{ width: win.w * 1.4 + worldW * scale * 0.15 }}>
          <path d="M0 210 C 150 120, 300 160, 420 130 S 700 80, 860 140 S 1150 100, 1300 150 S 1500 120, 1600 160 V 300 H 0 Z" fill="#7fb98a" />
          <path d="M0 250 C 200 190, 380 230, 560 200 S 900 170, 1100 215 S 1400 190, 1600 220 V 300 H 0 Z" fill="#6aaa76" />
        </svg>
      </div>
      <div className="gw-layer gw-mid" ref={midRef} aria-hidden="true" style={{ width: worldW * scale * 0.4 + win.w, scale: String(scale), transformOrigin: "0 100%" }}>
        {Array.from({ length: Math.ceil((worldW * 0.4 + win.w) / 260) }, (_, i) => (
          <span key={i} className={`tree t${i % 3}`} style={{ left: 190 + i * 260 + (i % 2 ? 60 : 0) }} />
        ))}
      </div>

      <div className="gw-world" ref={worldRef} style={{ width: worldW, height: win.h / scale, transform: `scale(${scale})` }} onPointerDown={walkTo}>
        <div className="gw-ground" />
        <div className="gw-fence" style={{ left: -200, width: GATE_X + 140 }} />
        <div className="gw-fence" style={{ left: GATE_X + 60, width: worldW - GATE_X - 140 }} />
        <div className="gw-path" />
        <div className="gw-front" />

        {/* gate */}
        <div className="gw-thing gw-gate" style={{ left: GATE_X }}>
          <Gate label={`${settings.name ? `${settings.name}'s` : "My"} garden`} />
        </div>

        {/* shed, with the cat on the roof */}
        <div className="gw-thing gw-shed" style={{ left: SHED_X }}>
          <svg viewBox="0 0 160 166" width="160" height="166" aria-hidden="true">
            <ellipse cx="80" cy="158" rx="78" ry="7" fill="rgba(0,0,0,0.16)" />
            <path d="M10 62 L80 14 L150 62 Z" fill="#c8664c" />
            <path d="M10 62 L80 14 L150 62" stroke="#a9503a" strokeWidth="5" fill="none" strokeLinejoin="round" />
            <rect x="22" y="58" width="116" height="92" fill="#f2d7a8" />
            {[34, 52, 70, 88, 106, 124].map((x) => <line key={x} x1={x} y1="60" x2={x} y2="150" stroke="#e2c18a" strokeWidth="2" />)}
            <rect x="18" y="146" width="124" height="10" rx="2" fill="#a7a097" />
            <rect x="18" y="146" width="124" height="3" rx="1.5" fill="#c4bdb2" />
            <rect x="62" y="88" width="36" height="58" rx="3" fill="#8f5a3c" />
            <circle cx="91" cy="118" r="2.4" fill="#ffd166" />
            <rect x="56" y="152" width="48" height="8" rx="3" fill="#bdb6ab" />
            <rect x="32" y="76" width="22" height="20" rx="2" fill="#bfe3ff" stroke="#fff" strokeWidth="3" />
            <rect x="108" y="76" width="22" height="20" rx="2" fill="#bfe3ff" stroke="#fff" strokeWidth="3" />
            <g className="shed-light"><rect x="32" y="76" width="22" height="20" rx="2" fill="#ffdc7a" /><rect x="108" y="76" width="22" height="20" rx="2" fill="#ffdc7a" /></g>
            {[29, 105].map((x) => (
              <g key={x}>
                <circle cx={x + 6} cy="99" r="3" fill="#ff8fb5" /><circle cx={x + 14} cy="98" r="3" fill="#ffd166" /><circle cx={x + 22} cy="99" r="3" fill="#ff8fb5" />
                <rect x={x} y="100" width="28" height="7" rx="2" fill="#a86b45" />
              </g>
            ))}
            <path d="M14 156 q 4 -12 10 -2 q 3 -10 8 0" fill="#57b06a" /><path d="M128 156 q 4 -12 9 -2 q 4 -9 9 0" fill="#57b06a" />
          </svg>
          {v.has("cat") && (
            <button className="gw-critter gw-cat gw-thing-hit" onClick={() => setPetted({ id: "cat", n: Date.now() })} aria-label="Cat">
              <Sprite id="cat" size={54} />
              <span className="zz">z<i>z</i></span>
            </button>
          )}
          {v.has("robin") && (
            <button className="gw-critter gw-robin gw-thing-hit" onClick={() => setPetted({ id: "robin", n: Date.now() })} aria-label="Robin">
              <Sprite id="robin" size={34} />
            </button>
          )}
        </div>

        {/* seed jar on a little stool */}
        <div className="gw-thing gw-jar" style={{ left: JAR_X }}>
          <button className="gw-thing-hit gw-jar-btn" onClick={onCollection} aria-label="Seed jar and collection">
            <SeedJar seeds={garden.seeds} size={78} />
            <span className="gw-stool" />
          </button>
        </div>

        {/* Shrubert, who lives here */}
        <div className="gw-thing gw-shrub" style={{ left: SHRUB_X }}>
          <button className="gw-thing-hit" onClick={() => act(things.findIndex((t) => t.kind === "shrub"))} aria-label="Shrubert">
            <span className={stir ? "shb-stir" : "shb-wrap"} key={stir}>
              <Shrubert shrub={garden.shrub} mood={shrub.mood} flash={shrub.flash} size={112} />
            </span>
          </button>
        </div>

        {/* your first plant */}
        <div className={`gw-thing gw-plant ${watered?.i === things.findIndex((t) => t.kind === "hero") ? "watered" : ""}`} style={{ left: HERO_X }}>
          <button className="gw-thing-hit" onClick={() => act(things.findIndex((t) => t.kind === "hero"))} aria-label="Your first plant">
            <Plant stage={stage} hours={hours} size={200} pot={garden.pot} />
          </button>
          {v.has("ladybug") && <span className="gw-ladybug"><Sprite id="ladybug" size={22} /></span>}
        </div>

        {hasFrog && (
          <div className="gw-thing gw-pond" style={{ left: POND_X }}>
            <span className="pond" />
            <button className="gw-critter gw-frog gw-thing-hit" onClick={() => setPetted({ id: "frog", n: Date.now() })} aria-label="Frog">
              <Sprite id="frog" size={44} />
            </button>
          </div>
        )}

        {plots.map((p, i) => {
          const idx = things.findIndex((t) => t.kind === "plot" && t.plot.n === p.n);
          return (
            <div key={`${p.n}-${p.species ?? "x"}`} className={`gw-thing gw-plant ${watered?.i === idx ? "watered" : ""} ${p.growth < 1 ? "growing" : ""}`} style={{ left: PLOT_X0 + i * PLOT_GAP }}>
              <button className="gw-thing-hit" onClick={() => act(idx)} aria-label={p.species ? speciesById(p.species).name : "Seedling waiting for a seed"}>
                <GardenPlant species={p.species} growth={p.growth} pot={p.pot} size={190} />
              </button>
              {p.growth < 1 && <span className="gw-growing-tag">{Math.floor(p.growth * 100)}%</span>}
              {i === plots.length - 1 && v.has("hedgehog") && (
                <button className="gw-critter gw-hedgehog gw-thing-hit" onClick={() => setPetted({ id: "hedgehog", n: Date.now() })} aria-label="Hedgehog">
                  <Sprite id="hedgehog" size={40} />
                </button>
              )}
            </div>
          );
        })}

        {/* the next plot, waiting */}
        <div className="gw-thing gw-next" style={{ left: nextX }}>
          <svg viewBox="0 0 160 130" width="160" height="130" aria-hidden="true">
            <ellipse cx="80" cy="118" rx="58" ry="10" fill="#8a5a3b" />
            <ellipse cx="80" cy="115" rx="52" ry="7" fill="#a06a45" />
            <line x1="112" y1="118" x2="112" y2="52" stroke="#b08a5a" strokeWidth="4" />
            <rect x="72" y="30" width="80" height="34" rx="6" fill="#fff8ec" stroke="#d9c3a0" strokeWidth="1.5" />
            <text x="112" y="45" textAnchor="middle" fontSize="11" fontWeight="800" fill="#6a4a2a">Plant {plots.length + 2}</text>
            <text x="112" y="58" textAnchor="middle" fontSize="9.5" fontWeight="600" fill="#9a7a5a">opens at {plotStart(plots.length + 1)} h</text>
          </svg>
        </div>

        {v.has("snail") && (
          <span className="gw-snail" style={{ left: HERO_X + 70 }}>
            <Sprite id="snail" size={34} />
          </span>
        )}

        {/* streak visitors flutter around your newest plants (they sleep at night) */}
        {!nightFlies && v.has("bee") && <span className="gw-flyer fly-a" style={{ left: HERO_X + 30 }}><Sprite id="bee" size={30} /></span>}
        {!nightFlies && v.has("butterfly") && <span className="gw-flyer fly-b" style={{ left: lastPlotX - 20 }}><Sprite id="butterfly" size={34} /></span>}
        {!nightFlies && v.has("butterfly") && <span className="gw-flyer fly-c" style={{ left: HERO_X + 260 }}><Sprite id="butterfly" size={28} /></span>}
        {!nightFlies && v.has("hummingbird") && <span className="gw-flyer fly-d" style={{ left: PLOT_X0 + 40 }}><Sprite id="hummingbird" size={40} /></span>}

        {nightFlies && Array.from({ length: Math.ceil(worldW / 140) }, (_, i) => (
          <span key={i} className="gw-firefly" style={{ left: 60 + i * 140 + (i % 3) * 30, bottom: `calc(var(--ground) + ${50 + ((i * 53) % 160)}px)`, animationDelay: `${(i % 5) * 0.9}s` }}>
            <Sprite id="firefly" size={14} />
          </span>
        ))}

        {/* the gardener: you */}
        <div className={`gw-me ${walking ? "walking" : ""} ${watered ? "watering" : ""}`} ref={meRef}>
          <Gardener />
        </div>

        {watered && things[watered.i] && (
          <p className={`gw-bubble ${things[watered.i].kind === "shrub" ? "low" : ""}`} key={watered.n} style={{ left: things[watered.i].x }}>{watered.line}</p>
        )}
        {petted && (
          <p className="gw-bubble heart" key={petted.n} style={{ left: critterX(petted.id) }}>
            {petted.id === "cat" ? "purr…" : petted.id === "frog" ? "ribbit!" : petted.id === "robin" ? "tweet!" : "sniff sniff"} <span>♥</span>
          </p>
        )}
      </div>

      <header className="gw-top">
        <button className="gw-back" onClick={onBack} aria-label="Back home">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          Home
        </button>
        <div className="gw-chips">
          <span className="gw-chip">{sky.name}</span>
          <span className="gw-chip"><b>{1 + plots.length}</b> {plots.length ? "plants" : "plant"}</span>
          <button className="gw-chip gw-chip-btn" onClick={onCollection}><b>{garden.seeds}</b> seeds · Collection</button>
        </div>
      </header>

      {!moved && <p className="gw-hint">Walk with <kbd>←</kbd> <kbd>→</kbd> or click the path · <kbd>Space</kbd> to water</p>}

      <div className="gw-card-wrap">
        {th && <InfoCard key={near} thing={th} garden={garden} flowers={flowers} stage={stage} night={sky.night} onPick={onPickSeed} onCollection={onCollection} onWater={() => act()} />}
      </div>
    </div>
  );

  function critterX(id: string) {
    if (id === "cat") return SHED_X + 100;
    if (id === "robin") return SHED_X + 10;
    if (id === "frog") return POND_X + 30;
    return lastPlotX + 70;
  }
}

function InfoCard({ thing, garden, flowers, stage, night, onPick, onCollection, onWater }: {
  thing: Thing; garden: GardenState; flowers: number; stage: number; night: boolean; onPick: () => void; onCollection: () => void; onWater: () => void;
}) {
  const sky = { night };
  const { hours } = garden;
  let title = "", body = "", action: { label: string; run: () => void } | null = null, pct: number | null = null;
  if (thing.kind === "gate") {
    title = "Welcome in";
    body = "Every hour you focus grows something here. Walk right to see it all.";
  } else if (thing.kind === "jar") {
    const ns = nextSpecies(garden.seeds);
    title = `Seed jar · ${garden.seeds} seeds`;
    body = ns ? `A seed drops in for every 25 focused minutes. ${ns.seeds - garden.seeds} more to unlock ${lower(ns.name)}.` : "A seed for every 25 minutes. You've unlocked every seed!";
    action = { label: "Open collection", run: onCollection };
  } else if (thing.kind === "shrub") {
    const sh = garden.shrub;
    title = `Shrubert · ${sh.stage.name.toLowerCase()}`;
    body = sky.night
      ? "Fast asleep until the sun comes up. He's still growing, though."
      : sh.next
        ? `Gets bushier with every hour you focus. ${sh.next.what} at ${sh.next.hours} h, that's ${hoursLeft(sh.next.hours - hours)} away.`
        : "As bushy as a shrub can get. Golden flower and everything.";
    pct = sh.next ? sh.toNext : null;
    action = { label: sky.night ? "Tiptoe past" : "Say hi", run: onWater };
  } else if (thing.kind === "hero") {
    const np = nextPot(hours);
    title = "Your first plant";
    body = stage < 12
      ? `Stage ${stage} of 12. ${hoursLeft(12 - hours)} until it's fully grown.`
      : `${flowers} ${flowers === 1 ? "flower" : "flowers"} so far. ${POTS.find((p) => p.id === garden.pot)!.name} pot${np ? `, ${lower(np.name)} pot at ${np.hours} h` : ""}.`;
    action = { label: "Water", run: onWater };
  } else if (thing.kind === "pond") {
    title = "Frog pond";
    body = "Your frog moved in after a 7 day streak.";
  } else if (thing.kind === "plot") {
    const p = thing.plot;
    pct = p.growth;
    if (!p.species) {
      title = `Plant ${p.n + 1} · seedling`;
      body = p.growth >= 1 ? "Fully grown and still waiting. Pick what it becomes." : `Already ${Math.floor(p.growth * 100)}% grown. Pick what it becomes.`;
      action = { label: "Pick a seed", run: onPick };
    } else {
      const sp = speciesById(p.species);
      title = sp.name;
      body = p.growth >= 1
        ? `Fully grown. Planted at ${p.startH} h, done at ${p.endH} h.`
        : `${Math.floor(p.growth * 100)}% grown. ${hoursLeft(p.endH - hours)} of focus until it's fully grown.`;
      action = { label: "Water", run: onWater };
    }
  } else if (thing.kind === "next") {
    const start = plotStart(thing.n);
    title = `Plant ${thing.n + 1}`;
    body = hours >= HERO_HOURS
      ? `This spot opens when your newest plant is fully grown, at ${start} h. That's ${hoursLeft(start - hours)} of focus away.`
      : `Opens at ${HERO_HOURS} h, when your first plant is fully grown. Then you pick a seed.`;
    pct = hours >= HERO_HOURS ? 1 - (start - hours) / PLOT_HOURS : hours / HERO_HOURS;
  }
  return (
    <div className="gw-card" role="status">
      <b>{title}</b>
      <span>{body}</span>
      {pct !== null && <span className="growth"><span style={{ width: `${Math.max(3, Math.min(100, pct * 100))}%` }} /></span>}
      {action && <button className="gw-card-btn" onClick={action.run}>{action.label} <kbd>Space</kbd></button>}
    </div>
  );
}

/** The arch at the way in, with a little sign hanging from it. */
function Gate({ label }: { label: string }) {
  const font = label.length > 18 ? 10 : 12;
  const w = Math.min(150, Math.max(92, Math.round(label.length * font * 0.6 + 26)));
  const leaves = [[30, 112], [34, 90], [40, 70], [52, 54], [118, 54], [130, 70], [136, 90], [140, 112]];
  return (
    <svg viewBox="0 0 170 200" width="170" height="200" aria-hidden="true">
      <ellipse cx="25" cy="194" rx="20" ry="5" fill="rgba(0,0,0,0.16)" />
      <ellipse cx="145" cy="194" rx="20" ry="5" fill="rgba(0,0,0,0.16)" />
      {/* posts */}
      {[17, 137].map((x) => (
        <g key={x}>
          <rect x={x} y="96" width="16" height="98" rx="2" fill="#f3eadb" />
          <rect x={x + 11} y="96" width="5" height="98" fill="#e2d5bf" />
          <rect x={x - 3} y="90" width="22" height="9" rx="2.5" fill="#fffaf0" />
        </g>
      ))}
      {/* arch */}
      <path d="M25 96 C 25 30, 145 30, 145 96" stroke="#e2d5bf" strokeWidth="14" fill="none" />
      <path d="M25 96 C 25 30, 145 30, 145 96" stroke="#f9f2e4" strokeWidth="9" fill="none" />
      {/* vine */}
      <path d="M25 140 C 18 120, 32 110, 25 96 C 25 30, 145 30, 145 96 C 138 110, 152 120, 145 140" stroke="#3f9a55" strokeWidth="2.4" fill="none" />
      {leaves.map(([x, y], i) => (
        <ellipse key={i} cx={x} cy={y} rx="6" ry="3.4" fill={i % 2 ? "#57b06a" : "#4aa35e"} transform={`rotate(${(i - 3.5) * 22} ${x} ${y})`} />
      ))}
      {[[36, 78, "#ff8fb5"], [46, 60, "#ffd166"], [124, 60, "#ff8fb5"], [134, 78, "#ffd166"], [24, 128, "#b79cf2"], [146, 124, "#ff8fb5"]].map(([x, y, c], i) => (
        <g key={i}><circle cx={x} cy={y} r="4.5" fill={c as string} /><circle cx={x} cy={y} r="1.6" fill="#fff6d6" /></g>
      ))}
      {/* sign across the top, with a flower on each end */}
      <rect x={85 - w / 2} y="30" width={w} height="28" rx="7" fill="#c99a68" />
      <rect x={85 - w / 2 + 2.5} y="32.5" width={w - 5} height="23" rx="5" fill="#fff8ec" />
      <text x="85" y={44.5 + font * 0.36} textAnchor="middle" fontSize={font} fontWeight="800" fill="#6a4a2a">{label}</text>
      {[85 - w / 2, 85 + w / 2].map((x) => (
        <g key={x}><circle cx={x} cy="31" r="5.5" fill="#ff8fb5" /><circle cx={x} cy="31" r="2" fill="#fff6d6" /></g>
      ))}
      {/* bush at each foot */}
      <path d="M6 196 q 2 -16 14 -12 q 6 -10 14 0 q 10 -4 10 12 Z" fill="#4c9a4f" />
      <path d="M126 196 q 2 -16 14 -12 q 6 -10 14 0 q 10 -4 10 12 Z" fill="#4c9a4f" />
    </svg>
  );
}

/** You: a little sprout with feet. */
function Gardener() {
  return (
    <svg viewBox="-30 -70 60 74" width="62" height="76" aria-hidden="true" className="gardener">
      <ellipse cx="0" cy="2" rx="16" ry="3.5" fill="rgba(0,0,0,0.22)" />
      <g className="g-legs">
        <rect className="g-leg l" x="-8" y="-12" width="6" height="13" rx="3" fill="#2f8f63" />
        <rect className="g-leg r" x="2" y="-12" width="6" height="13" rx="3" fill="#2f8f63" />
      </g>
      <g className="g-body">
        <g className="g-sprout">
          <path d="M0 -46 q -1 -8 1 -13" stroke="#2f8f63" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <path d="M1 -58 q -10 -9 -15 -2 q 7 6 15 2" fill="#4fcf8a" />
          <path d="M1 -58 q 9 -11 15 -4 q -6 7 -15 4" fill="#3fbb7b" />
        </g>
        <ellipse cx="0" cy="-27" rx="17" ry="20" fill="#5ee0a0" />
        <ellipse cx="0" cy="-20" rx="11" ry="10" fill="#9af0c4" opacity="0.6" />
        <g className="g-eyes">
          <ellipse cx="3" cy="-32" rx="2.2" ry="3" fill="#10201a" />
          <ellipse cx="11" cy="-32" rx="2.2" ry="3" fill="#10201a" />
          <circle cx="3.7" cy="-33.2" r="0.8" fill="#fff" />
          <circle cx="11.7" cy="-33.2" r="0.8" fill="#fff" />
        </g>
        <circle cx="-1" cy="-25" r="2.4" fill="#ff9aa8" opacity="0.7" />
        <circle cx="15" cy="-25" r="2" fill="#ff9aa8" opacity="0.7" />
        <path d="M5 -25 q 2.5 2 5 0" stroke="#10201a" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        <g className="g-can">
          <path d="M10 -24 h14 v12 a2 2 0 0 1 -2 2 h-10 a2 2 0 0 1 -2 -2 z" fill="#7cc4ff" />
          <path d="M24 -21 l9 -7" stroke="#7cc4ff" strokeWidth="3" strokeLinecap="round" />
          <path d="M12 -26 q 5 -6 10 0" stroke="#5aa8e8" strokeWidth="2" fill="none" />
          <g className="drops" fill="#7cc4ff">
            <circle cx="35" cy="-24" r="1.6" /><circle cx="37" cy="-18" r="1.4" /><circle cx="34" cy="-13" r="1.5" />
          </g>
        </g>
      </g>
    </svg>
  );
}
