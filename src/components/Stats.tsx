import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Session, Settings } from "../lib/store";
import { dayKey, fmtDur, MIN } from "../lib/timer";
import { minutesByDay, plantStage, startOfWeek, streak, STREAK_MIN, subjectMinutes, totalHours } from "../lib/stats";
import { subjectHue } from "../lib/content";
import Plant from "./Plant";
import Flower from "./Flower";
import { FLOWERS, flowersAt, nextFlower } from "../lib/flowers";
import {
  type GardenState, type PotId, POTS, VISITORS, HERO_HOURS, hoursLeft, nextPot, nextSpecies, plotStart, seedsAt, speciesById, visitorProgress,
} from "../lib/garden";
import GardenPlant from "./GardenPlant";
import Pot, { PotDefs } from "./Pot";
import SeedJar, { jarFill } from "./SeedJar";
import { Sprite } from "./Visitors";
import { aName } from "../lib/words";
import Timelapse from "./Timelapse";
import { BADGES, earned } from "../lib/badges";
import { IconBack, IconTrash } from "./Icons";

interface Props {
  sessions: Session[];
  settings: Settings;
  onBack: () => void;
  onDelete: (id: string) => void;
  garden: GardenState;
  onGarden: () => void;
  onPickSeed: () => void;
}

const WEEKS = 18;
const dayNames = ["Mon", "", "Wed", "", "Fri", "", "Sun"];

