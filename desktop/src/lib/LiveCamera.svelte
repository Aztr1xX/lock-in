<script lang="ts">
  // Live camera check (camera plan, step 2). The camera is read by the app's core, not this
  // window, so the check keeps running when the window is minimised or closed to the tray.
  import { onMount } from "svelte";
  import {
    DEFAULT_CHECK, describe, duration, listCameras, listChecks, onLive, onTile, preferred, setPreview, startLive, startPeek, stopLive, stopPeek,
    type Camera, type LiveEvent, type Seen, type State, type Stats, type Update,
  } from "./live";

  let { text = $bindable("") }: { text?: string } = $props();

  const KEY = "lockin.mfcamera";
  const saved = () => {
    try {
      return localStorage.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  };

  let cams = $state<Camera[]>([]);
  let checks = $state<string[]>([]);
  let camera = $state<Camera | null>(null);
  let check = $state(DEFAULT_CHECK);
  let gpu = $state(true);
  let phone = $state(true);
  let loadError = $state("");

  // ---------- picker ----------
  let picking = $state(false);
  let tiles = $state<Record<string, { jpeg?: string; sees?: boolean; problem?: string }>>({});
  let forced = $state<string[]>([]); // cameras opened anyway while Broadcast is present

  async function openPicker() {
    await stop();
    picking = true;
    tiles = {};
    await peek();
  }
  async function peek() {
    const ids = cams.filter((c) => c.auto || forced.includes(c.id)).map((c) => c.id);
    try {
      await startPeek(ids, checks.includes(check) ? check : (checks[0] ?? null));
    } catch (e) {
      loadError = String(e);
    }
  }
  async function showAnyway(id: string) {
    forced = [...forced, id];
    await peek();
  }
  function choose(c: Camera) {
    camera = c;
    try {
      localStorage.setItem(KEY, c.id);
    } catch {
      /* it just won't be remembered */
    }
  }
  async function closePicker() {
    picking = false;
    await stopPeek();
  }

  // ---------- live check ----------
  type Phase = "off" | "starting" | "running";
  let phase = $state<Phase>("off");
  let started = $state<Extract<Update, { type: "started" }> | null>(null);
  let startedAt = 0;
  let st = $state<State | null>(null);
  let stats = $state<Stats | null>(null);
  let seen = $state<Seen | null>(null);
  let picture = $state("");
  let brightness = $state(0);
  let log = $state<{ at: number; text: string; kind: LiveEvent["kind"] }[]>([]);
  let problem = $state("");
  let counts = $state({ away: 0, phone: 0, interrupt: 0, covered: 0 });

  async function start() {
    if (!camera) return;
    phase = "starting";
    problem = "";
    log = [];
    counts = { away: 0, phone: 0, interrupt: 0, covered: 0 };
    stats = null;
    st = null;
    seen = null;
    picture = "";
    try {
      if (picking) await closePicker();
      await startLive({ camera, check, gpu, phone });
    } catch (e) {
      problem = String(e);
      phase = "off";
    }
  }
  async function stop() {
    if (phase === "off") return;
    await stopLive().catch(() => {});
    phase = "off";
  }

  function handle(u: Update) {
    switch (u.type) {
      case "started":
        started = u;
        startedAt = Date.now();
        phase = "running";
        setPreview(visible);
        break;
      case "check":
        st = u.state;
        stats = u.stats;
        seen = u.seen;
        brightness = u.brightness;
        if (u.preview) picture = `data:image/jpeg;base64,${u.preview}`;
        break;
      case "events":
        for (const e of u.events) {
          log = [{ at: startedAt + e.at * 1000, text: describe(e), kind: e.kind }, ...log].slice(0, 12);
          if (e.kind === "away") counts.away++;
          if (e.kind === "phone_start") counts.phone++;
          if (e.kind === "interrupt_start") counts.interrupt++;
          if (e.kind === "health" && e.health !== "ok") counts.covered++;
        }
        break;
      case "problem":
        problem = u.message;
        if (u.fatal) phase = "off";
        break;
      case "stopped":
        stats = u.stats;
        phase = "off";
        break;
    }
  }

  // Preview pictures only while this part of the window can be seen.
  let box = $state<HTMLElement>();
  let visible = $state(false);
  $effect(() => {
    if (phase === "running") setPreview(visible);
  });

  onMount(() => {
    const offs = [onLive(handle), onTile((t) => {
      const cur = tiles[t.id] ?? {};
      tiles[t.id] = t.type === "picture" ? { ...cur, jpeg: `data:image/jpeg;base64,${t.jpeg}`, problem: undefined } : t.type === "sees" ? { ...cur, sees: t.person } : { ...cur, problem: t.message };
    })];
    (async () => {
      try {
        [cams, checks] = await Promise.all([listCameras(), listChecks()]);
        camera = preferred(cams, saved());
        if (!checks.includes(check)) check = checks[0] ?? check;
      } catch (e) {
        loadError = String(e);
      }
    })();
    let onScreen = false;
    const vis = () => (visible = onScreen && document.visibilityState === "visible");
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      vis();
    });
    if (box) io.observe(box);
    document.addEventListener("visibilitychange", vis);
    return () => {
      offs.forEach((p) => p.then((f) => f()));
      io.disconnect();
      document.removeEventListener("visibilitychange", vis);
      stopPeek();
    };
  });

  const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const W = $derived(started?.width || 640);
  const H = $derived(started?.height || 480);
  const healthText = $derived(st?.health === "covered" ? "Your camera looks covered" : st?.health === "frozen" ? "The camera picture froze" : "");
  const minutesHidden = $derived(stats ? stats.hidden_secs / 60 : 0);

  // Plain-text results for pasting into the chat.
  $effect(() => {
    if (!stats || !started) return;
    const s = stats;
    text = [
      `Live camera check: ${started.camera}, ${started.check} on the ${started.engine === "gpu" ? "graphics chip" : "CPU"}, sandbox ${started.sandbox.on ? "on" : `OFF (${started.sandbox.error ?? ""})`}.`,
      `  Ran ${duration(s.running_secs)}: ${s.checks} checks (${s.failed_checks} failed), ${s.check_ms.toFixed(0)} ms each, ${s.rate} a second${s.core_pct != null ? `, ${s.core_pct.toFixed(1)}% of one core (models ${s.worker_pct?.toFixed(1)}%, camera and app ${s.app_pct?.toFixed(1)}%)` : ""}, worker restarts ${s.worker_restarts}.`,
      `  Minimised or hidden: ${duration(s.hidden_secs)} with ${s.hidden_checks} checks; longest gap between checks ${s.longest_gap.toFixed(1)} s.`,
      `  Seen: away ${counts.away}x, phone ${counts.phone}x, interrupted ${counts.interrupt}x, camera covered or frozen ${counts.covered}x.`,
    ].join("\n");
  });
