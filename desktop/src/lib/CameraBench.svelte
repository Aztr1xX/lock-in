<script lang="ts">
  // Camera speed test (camera plan, step 1): times the new camera models on this PC and shows
  // whether a full check fits the budget, with what each model saw in one frame from the camera.
  import { benchText, coreShare, ENGINES, grabFrame, isTiming, runBench, TARGET_MS, type BenchResult, type Progress } from "./bench";

  let { camId, live = null, text = $bindable("") }: { camId: string; live?: HTMLVideoElement | null; text?: string } = $props();

  type Phase = "idle" | "camera" | "running" | "done" | "error";
  let phase = $state<Phase>("idle");
  let progress = $state<Progress | null>(null);
  let result = $state<BenchResult | null>(null);
  let fromCamera = $state(true);
  let error = $state("");
  let showModels = $state(false);

  const detectors = $derived(result?.models.filter((m) => m.family !== "rtmpose") ?? []);
  const pose = $derived(result?.models.find((m) => m.family === "rtmpose"));
  const engines = $derived(ENGINES.filter((e) => result?.models.some((m) => m.engines[e.key])));
  const gpuError = $derived.by(() => {
    for (const m of result?.models ?? []) {
      const o = m.engines.gpu;
      if (o && "error" in o) return o.error;
    }
    return "";
  });
  // The best CPU-only full check, and the best overall, for the headline.
  const bestCpu = $derived(
    result?.checks.filter((c) => c.engines.cpu).sort((a, b) => a.engines.cpu!.ms - b.engines.cpu!.ms)[0] ?? null,
  );
  const bestGpu = $derived(
    result?.checks.filter((c) => c.engines.gpu).sort((a, b) => a.engines.gpu!.ms - b.engines.gpu!.ms)[0] ?? null,
  );

  async function start() {
    phase = "camera";
    error = "";
    result = null;
    progress = null;
    try {
      const frame = await grabFrame(camId, live);
      fromCamera = frame.fromCamera;
      phase = "running";
      result = await runBench(frame.png, (p) => (progress = p));
      text = benchText(result, fromCamera);
      phase = "done";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      phase = "error";
    }
  }

  const pct = (s: number) => `${Math.round(s * 100)}%`;
</script>

