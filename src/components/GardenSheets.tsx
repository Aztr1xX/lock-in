import { useEffect } from "react";
import { type GardenState, type SpeciesId, POTS, SPECIES, VISITORS, speciesById } from "../lib/garden";
import GardenPlant from "./GardenPlant";
import Pot, { PotDefs } from "./Pot";
import SeedJar, { jarFill } from "./SeedJar";
import { Sprite } from "./Visitors";
import { IconClose } from "./Icons";
import { lower } from "../lib/words";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** Pick what your newest plot grows into. */
export function SeedPicker({ garden, onPick, onClose }: { garden: GardenState; onPick: (id: SpeciesId) => void; onClose: () => void }) {
  useEscape(onClose);
  const plot = garden.target;
  const used = new Set(garden.plots.map((p) => p.species).filter(Boolean));
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet seed-sheet" role="dialog" aria-modal="true" aria-labelledby="seed-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="seed-title">Pick a seed</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button>
        </header>
        {plot && (
          <p className="hint">
            This will be plant {plot.n + 1} in your garden. {plot.growth >= 1 ? "It's already fully grown, so it'll pop straight up." : `It's already ${Math.floor(plot.growth * 100)}% grown, so you'll see it straight away.`}
          </p>
        )}
        <div className="seed-grid">
          {SPECIES.map((s) => {
            const locked = garden.seeds < s.seeds;
            return (
              <button key={s.id} className={`seed-card ${locked ? "locked" : ""}`} disabled={locked} onClick={() => onPick(s.id)}>
                <GardenPlant species={s.id} growth={1} pot={plot?.pot ?? "terracotta"} size={88} />
                <b>{s.name}</b>
                <small>{locked ? `${s.seeds - garden.seeds} more seeds` : used.has(s.id) ? "In your garden" : s.line}</small>
              </button>
            );
          })}
        </div>
        <p className="privacy">You get a seed for every 25 minutes of focus. More seeds unlock rarer plants.</p>
      </aside>
    </div>
  );
}

/** Everything you can collect: seeds, pots and visitors. */
export function Collection({ garden, onClose }: { garden: GardenState; onClose: () => void }) {
  useEscape(onClose);
  const { fill, next } = jarFill(garden.seeds);
  const f = garden.facts;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet coll-sheet" role="dialog" aria-modal="true" aria-labelledby="coll-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="coll-title">Collection</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button>
        </header>

        <div className="coll-jar">
          <SeedJar seeds={garden.seeds} size={58} />
          <div>
            <b>{garden.seeds} seeds</b>
            <span>{next ? `${next.seeds - garden.seeds} more until ${lower(next.name)}` : "Every seed unlocked"}</span>
            <span className="growth"><span style={{ width: `${Math.max(3, fill * 100)}%` }} /></span>
          </div>
        </div>

        <section className="set-group">
          <h3>Seeds</h3>
          <div className="coll-grid">
            {SPECIES.map((s) => {
              const has = garden.seeds >= s.seeds;
              const grown = garden.plots.filter((p) => p.species === s.id).length;
              return (
                <div key={s.id} className={`coll-tile ${has ? "" : "locked"}`} title={s.line}>
                  <GardenPlant species={s.id} growth={1} size={58} />
                  <b>{s.name}</b>
                  <small>{has ? (grown ? `${grown} planted` : "Unlocked") : `${s.seeds} seeds`}</small>
                </div>
              );
            })}
          </div>
        </section>

        <section className="set-group">
          <h3>Pots</h3>
          <div className="coll-grid">
            {POTS.map((p) => {
              const has = garden.hours >= p.hours;
              return (
                <div key={p.id} className={`coll-tile ${has ? "" : "locked"} ${garden.pot === p.id ? "current" : ""}`}>
                  <svg viewBox="28 88 64 50" width="56" height="44" aria-hidden="true"><defs><PotDefs /></defs><Pot kind={p.id} /></svg>
                  <b>{p.name}</b>
                  <small>{has ? (garden.pot === p.id ? "Your newest" : "Unlocked") : `At ${p.hours} h`}</small>
                </div>
              );
            })}
          </div>
          <p className="hint">Your first plant always wears your newest pot. New plants get the best pot you had when you planted them.</p>
        </section>

        <section className="set-group">
          <h3>Visitors</h3>
          <div className="coll-grid">
            {VISITORS.map((v) => {
              const has = garden.visitors.has(v.id);
              const progress =
                v.id === "bee" || v.id === "butterfly" || v.id === "hummingbird" ? `${f.streakDays} day streak now`
                : v.id === "ladybug" || v.id === "snail" || v.id === "hedgehog" ? `${f.goalDays} goal ${f.goalDays === 1 ? "day" : "days"} so far`
                : v.id === "robin" ? `${Math.floor(f.hours)} h so far`
                : `Best streak ${f.bestStreak}`;
              return (
                <div key={v.id} className={`coll-tile ${has ? "" : "locked"}`} title={v.how}>
                  <span className="coll-sprite"><Sprite id={v.id} size={40} /></span>
                  <b>{v.name}</b>
                  <small>{has ? (v.kind === "streak" ? "Visiting now" : "Lives here") : v.how}</small>
                  {!has && <small className="coll-prog">{progress}</small>}
                </div>
              );
            })}
          </div>
          <p className="hint">Streak visitors come while your streak lasts. Residents move in for good.</p>
        </section>
      </aside>
    </div>
  );
}

export const speciesName = (id: SpeciesId | null) => (id ? speciesById(id).name : "Seedling");