</script>

<div class="livecam" bind:this={box}>
  {#if loadError}<p class="err" role="alert">{loadError}</p>{/if}

  {#if picking}
    <div class="picker">
      <div class="tiles">
        {#each cams as c (c.id)}
          {@const t = tiles[c.id]}
          {@const open = c.auto || forced.includes(c.id)}
          <button class="tile" class:chosen={camera?.id === c.id} onclick={() => choose(c)} aria-pressed={camera?.id === c.id}>
            <div class="pic">
              {#if open && t?.jpeg}<img src={t.jpeg} alt="" />{:else if open && t?.problem}<span class="note">{t.problem}</span>{:else if open}<span class="note">Opening...</span>{:else}<span class="note">Not opened, so NVIDIA Broadcast keeps your webcam.</span>{/if}
              {#if t?.sees}<span class="badge">Sees you</span>{/if}
            </div>
            <span class="name">{c.name}</span>
          </button>
          {#if !open}<button class="link" onclick={() => showAnyway(c.id)}>Show {c.name} anyway (Broadcast may show a crossed-out camera)</button>{/if}
        {/each}
      </div>
      {#if camera?.broadcast}<p class="msg">If Broadcast's Auto frame is on, turn it off: it zooms around, which confuses posture and sizes.</p>{/if}
      <div class="row"><button onclick={closePicker}>Done</button></div>
    </div>
  {:else}
    <div class="row">
      <span class="msg">Camera: <strong>{camera?.name ?? "none found"}</strong></span>
      <button class="ghost small" onclick={openPicker} disabled={!cams.length}>Choose camera</button>
    </div>
  {/if}

  <div class="row opts">
    <label>Detector
      <select bind:value={check} disabled={phase !== "off"}>
        {#each checks as c}<option value={c}>{c}</option>{/each}
      </select>
    </label>
    <label class="tick"><input type="checkbox" bind:checked={gpu} disabled={phase !== "off"} /> Use the graphics chip if it can</label>
    <label class="tick"><input type="checkbox" bind:checked={phone} disabled={phase !== "off"} /> Check for my phone</label>
  </div>

  <div class="row">
    {#if phase === "off"}
      <button onclick={start} disabled={!camera || !checks.length}>Start the live check</button>
    {:else}
      <button class="ghost" onclick={stop} disabled={phase === "starting"}>{phase === "starting" ? "Starting..." : "Stop"}</button>
    {/if}
    {#if problem}<span class="err" role="alert">{problem}</span>{/if}
  </div>

  {#if phase !== "off" || stats}
    <div class="cam">
      <div class="frame">
        {#if picture}
          <div class="mirror">
            <img src={picture} alt="What the camera check sees" />
            {#if seen}
              <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
                {#if seen.person}<rect class="person" x={seen.person[0]} y={seen.person[1]} width={seen.person[2] - seen.person[0]} height={seen.person[3] - seen.person[1]} />{/if}
                {#if seen.hands_box}<rect class="hands" x={seen.hands_box[0]} y={seen.hands_box[1]} width={seen.hands_box[2] - seen.hands_box[0]} height={seen.hands_box[3] - seen.hands_box[1]} />{/if}
                {#if seen.phone}<rect class="phone" x={seen.phone.box[0]} y={seen.phone.box[1]} width={seen.phone.box[2] - seen.phone.box[0]} height={seen.phone.box[3] - seen.phone.box[1]} />{/if}
                {#each seen.keypoints as k}{#if k[2] >= 0.3}<circle cx={k[0]} cy={k[1]} r={H / 120} />{/if}{/each}
              </svg>
            {/if}
          </div>
        {:else}
          <div class="veil">{phase === "starting" ? "Opening the camera and loading the models..." : phase === "running" ? "Running. The picture shows while this part of the window is on screen." : "Stopped"}</div>
        {/if}
        {#if phase === "running"}<span class="dot" title="Camera on"></span>{/if}
      </div>
      <div class="side">
        {#if healthText}<p class="err" role="status">{healthText}. Lock In won't count you as away while it can't see.</p>{/if}
        {#if st}
          <dl>
            <dt>You</dt>
            <dd class:yes={st.presence === "here"} class:warn={st.presence === "away"}>{st.presence === "here" ? "Here" : st.presence === "away" ? "Away" : "Can't tell"}</dd>
            <dt>Phone</dt>
            <dd class:warn={st.phone}>{!phone ? "Not checking" : st.phone ? "In your hand" : st.phone_hits ? `Maybe (${st.phone_hits} of last 8)` : "No"}</dd>
            <dt>People</dt>
            <dd class:warn={st.interrupted}>{seen?.people ?? 0}{st.interrupted ? ", interrupted" : ""}</dd>
            {#if seen?.phone}<dt>Phone score</dt><dd>{Math.round(seen.phone.score * 100)}%{seen.phone.near_wrist ? ", at your hand" : ""}</dd>{/if}
            <dt>Light</dt><dd>{brightness < 45 ? "Dim" : "Fine"} ({Math.round(brightness)})</dd>
          </dl>
        {/if}
        {#if stats}
          <dl class="stats">
            <dt>Running</dt><dd>{duration(stats.running_secs)}, {stats.checks} checks</dd>
            <dt>Per check</dt><dd>{stats.check_ms.toFixed(0)} ms, {stats.rate} a second</dd>
            {#if stats.core_pct != null}<dt>CPU</dt><dd>{stats.core_pct.toFixed(1)}% of one core{#if stats.worker_pct != null && stats.app_pct != null}<small>models {stats.worker_pct.toFixed(1)}%, camera and app {stats.app_pct.toFixed(1)}%</small>{/if}</dd>{/if}
            <dt>Minimised</dt><dd class:yes={minutesHidden >= 20}>{duration(stats.hidden_secs)}, {stats.hidden_checks} checks</dd>
            <dt>Longest gap</dt><dd class:warn={stats.longest_gap > 3}>{stats.longest_gap.toFixed(1)} s</dd>
          </dl>
        {/if}
        {#if started}
          <p class="msg">{started.check} on the {started.engine === "gpu" ? "graphics chip" : "CPU"}. {started.sandbox.on ? "Running in its sandbox: no internet, no files." : `Sandbox off: ${started.sandbox.error ?? ""}`}</p>
        {/if}
      </div>
    </div>

    {#if log.length}
      <h3>What happened</h3>
      <ul class="log">
        {#each log as l}<li><span>{l.text}</span><span>{clock(l.at)}</span></li>{/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .livecam { display: grid; gap: 6px; }
  .opts { align-items: end; }
  .tick { display: flex; gap: 8px; align-items: center; color: var(--ink); font-size: 14px; }
  .tick input { flex: none; }
  .picker { display: grid; gap: 10px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .tile { display: grid; gap: 6px; padding: 6px; background: var(--paper); color: var(--ink); border: 2px solid var(--line); text-align: left; font-weight: 400; }
  .tile.chosen { border-color: var(--moss); }
  .tile .name { font-weight: 600; font-size: 14px; }
  .pic { position: relative; aspect-ratio: 4 / 3; border-radius: 6px; overflow: hidden; background: #111; display: grid; place-items: center; }
  .pic img { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
  .pic .note { color: #ddd; font-size: 13px; padding: 10px; text-align: center; }
  .badge { position: absolute; left: 6px; bottom: 6px; padding: 2px 8px; border-radius: 99px; background: var(--moss); color: var(--card); font-size: 12px; font-weight: 600; }
  .mirror { position: absolute; inset: 0; transform: scaleX(-1); }
  .mirror img, .mirror svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .mirror img { object-fit: fill; }
  svg rect { fill: none; stroke-width: 3; vector-effect: non-scaling-stroke; }
  svg .person { stroke: #9cbb7a; }
  svg .hands { stroke: #e0c36f; stroke-dasharray: 6 4; }
  svg .phone { stroke: #e18396; stroke-width: 4; }
  svg circle { fill: #f3ead8; }
  .dot { position: absolute; top: 10px; right: 10px; width: 10px; height: 10px; border-radius: 50%; background: #e05a4f; box-shadow: 0 0 0 3px rgb(0 0 0 / 0.35); }
  .stats { padding-top: 8px; border-top: 1px solid var(--line); }
  .stats small { display: block; color: var(--muted); font-weight: 400; font-size: 12px; }
  .log li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); }
  .log li span:last-child { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; flex: none; }
</style>