<div class="bench">
  {#if phase === "idle" || phase === "error"}
    <div class="row">
      <button onclick={start}>{phase === "error" ? "Try the speed test again" : "Run the speed test"}</button>
      <span class="msg">Takes one picture with your camera, then about two minutes. Close games first so they don't slow it down.</span>
    </div>
    {#if phase === "error"}<p class="err" role="alert">{error}</p>{/if}
  {:else if phase === "camera"}
    <p class="msg" aria-live="polite"><span class="dot" aria-hidden="true"></span>Taking one picture with your camera...</p>
  {:else if phase === "running"}
    <div class="progress" aria-live="polite">
      <div class="bar"><span style:width={progress ? pct(progress.step / progress.total) : "2%"}></span></div>
      <p class="msg">
        {#if progress}Timing {progress.model} ({progress.size} px) on {progress.where}, {progress.step} of {progress.total}{:else}Loading the models...{/if}
      </p>
    </div>
  {/if}

  {#if result}
    <div class="headline">
      {#if bestCpu}
        <p>
          <strong>{bestCpu.name}</strong> does a full check in <strong>{bestCpu.engines.cpu!.ms} ms</strong> on the CPU alone
          ({bestCpu.engines.cpu!.ms < TARGET_MS ? `under the ${TARGET_MS} ms target` : `over the ${TARGET_MS} ms target`}), about
          {coreShare(bestCpu.engines.cpu!.cpu_ms)}% of one core at two checks a second.
        </p>
      {/if}
      {#if bestGpu}
        <p>On the graphics chip the fastest is {bestGpu.name}, at {bestGpu.engines.gpu!.ms} ms.</p>
      {:else if gpuError}
        <p class="msg">The graphics chip couldn't run the models, so they'd use the CPU. ({gpuError})</p>
      {/if}
      {#if !fromCamera}<p class="msg">The camera didn't open, so this ran on a plain grey picture. The speeds still count.</p>{/if}
      {#if result.sandbox?.on}
        <p class="msg">Ran in its sandbox: Windows blocked it from the internet, the camera and your files.</p>
      {:else if result.sandbox}
        <p class="err">The sandbox didn't start, so it ran as a normal background program (it still has no internet code). {result.sandbox.error}</p>
      {/if}
    </div>

    <h3>Full check: whole frame, a closer look at your hands, and posture</h3>
    <div class="scroll">
      <table>
        <thead>
          <tr><th scope="col">Detector</th>{#each engines as e}<th scope="col">{e.name}</th>{/each}</tr>
        </thead>
        <tbody>
          {#each result.checks as c}
            <tr>
              <th scope="row">{c.name}</th>
              {#each engines as e}
                {@const t = c.engines[e.key]}
                <td class:good={e.key === "cpu" && t && t.ms < TARGET_MS} class:over={e.key === "cpu" && t && t.ms >= TARGET_MS}>
                  {#if t}{t.ms} ms{#if !e.key.startsWith("gpu")}<small>{coreShare(t.cpu_ms)}% of a core</small>{/if}{:else}-{/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <h3>What it saw in {fromCamera ? "your" : "the"} picture</h3>
    <ul class="seen">
      {#each detectors.filter((m) => m.engines.cpu1 || m.engines.cpu) as m}
        <li>
          <span>{m.label}, {m.width} px</span>
          <span>{m.found?.length ? m.found.slice(0, 3).map((d) => `${d.cls} ${pct(d.score)}`).join(", ") : "nothing"}</span>
        </li>
      {/each}
      {#if pose?.keypoints?.length}
        <li><span>{pose.label}</span><span>{pose.keypoints.filter((k) => k.score > 0.5).length} of 17 body points found</span></li>
      {/if}
    </ul>

    <button class="link" onclick={() => (showModels = !showModels)} aria-expanded={showModels}>
      {showModels ? "Hide" : "Show"} each model's time
    </button>
    {#if showModels}
      <div class="scroll">
        <table>
          <thead>
            <tr><th scope="col">Model</th><th scope="col">Size</th>{#each engines as e}<th scope="col">{e.name}</th>{/each}</tr>
          </thead>
          <tbody>
            {#each result.models as m}
              <tr>
                <th scope="row">{m.label}, {m.width} px</th>
                <td>{m.mb} MB</td>
                {#each engines as e}
                  {@const o = m.engines[e.key]}
                  <td title={o && "error" in o ? o.error : ""}>
                    {#if isTiming(o)}{o.ms.toFixed(1)} ms{#if o.agrees === false}<small class="err">different answer</small>{/if}{:else if o}failed{:else}-{/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="msg">{result.machine.cpu}, {result.machine.threads} threads. Graphics: {result.machine.gpus.join(", ") || "none listed"}.</p>
    {/if}
  {/if}
</div>

<style>
  .bench { display: grid; gap: 6px; }
  .progress { display: grid; gap: 8px; }
  .bar { height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--moss); transition: width 300ms ease; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--berry); margin-right: 8px; vertical-align: middle; }
  .headline { padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); }
  .headline strong { font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 14px; }
  th, td { text-align: left; padding: 7px 10px 7px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  thead th { color: var(--muted); font-weight: 600; font-size: 13px; }
  tbody th { font-weight: 600; }
  td small { display: block; color: var(--muted); font-size: 12px; }
  td.good { color: var(--moss); font-weight: 600; }
  td.over { color: var(--berry); font-weight: 600; }
  .seen li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); }
  .seen li span:first-child { color: var(--muted); }
  @media (prefers-reduced-motion: reduce) { .bar span { transition: none; } }
</style>
