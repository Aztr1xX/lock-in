<script lang="ts">
  // Your own test clips (camera plan, step 3). Short recordings of you studying, kept in a folder
  // on this PC, played back through the detectors to see which one gets your setup right.
  import { onMount } from "svelte";
  import {
    DEFAULT_CHECK, deleteClips, duration, listCameras, listChecks, listClips, onClipProgress, onScoreProgress, phoneRates, preferred, recordClip, scoreClips, stopClips,
    type Camera, type CheckScore, type ClipMeta, type ClipSpec,
  } from "./live";

  let { text = $bindable("") }: { text?: string } = $props();

  let folder = $state("");
  let clips = $state<{ spec: ClipSpec; recorded: ClipMeta | null }[]>([]);
  let checks = $state<string[]>([]);
  let picked = $state<string[]>([DEFAULT_CHECK]);
  let gpu = $state(true);
  let problem = $state("");

  // Recording: a three-second countdown with the picture showing, to get in place, then the clip.
  let rec = $state<{ id: string; count: number; done: number; total: number; preview: string } | null>(null);
  // Scoring.
  let scoring = $state<{ check: string; clip: string; done: number; total: number } | null>(null);
  let results = $state<CheckScore[]>([]);

  const recordedCount = $derived(clips.filter((c) => c.recorded).length);
  const specs = $derived(clips.map((c) => c.spec));
  const busy = $derived(rec !== null || scoring !== null);

  async function load() {
    try {
      const r = await listClips();
      folder = r.folder;
      clips = r.clips;
    } catch (e) {
      problem = String(e);
    }
  }

  async function camera(): Promise<Camera | null> {
    let saved = "";
    try {
      saved = localStorage.getItem("lockin.mfcamera") ?? "";
    } catch {
      /* use the default */
    }
    return preferred(await listCameras(), saved);
  }

  async function record(spec: ClipSpec) {
    problem = "";
    const cam = await camera().catch(() => null);
    if (!cam) {
      problem = "No camera found.";
      return;
    }
    rec = { id: spec.id, count: 3, done: 0, total: spec.secs * 2, preview: "" };
    try {
      await recordClip(spec.id, cam);
    } catch (e) {
      if (String(e) !== "Stopped") problem = String(e);
    }
    rec = null;
    await load();
  }

  const stop = () => stopClips();

  async function remove(id: string | null) {
    problem = "";
    try {
      await deleteClips(id);
      if (!id) results = [];
    } catch (e) {
      problem = String(e);
    }
    await load();
  }

  async function score() {
    problem = "";
    scoring = { check: picked[0], clip: "", done: 0, total: recordedCount };
    try {
      results = await scoreClips(checks.filter((c) => picked.includes(c)), gpu, true);
    } catch (e) {
      if (String(e) !== "Stopped") problem = String(e);
    }
    scoring = null;
  }

  const title = (id: string) => clips.find((c) => c.spec.id === id)?.spec.title ?? id;
  const pct = (x: number | null) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
  const when = (t: number) => new Date(t * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

  // Plain-text results for pasting into the chat. Numbers only, never pictures.
  $effect(() => {
    if (!results.length) {
      text = "";
      return;
    }
    const lines = [`Test clips: ${recordedCount} recorded.`];
    for (const r of results) {
      const { caught, wrong } = phoneRates(r.clips, specs);
      lines.push(`  ${r.check} on the ${r.engine === "gpu" ? "graphics chip" : "CPU"}, ${r.check_ms.toFixed(0)} ms a check: ${r.clips.filter((c) => c.passed).length} of ${r.clips.length} clips right; phone seen in ${pct(caught)} of phone frames, wrongly in ${pct(wrong)} of the rest.`);
      for (const c of r.clips) lines.push(`    ${c.passed ? "OK" : "WRONG"} ${c.id}: phone ${pct(c.phone_frames)}, you seen ${pct(c.seen_frames)}${c.slump == null ? "" : `, slumped ${c.slump ? "yes" : "no"}`}${c.misses.length ? `, ${c.misses.join("; ")}` : ""}`);
    }
    text = lines.join("\n");
  });

  onMount(() => {
    load();
    listChecks()
      .then((c) => {
        checks = c;
        // Lock In's detector against the one it was trained from, when both are there.
        const both = c.filter((x) => x === DEFAULT_CHECK || x === "NanoDet-Plus");
        picked = both.length ? both : c.slice(0, 1);
      })
      .catch(() => {});
    const un = [
      onClipProgress((p) => {
        if (rec && rec.id === p.id) {
          rec.done = p.done;
          rec.total = p.total;
          rec.count = p.count;
          if (p.preview) rec.preview = p.preview;
        }
      }),
      onScoreProgress((p) => (scoring = p)),
    ];
    return () => {
      un.forEach((u) => u.then((f) => f()));
      stopClips();
    };
  });
</script>

<div class="clips">
  {#if problem}<p class="err" role="alert">{problem}</p>{/if}

  {#if rec}
    <div class="recording">
      <div class="frame">
        {#if rec.preview}<img src={rec.preview} alt="What's being recorded" />{/if}
        {#if !rec.preview}<div class="veil">Opening the camera...</div>{:else if rec.count > 0}<div class="veil count">{rec.count}</div>{/if}
        {#if rec.count === 0 && rec.preview}<span class="dot" title="Recording"></span>{/if}
      </div>
      <div class="side">
        <h3>{title(rec.id)}</h3>
        <p>{clips.find((c) => c.spec.id === rec?.id)?.spec.how}</p>
        <div class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={rec.total} aria-valuenow={rec.done}><span style="width: {(rec.done / rec.total) * 100}%"></span></div>
        <p class="msg">{!rec.preview ? "" : rec.count > 0 ? "Get in place..." : `Recording, ${duration((rec.total - rec.done) / 2)} left`}</p>
        <div class="row"><button class="ghost" onclick={stop}>Stop (keeps nothing)</button></div>
      </div>
    </div>
  {/if}

  <ul class="list">
    {#each clips as c (c.spec.id)}
      <li>
        <div>
          <strong>{c.spec.title}</strong> <span class="msg">{duration(c.spec.secs)}</span>
          <p class="msg">{c.spec.how}</p>
        </div>
        <div class="acts">
          {#if c.recorded}<span class="done" title="Recorded {when(c.recorded.recorded_at)}">Recorded</span>{/if}
          <button class="small" class:ghost={!!c.recorded} onclick={() => record(c.spec)} disabled={busy}>{c.recorded ? "Again" : "Record"}</button>
          {#if c.recorded}<button class="link" onclick={() => remove(c.spec.id)} disabled={busy} aria-label="Delete {c.spec.title}">Delete</button>{/if}
        </div>
      </li>
    {/each}
  </ul>

  <h3>Score your clips</h3>
  <p class="msg">Plays your clips through each detector you tick, with the same rules as the live check, and shows which ones it got right. Faster with the graphics chip.</p>
  <div class="row picks">
    {#each checks as c}<label class="tick"><input type="checkbox" value={c} bind:group={picked} disabled={busy} /> {c}</label>{/each}
    <label class="tick"><input type="checkbox" bind:checked={gpu} disabled={busy} /> Use the graphics chip if it can</label>
  </div>
  <div class="row">
    {#if scoring}
      <button class="ghost" onclick={stop}>Stop</button>
      <span class="msg">{scoring.check}: {scoring.clip ? `${scoring.done} of ${scoring.total} clips` : "loading..."}</span>
    {:else}
      <button onclick={score} disabled={busy || !recordedCount || !picked.length}>Score {recordedCount} {recordedCount === 1 ? "clip" : "clips"}</button>
    {/if}
  </div>

  {#each results as r (r.check)}
    {@const rates = phoneRates(r.clips, specs)}
    <div class="result">
      <p><strong>{r.check}</strong>: {r.clips.filter((c) => c.passed).length} of {r.clips.length} right. Phone seen in {pct(rates.caught)} of phone-in-hand frames, wrongly in {pct(rates.wrong)} of the rest. {r.check_ms.toFixed(0)} ms a check on the {r.engine === "gpu" ? "graphics chip" : "CPU"}.</p>
      <ul class="scores">
        {#each r.clips as c (c.id)}
          <li class:bad={!c.passed}>
            <span>{c.passed ? "Right" : "Wrong"}</span>
            <span>{title(c.id)}{#if c.misses.length}: {c.misses.join("; ")}{/if}</span>
            <span class="msg">phone {pct(c.phone_frames)}, you {pct(c.seen_frames)}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/each}

  <p class="msg where">Clips are saved only on this PC, in <code>{folder}</code>. They're never uploaded, and the detector only ever gets the pictures, not the files.
    {#if recordedCount}<button class="link" onclick={() => remove(null)} disabled={busy}>Delete all clips</button>{/if}</p>
</div>

<style>
  .clips { display: grid; gap: 6px; }
  .list, .scores { list-style: none; padding: 0; margin: 0; }
  .list li { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .list p { margin: 2px 0 0; }
  .acts { display: flex; gap: 10px; align-items: center; flex: none; }
  .done { color: var(--moss); font-size: 13px; font-weight: 600; }
  .recording { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 20px; padding: 12px; border: 1px solid var(--clay); border-radius: 10px; }
  .recording img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
  .count { font-size: 64px; font-weight: 700; color: var(--card); background: rgb(0 0 0 / 0.35); }
  .dot { position: absolute; top: 10px; right: 10px; width: 10px; height: 10px; border-radius: 50%; background: #e05a4f; box-shadow: 0 0 0 3px rgb(0 0 0 / 0.35); }
  .bar { height: 8px; border-radius: 99px; background: var(--line); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--clay); transition: width 400ms linear; }
  .tick { display: flex; gap: 8px; align-items: center; color: var(--ink); font-size: 14px; }
  .picks { gap: 16px; }
  .result { padding: 10px 0; border-top: 1px solid var(--line); }
  .scores li { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; gap: 10px; padding: 4px 0; font-size: 14px; }
  .scores li span:first-child { color: var(--moss); font-weight: 600; }
  .scores li.bad span:first-child { color: var(--berry); }
  .where code { font-size: 12px; word-break: break-all; }
  @media (max-width: 640px) {
    .recording { grid-template-columns: 1fr; }
    .list li { flex-direction: column; align-items: flex-start; }
  }
</style>
