import { useEffect, useRef, useState } from "react";
import { type GardenState, HERO_HOURS, speciesById } from "../lib/garden";
import { plantStage } from "../lib/stats";
import { skyAt, skyVars } from "../lib/sky";
import Plant from "./Plant";
import GardenPlant from "./GardenPlant";
import SeedJar from "./SeedJar";

/** The plant you're growing right now, live during a session, with the seed jar beside it. */
export default function GrowWidget({ garden, rounds }: { garden: GardenState; rounds: number }) {
  const { hours, current: cur } = garden;
  const [pop, setPop] = useState(0);
  const [seedPop, setSeedPop] = useState(0);
  const lastRounds = useRef(rounds);
  const lastSeeds = useRef(garden.seeds);
  const sky = skyAt();

  // A finished round makes the plant do a happy little grow.
  useEffect(() => {
    if (rounds > lastRounds.current) setPop(Date.now());
    lastRounds.current = rounds;
  }, [rounds]);
  // Every 25 minutes a seed drops into the jar.
  useEffect(() => {
    if (garden.seeds > lastSeeds.current) setSeedPop(Date.now());
    lastSeeds.current = garden.seeds;
  }, [garden.seeds]);

  const growing = hours < HERO_HOURS;
  const pct = growing ? hours / HERO_HOURS : cur?.growth ?? 0;
  const name = growing ? "Your plant" : cur?.species ? speciesById(cur.species).name : "New seedling";

  return (
    <div className="grow-widget" title="Grows with every focused minute">
      <div className={`gw-mini ${pop ? "pop" : ""}`} key={pop} style={skyVars(sky)}>
        {growing ? (
          <Plant stage={plantStage(hours)} hours={hours} size={70} pot={garden.pot} />
        ) : (
          <GardenPlant species={cur?.species ?? null} growth={cur?.growth ?? 0} pot={cur?.pot} size={70} />
        )}
        {pop > 0 && <span className="grow-sparks" aria-hidden="true"><i /><i /><i /></span>}
      </div>
      <div className="grow-text">
        <b>{name}</b>
        <span className="growth"><span style={{ width: `${Math.max(3, Math.min(100, pct * 100))}%` }} /></span>
        <small>{Math.floor(pct * 100)}% grown</small>
      </div>
      <div className="grow-jar">
        <SeedJar seeds={garden.seeds} size={26} drop={seedPop} key={garden.seeds} />
        <small>{garden.seeds}</small>
        {seedPop > 0 && <span className="seed-plus" key={seedPop}>+1 seed</span>}
      </div>
    </div>
  );
}