export default function Stats({ sessions, settings, onBack, onDelete, garden, onGarden, onPickSeed }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Session | null>(null);
  const now = Date.now();
  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPlaying(null);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [playing]);
  const week0 = startOfWeek(now);
  const weekMin = sessions.filter((s) => s.start >= week0).reduce((a, s) => a + s.focusMs / MIN, 0);
  const lastWeekMin = sessions.filter((s) => s.start >= week0 - 7 * 86_400_000 && s.start < week0).reduce((a, s) => a + s.focusMs / MIN, 0);
  // Compare with the same point last week, so a Monday isn't up against a whole week.
  const lastWeekSoFar = sessions.filter((s) => s.start >= week0 - 7 * 86_400_000 && s.start < now - 7 * 86_400_000).reduce((a, s) => a + s.focusMs / MIN, 0);
  const st = streak(sessions);
  const hours = totalHours(sessions);
  const stage = plantStage(hours);
  const rated = sessions.filter((s) => s.rating);
  const avgRating = rated.length ? rated.reduce((a, s) => a + (s.rating ?? 0), 0) / rated.length : 0;
  const subjects = subjectMinutes(sessions, week0);
  const maxSubject = Math.max(1, ...subjects.map(([, m]) => m));

  const byDay = useMemo(() => minutesByDay(sessions), [sessions]);
  const best = useMemo(() => {
    const keys = [...byDay.entries()].filter(([, m]) => m >= STREAK_MIN).map(([k]) => k).sort();
    let bestRun = 0, run = 0, prev: number | null = null;
    for (const k of keys) {
      const t = new Date(k + "T12:00").getTime();
      run = prev !== null && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1;
      bestRun = Math.max(bestRun, run);
      prev = t;
    }
    return bestRun;
  }, [byDay]);

  const grid = useMemo(() => {
    const start = week0 - (WEEKS - 1) * 7 * 86_400_000;
    return Array.from({ length: WEEKS }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => {
        const t = new Date(start);
        t.setDate(t.getDate() + w * 7 + d);
        const key = dayKey(t);
        return { key, min: byDay.get(key) ?? 0, future: t.getTime() > now, date: t };
      }),
    );
  }, [byDay, week0, now]);

  const cells = grid.flat().filter((c) => !c.future);
  const daysStudied = cells.filter((c) => c.min > 0).length;
  const bestDay = Math.max(0, ...cells.map((c) => c.min));
  const goalDays = cells.filter((c) => c.min >= settings.dailyGoalMin).length;
  // Focus heatmap: average camera focus score by weekday and hour.
  const heat = useMemo(() => {
    const sum = Array.from({ length: 7 }, () => Array(24).fill(0));
    const n = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const ses of sessions) for (const p of ses.trace ?? []) {
      const d = new Date(p.t);
      const wd = (d.getDay() + 6) % 7;
      sum[wd][d.getHours()] += p.s;
      n[wd][d.getHours()]++;
    }
    const cells = sum.map((row, wd) => row.map((v, h) => (n[wd][h] ? v / n[wd][h] : -1)));
    const used = cells.flat().some((v) => v >= 0);
    let best = { wd: -1, h: -1, v: -1 };
    cells.forEach((row, wd) => row.forEach((v, h) => { if (n[wd][h] >= 10 && v > best.v) best = { wd, h, v }; }));
    const hours = cells[0].map((_, h) => h).filter((h) => cells.some((row) => row[h] >= 0));
    const lo = hours.length ? Math.max(0, Math.min(...hours) - 1) : 8;
    const hi = hours.length ? Math.min(23, Math.max(...hours) + 1) : 22;
    return { cells, used, best, lo, hi };
  }, [sessions]);
  const got = earned(sessions, settings);
  const withLapse = [...sessions].filter((x) => x.frames).sort((a, b) => b.start - a.start).slice(0, 9);

  const level = (m: number) => (m <= 0 ? 0 : m < STREAK_MIN ? 1 : m < settings.dailyGoalMin / 2 ? 2 : m < settings.dailyGoalMin ? 3 : 4);
  const recent = [...sessions].sort((a, b) => b.start - a.start).slice(0, 12);
  const ratingTrend = [...rated].sort((a, b) => a.start - b.start).slice(-20);
  const weekDelta = weekMin - lastWeekSoFar;

  return (
    <div className="stats screen-enter">
      <header className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back to home">
          <IconBack />
          <span>Home</span>
        </button>
        <h1 className="stats-title">Your stats</h1>
        <span style={{ width: 80 }} />
      </header>

      {sessions.length === 0 ? (
        <div className="empty">
          <Plant stage={0} size={120} />
          <h2>Nothing here yet</h2>
          <p>Finish your first session and your hours, streak and garden will show up here.</p>
          <button className="big-btn" onClick={onBack}>Start a session</button>
        </div>
      ) : (
        <main className="stats-main">
          <section className="tiles">
            <div className="tile">
              <span className="tile-label">This week</span>
              <b>{fmtDur(weekMin * MIN)}</b>
              <small className={weekDelta >= 0 ? "up" : "down"}>
                {lastWeekSoFar > 0 ? (Math.abs(weekDelta) < 1 ? "Level with this time last week" : `${weekDelta > 0 ? "▲" : "▼"} ${fmtDur(Math.abs(weekDelta) * MIN)} vs this time last week`) : lastWeekMin > 0 ? `${fmtDur(lastWeekMin * MIN)} all last week` : !sessions.some((x) => x.start < week0 - 7 * 86_400_000) ? "First week, nice" : weekMin > 0 ? "Back at it this week" : "Fresh week, fresh start"}
              </small>
            </div>
            <div className="tile">
              <span className="tile-label">Streak</span>
              <b>{st.days} {st.days === 1 ? "day" : "days"}</b>
              <small>Best {best} {best === 1 ? "day" : "days"}</small>
            </div>
            <div className="tile">
              <span className="tile-label">All time</span>
              <b>{fmtDur(hours * 60 * MIN)}</b>
              <small>{sessions.length} {sessions.length === 1 ? "session" : "sessions"}</small>
            </div>
            <div className="tile">
              <span className="tile-label">Avg focus</span>
              <b>{avgRating ? avgRating.toFixed(1) : "–"}<span className="of"> / 5</span></b>
              <small>{rated.length} rated</small>
            </div>
          </section>

          <section className="panel">
            <h2>Every day you studied</h2>
            <div className="cal-row">
            <div className="cal-wrap">
              <div className="cal">
                <div className="cal-days">{dayNames.map((d, i) => <span key={i}>{d}</span>)}</div>
                {grid.map((week, w) => (
                  <div className="cal-week" key={w}>
                    {week.map((c) => (
                      <span
                        key={c.key}
                        className={`cal-cell l${c.future ? "x" : level(c.min)} ${c.key === dayKey(now) ? "today" : ""}`}
                        title={c.future ? "" : `${c.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}: ${fmtDur(c.min * MIN)}`}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <dl className="cal-facts">
              <div><dt>Days studied</dt><dd>{daysStudied} <small>of last {WEEKS * 7}</small></dd></div>
              <div><dt>Best day</dt><dd>{fmtDur(bestDay * MIN)}</dd></div>
              <div><dt>Goal hit</dt><dd>{goalDays} <small>{goalDays === 1 ? "day" : "days"}</small></dd></div>
            </dl>
            </div>
            <div className="legend">
              <span>Less</span>
              {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`cal-cell l${l}`} />)}
              <span>Goal hit</span>
            </div>
          </section>

          <GardenPanel garden={garden} stage={stage} weekMin={weekMin} onGarden={onGarden} onPickSeed={onPickSeed} />

          <div className="two-col">
            <section className="panel">
              <h2>Subjects this week</h2>
              {subjects.length === 0 ? (
                <p className="muted">No sessions yet this week.</p>
              ) : (
                <ul className="bars">
                  {subjects.map(([name, m]) => (
                    <li key={name} style={{ "--hue": subjectHue(name) } as React.CSSProperties}>
                      <span className="bar-name">{name}</span>
                      <span className="bar-track"><span style={{ width: `${(m / maxSubject) * 100}%` }} /></span>
                      <span className="bar-val">{fmtDur(m * MIN)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <UpNext garden={garden} />
          </div>

          <section className="panel">
            <h2>Flowers <span className="muted small-count">{flowersAt(hours).length} of {FLOWERS.length}</span></h2>
            <div className="flower-grid">
              {FLOWERS.map((f) => {
                const has = hours >= f.hours;
                return (
                  <div key={f.kind} className={`flower-tile ${has ? "" : "locked"}`} title={has ? f.line : `Unlocks at ${f.hours} hours`}>
                    <Flower kind={f.kind} size={48} locked={!has} />
                    <b>{has ? f.name : "???"}</b>
                    <small>{has ? `${f.hours} h` : `${Math.max(1, Math.ceil(f.hours - hours))} h to go`}</small>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <h2>Badges <span className="muted small-count">{got.size} of {BADGES.length}</span></h2>
            <div className="badge-grid">
              {BADGES.map((b) => (
                <div key={b.id} className={`badge ${got.has(b.id) ? "" : "locked"}`} title={b.how}>
                  <span className="badge-icon">{got.has(b.id) ? b.icon : "🔒"}</span>
                  <span><b>{b.name}</b><small>{b.how}</small></span>
                </div>
              ))}
            </div>
          </section>

          {heat.used && (
            <section className="panel">
              <h2>When you focus best</h2>
              <div className="heat-wrap">
                <div className="heat" style={{ gridTemplateColumns: `36px repeat(${heat.hi - heat.lo + 1}, minmax(18px, 1fr))` }}>
                  <span />
                  {Array.from({ length: heat.hi - heat.lo + 1 }, (_, i) => heat.lo + i).map((h) => (
                    <span key={h} className="heat-h">{h % 3 === 0 ? (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`) : ""}</span>
                  ))}
                  {heat.cells.map((row, wd) => (
                    <Fragment key={wd}>
                      <span className="heat-d">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][wd]}</span>
                      {row.slice(heat.lo, heat.hi + 1).map((v, i) => (
                        <span
                          key={`${wd}-${i}`}
                          className={`heat-c ${v < 0 ? "none" : ""}`}
                          style={{ "--s": Math.max(0, v) } as React.CSSProperties}
                          title={v < 0 ? "" : `${Math.round(v * 100)}% focused`}
                        />
                      ))}
                    </Fragment>
                  ))}
                </div>
              </div>
              {heat.best.v >= 0 && (
                <p className="hint">
                  Your sharpest slot so far: <b>{["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"][heat.best.wd]} around {new Date(2000, 0, 1, heat.best.h).toLocaleTimeString(undefined, { hour: "numeric" })}</b>, at {Math.round(heat.best.v * 100)}% focused.
                </p>
              )}
            </section>
          )}

          {withLapse.length > 0 && (
            <section className="panel">
              <h2>Time-lapses</h2>
              <div className="lapse-grid">
                {withLapse.map((x) => (
                  <button key={x.id} className="lapse-card" onClick={() => setPlaying(x)} style={{ "--hue": subjectHue(x.subject) } as React.CSSProperties}>
                    <span className="lapse-play" aria-hidden="true">▶</span>
                    <b>{x.subject}</b>
                    <small>{new Date(x.start).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · {fmtDur(x.focusMs)}</small>
                  </button>
                ))}
              </div>
              <p className="hint">Saved only in this browser on this PC.</p>
            </section>
          )}

          {ratingTrend.length >= 2 && (
            <section className="panel">
              <h2>How focused you felt</h2>
              <RatingChart sessions={ratingTrend} />
            </section>
          )}

          <section className="panel">
            <h2>Recent sessions</h2>
            <ul className="session-list">
              {recent.map((s) => (
                <li key={s.id} style={{ "--hue": subjectHue(s.subject) } as React.CSSProperties}>
                  <span className="chip-dot" />
                  <span className="sl-main">
                    <b>{s.subject}</b>
                    {s.goal && <span className="muted"> · {s.goal}</span>}
                    <small>{new Date(s.start).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</small>
                  </span>
                  <span className="sl-rating">{s.rating ? "●".repeat(s.rating) + "○".repeat(5 - s.rating) : ""}</span>
                  <span className="sl-dur">{fmtDur(s.focusMs)}</span>
                  {confirmId === s.id ? (
                    <button className="ghost-btn danger" onClick={() => { onDelete(s.id); setConfirmId(null); }}>Delete?</button>
                  ) : (
                    <button className="icon-btn small" aria-label="Delete session" onClick={() => setConfirmId(s.id)}><IconTrash /></button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </main>
      )}
      {playing && (
        <div className="gate" role="dialog" aria-modal="true" aria-label="Time-lapse" onClick={() => setPlaying(null)}>
          <div className="gate-card lapse-modal" onClick={(e) => e.stopPropagation()}>
            <h2>{playing.subject}</h2>
            <p>{new Date(playing.start).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })} · {fmtDur(playing.focusMs)} focused</p>
            <Timelapse sessionId={playing.id} durationMs={playing.end - playing.start} />
            <button className="ghost-btn" onClick={() => setPlaying(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RatingChart({ sessions }: { sessions: Session[] }) {
  const w = 640, h = 140, pad = { l: 28, r: 10, t: 10, b: 20 };
  const x = (i: number) => pad.l + (i / Math.max(1, sessions.length - 1)) * (w - pad.l - pad.r);
  const y = (r: number) => pad.t + ((5 - r) / 4) * (h - pad.t - pad.b);
  const pts = sessions.map((s, i) => [x(i), y(s.rating ?? 3)] as const);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0]},${h - pad.b} L${pts[0][0]},${h - pad.b} Z`;
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} className="rating-chart" role="img" aria-label="Focus rating per session">
        {[1, 2, 3, 4, 5].map((r) => (
          <g key={r}>
            <line x1={pad.l} x2={w - pad.r} y1={y(r)} y2={y(r)} className="grid" />
            <text x={pad.l - 10} y={y(r) + 4} className="axis" textAnchor="end">{r}</text>
          </g>
        ))}
        <path d={area} className="area" />
        <path d={line} className="line" />
        {pts.map(([px, py], i) => (
          <circle key={i} cx={px} cy={py} r={i === pts.length - 1 ? 5 : 3} className={i === pts.length - 1 ? "pt last" : "pt"} />
        ))}
        <text x={pad.l} y={h - 4} className="axis">Older</text>
        <text x={w - pad.r} y={h - 4} className="axis" textAnchor="end">Latest</text>
      </svg>
    </div>
  );
}

const potName = (id: PotId) => POTS.find((p) => p.id === id)!.name;

function PotIcon({ kind, size = 34 }: { kind: PotId; size?: number }) {
  return <svg viewBox="28 88 64 50" width={size} height={(size * 50) / 64} aria-hidden="true"><defs><PotDefs /></defs><Pot kind={kind} /></svg>;
}

/** Every plant you've grown, plus seeds, visitors and your newest pot. */
function GardenPanel({ garden, stage, weekMin, onGarden, onPickSeed }: { garden: GardenState; stage: number; weekMin: number; onGarden: () => void; onPickSeed: () => void }) {
  const { hours, plots, seeds } = garden;
  const flowers = flowersAt(hours).length;
  const grown = (hours >= HERO_HOURS ? 1 : 0) + plots.filter((p) => p.growth >= 1).length;
  const weekSeeds = seeds - seedsAt(Math.max(0, hours - weekMin / 60));
  const here = VISITORS.filter((v) => garden.visitors.has(v.id));
  // Start scrolled to the newest plants, since that's where things are happening.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rowRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  return (
    <section className="panel sg">
      <div className="sg-head">
        <h2>Your garden <span className="muted small-count">{1 + plots.length} {plots.length ? "plants" : "plant"}</span></h2>
        <button className="garden-walk" onClick={onGarden}>
          Walk in
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
        </button>
      </div>
      <div className="sg-row" ref={rowRef}>
        <div className="sg-plant">
          <Plant stage={stage} hours={hours} size={76} pot={garden.pot} />
          <b>First plant</b>
          <small>{stage >= 12 ? `${flowers} ${flowers === 1 ? "flower" : "flowers"}` : `Stage ${stage} of 12`}</small>
        </div>
        {plots.map((p) => (
          <div key={p.n} className={`sg-plant ${p.growth < 1 ? "growing" : ""}`}>
            <GardenPlant species={p.species} growth={p.growth} pot={p.pot} size={76} />
            <b>{p.species ? speciesById(p.species).name : "Seedling"}</b>
            {!p.species ? (
              <button className="sg-pick" onClick={onPickSeed}>Pick a seed</button>
            ) : p.growth >= 1 ? (
              <small>Grown at {p.endH} h</small>
            ) : (
              <>
                <span className="growth"><span style={{ width: `${Math.max(3, p.growth * 100)}%` }} /></span>
                <small>{Math.floor(p.growth * 100)}% grown</small>
              </>
            )}
          </div>
        ))}
        <div className="sg-plant sg-next">
          <span className="sg-plot" aria-hidden="true" />
          <b>Plant {plots.length + 2}</b>
          <small>Opens at {plotStart(plots.length + 1)} h</small>
        </div>
      </div>
      <div className="sg-facts">
        <div>
          <SeedJar seeds={seeds} size={26} />
          <span><b>{seeds}</b> seeds<small>{weekSeeds > 0 ? `+${weekSeeds} this week` : "1 per 25 min"}</small></span>
        </div>
        <div>
          <span className="sg-big" aria-hidden="true">🌿</span>
          <span><b>{grown}</b> fully grown<small>{grown === 1 ? "plant" : "plants"} so far</small></span>
        </div>
        <div>
          <span className="sg-sprites" aria-hidden="true">
            {here.length ? here.slice(0, 3).map((v) => <Sprite key={v.id} id={v.id} size={24} />) : <span className="sg-big">🐞</span>}
          </span>
          <span title={here.map((v) => v.name).join(", ")}><b>{here.length}</b> of {VISITORS.length} visitors<small>{here.length ? here.map((v) => v.name).join(", ") : "None yet"}</small></span>
        </div>
        <div>
          <PotIcon kind={garden.pot} />
          <span><b>{potName(garden.pot)}</b> pot<small>Your newest</small></span>
        </div>
      </div>
    </section>
  );
}

/** The next few things you'll unlock, closest first. */
function UpNext({ garden }: { garden: GardenState }) {
  const { hours, seeds, current: cur, facts } = garden;
  type Item = { key: string; icon: React.ReactNode; title: string; left: string; pct: number };
  const items: Item[] = [];

  if (cur) {
    items.push({
      key: "plot",
      icon: <GardenPlant species={cur.species} growth={1} pot={cur.pot} size={30} />,
      title: `${cur.species ? speciesById(cur.species).name : `Plant ${cur.n + 1}`} fully grown`,
      left: hoursLeft(cur.endH - hours),
      pct: cur.growth,
    });
  } else {
    items.push({ key: "hero", icon: <Plant stage={12} size={30} />, title: "First plant fully grown", left: hoursLeft(HERO_HOURS - hours), pct: hours / HERO_HOURS });
  }
  const sp = nextSpecies(seeds);
  if (sp) items.push({ key: "seed", icon: <GardenPlant species={sp.id} growth={1} size={30} />, title: `${sp.name} seed`, left: `${sp.seeds - seeds} seeds`, pct: jarFill(seeds).fill });
  const np = nextPot(hours);
  if (np) {
    const prev = [...POTS].reverse().find((p) => p.hours <= hours)!.hours;
    items.push({ key: "pot", icon: <PotIcon kind={np.id} size={30} />, title: `${np.name} pot`, left: hoursLeft(np.hours - hours), pct: (hours - prev) / (np.hours - prev) });
  }
  const nf = nextFlower(hours);
  if (nf) {
    const prev = flowersAt(hours).at(-1)?.hours ?? 0;
    items.push({ key: "flower", icon: <Flower kind={nf.kind} size={28} />, title: nf.name === "First bloom" ? "Your first flower" : `${aName(nf.name).replace(/^./, (c) => c.toUpperCase())}`, left: hoursLeft(nf.hours - hours), pct: (hours - prev) / (nf.hours - prev) });
  }
  // The visitor you're closest to.
  const next = VISITORS.filter((v) => !garden.visitors.has(v.id))
    .map((v) => ({ v, p: visitorProgress(v.id, facts) }))
    .sort((a, b) => b.p[0] / b.p[1] - a.p[0] / a.p[1])[0];
  if (next) {
    const need = next.p[1];
    // Frog and cat need a fresh run that long, so count from the streak you're on now.
    const have = next.v.id === "frog" || next.v.id === "cat" ? facts.streakDays : next.p[0];
    const gap = need - have;
    const id = next.v.id;
    const left = id === "robin" ? hoursLeft(gap)
      : id === "ladybug" || id === "snail" || id === "hedgehog" ? `${gap} goal ${gap === 1 ? "day" : "days"}`
      : `${gap} more ${gap === 1 ? "day" : "days"}`;
    items.push({ key: "visitor", icon: <Sprite id={id} size={28} />, title: `${next.v.name} ${next.v.kind === "streak" ? "visits" : "moves in"}`, left, pct: have / need });
  }
  items.sort((a, b) => b.pct - a.pct);

  return (
    <section className="panel">
      <h2>Coming up next</h2>
      <ul className="upnext">
        {items.map((it) => (
          <li key={it.key}>
            <span className="un-icon">{it.icon}</span>
            <span className="un-main">
              <b>{it.title}</b>
              <span className="growth"><span style={{ width: `${Math.max(3, Math.min(100, it.pct * 100))}%` }} /></span>
            </span>
            <small className="un-left">{it.left}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
