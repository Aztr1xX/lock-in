<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { CHECK_EVERY_MS, checkAndDownload, installNow, type UpdateState } from "./lib/updates";
  import { CamTest, coreShare, listCameras, openCamera, preferredCamera, type CamStats } from "./lib/camtest";

  type Mark = "pass" | "fail" | "";
  const inTauri = "__TAURI_INTERNALS__" in window;

  let about = $state({ app: "", webview: "", os: "" });

  // ---------- updates ----------
  let upd = $state<UpdateState>({ kind: "idle" });
  const checkUpdates = () => checkAndDownload((s) => (upd = s));

  // ---------- camera ----------
  let video: HTMLVideoElement;
  let cams = $state<MediaDeviceInfo[]>([]);
  let camId = $state("");
  let camState = $state<"idle" | "loading" | "running" | "error">("idle");
  let camError = $state("");
  let stats = $state<CamStats | null>(null);
  let test: CamTest | null = null;

  async function startCam() {
    camState = "loading";
    camError = "";
    try {
      // Ask once with any camera so the labels appear, then pick the preferred one.
      if (!cams.length || !cams[0].label) {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((t) => t.stop());
        cams = await listCameras();
        camId = camId || preferredCamera(cams);
      }
      await openCamera(video, camId);
      test = new CamTest(video, (s) => (stats = s));
      await test.start();
      camState = "running";
    } catch (e) {
      camError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      camState = "error";
      test?.stop();
    }
  }

  function stopCam() {
    test?.stop();
    test = null;
    camState = "idle";
  }

  // ---------- guard ----------
  type Status = {
    ok: boolean;
    version: string;
    blocking: boolean;
    hosts: string[];
    secondsLeft: number;
    attempts: { host: string; at: number }[];
    sinkhole: string[];
  };
  let guard = $state<Status | null>(null);
  let guardMsg = $state("");
  let busy = $state(false);
  let sites = $state("reddit.com, example.com");
  let minutes = $state(2);

  async function call<T>(req: object): Promise<T> {
    return (await invoke("guard", { req })) as T;
  }

  async function refresh() {
    if (!inTauri) return;
    try {
      guard = await call<Status>({ cmd: "status" });
    } catch {
      guard = null;
    }
  }

  async function setup(action: "install" | "uninstall") {
    busy = true;
    guardMsg = action === "install" ? "Windows will ask for admin once..." : "Removing...";
    try {
      guardMsg = (await invoke("guard_setup", { action })) as string;
    } catch (e) {
      guardMsg = String(e);
    }
    busy = false;
    setTimeout(refresh, 800);
  }

  async function block() {
    const hosts = sites.split(/[\s,]+/).filter(Boolean);
    const r = await call<{ ok: boolean; error?: string }>({ cmd: "block", hosts, minutes });
    guardMsg = r.ok ? "Blocking. Try the sites now in Chrome, Incognito and Edge." : `Could not block: ${r.error}`;
    refresh();
  }

  async function unblock() {
    await call({ cmd: "unblock" });
    guardMsg = "Unblocked.";
    refresh();
  }

  // ---------- games ----------
  type Proc = { pid: number; name: string; path: string };
  let games = $state<Proc[] | null>(null);
  let killName = $state("notepad.exe");
  let killMsg = $state("");

  async function findGames() {
    const r = await call<{ games: Proc[] }>({ cmd: "games" });
    games = r.games;
  }

  async function kill(names: string[]) {
    const r = await call<{ killed: Proc[] }>({ cmd: "kill", names });
    killMsg = r.killed.length ? `Closed ${r.killed.map((k) => k.name).join(", ")}.` : `Nothing called ${names.join(", ")} was running.`;
    if (games) findGames();
  }

  // ---------- your results ----------
  const checks = [
    { id: "cam-open", group: "Camera", text: "The camera opened with no permission prompt" },
    { id: "cam-run", group: "Camera", text: "Ran for a minute with \"person\" right most of the time" },
    { id: "cam-phone", group: "Camera", text: "Holding up your phone raises the phone score" },
    { id: "guard-install", group: "Blocking", text: "The Guard installed after one admin prompt" },
    { id: "chrome", group: "Blocking", text: "Blocked in Chrome" },
    { id: "incognito", group: "Blocking", text: "Blocked in Chrome Incognito" },
    { id: "edge", group: "Blocking", text: "Blocked in Edge" },
    { id: "securedns", group: "Blocking", text: "Still blocked with Chrome's secure DNS on" },
    { id: "attempts", group: "Blocking", text: "Your attempts showed up in the list" },
    { id: "defender", group: "Blocking", text: "Windows Security stayed quiet" },
    { id: "unblock", group: "Blocking", text: "Sites came back on their own when time ran out" },
    { id: "kill", group: "Games", text: "Notepad closed from the button" },
    { id: "game", group: "Games", text: "A real game showed in the list and closed" },
  ];
  let marks = $state<Record<string, Mark>>({});
  let note = $state("");
  let copied = $state(false);

  function cycle(id: string) {
    const m = marks[id] ?? "";
    marks[id] = m === "" ? "pass" : m === "pass" ? "fail" : "";
  }

  function summary() {
    const lines = [`Lock In test build ${about.app}, WebView2 ${about.webview}`];
    if (stats)
      lines.push(
        `Camera: ${stats.frames} frames, ${stats.avgMs.toFixed(0)} ms avg, ${stats.maxMs.toFixed(0)} ms max, pose on ${stats.poseDelegate}${stats.error ? `, error ${stats.error}` : ""}`,
      );
    if (camError) lines.push(`Camera error: ${camError}`);
    if (upd.kind === "error") lines.push(`Update check: ${upd.message}`);
    if (guard) lines.push(`Guard ${guard.version}, sinkhole on ${guard.sinkhole.join(" ") || "none"}, ${guard.attempts.length} attempts seen`);
    for (const c of checks) lines.push(`${marks[c.id] === "pass" ? "PASS" : marks[c.id] === "fail" ? "FAIL" : "not tried"}: ${c.text}`);
    if (note.trim()) lines.push(`Notes: ${note.trim()}`);
    return lines.join("\n");
  }

  async function copy() {
    await navigator.clipboard.writeText(summary());
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const ago = (t: number) => {
    const s = Math.max(0, Math.round(Date.now() / 1000 - t));
    return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
  };

  onMount(() => {
    if (inTauri) invoke("about").then((a) => (about = a as typeof about));
    listCameras().then((c) => {
      cams = c;
      camId = preferredCamera(c);
    });
    refresh();
    const t = setInterval(refresh, 2000);
    let u = 0;
    if (inTauri) {
      checkUpdates();
      u = window.setInterval(checkUpdates, CHECK_EVERY_MS);
    }
    return () => {
      clearInterval(t);
      clearInterval(u);
      test?.stop();
    };
  });
</script>

<main>
  {#if upd.kind === "ready"}
    <div class="update">
      <span>Lock In {upd.version} is ready.</span>
      <button onclick={installNow}>Restart to update</button>
    </div>
  {/if}
  <header>
    <p class="eyebrow">Phase 0 test build {about.app}</p>
    <h1>Three things to prove before we build</h1>
    <p class="lede">Work down the page, tap each check to mark it pass or fail, then copy your results into the chat.</p>
  </header>

  <section>
    <div class="head">
      <span class="num">1</span>
      <div>
        <h2>Camera</h2>
        <p>Opens your camera inside the app and runs the phone and person models twice a second.</p>
      </div>
    </div>

    <div class="cam">
      <div class="frame">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} muted playsinline></video>
        {#if camState !== "running"}<div class="veil">{camState === "loading" ? "Loading models..." : "Camera off"}</div>{/if}
      </div>
      <div class="side">
        {#if cams.length > 1}
          <label>Camera
            <select bind:value={camId} disabled={camState === "running"}>
              {#each cams as c}<option value={c.deviceId}>{c.label || "Camera"}</option>{/each}
            </select>
          </label>
        {/if}
        {#if camState === "running"}
          <button class="ghost" onclick={stopCam}>Stop camera</button>
        {:else}
          <button onclick={startCam} disabled={camState === "loading"}>Start camera test</button>
        {/if}
        {#if stats}
          <dl>
            <dt>Person</dt><dd class:yes={stats.person}>{stats.person ? "Yes" : "No"}</dd>
            <dt>Phone score</dt><dd class:warn={stats.phone > 0.5}>{Math.round(stats.phone * 100)}%</dd>
            <dt>Time per check</dt><dd>{stats.avgMs.toFixed(0)} ms avg, {stats.maxMs.toFixed(0)} max</dd>
            <dt>CPU</dt><dd>about {Math.round(coreShare(stats.avgMs) * 100)}% of one core</dd>
            <dt>Pose model on</dt><dd>{stats.poseDelegate}</dd>
            <dt>Checks run</dt><dd>{stats.frames}</dd>
          </dl>
        {/if}
        {#if camError}<p class="err">{camError}</p>{/if}
      </div>
    </div>
  </section>

  <section>
    <div class="head">
      <span class="num">2</span>
      <div>
        <h2>Site blocking</h2>
        <p>Installs Lock In Guard, then blocks a couple of test sites in every browser for a few minutes.</p>
      </div>
    </div>

    {#if !inTauri}
      <p class="err">Open this inside the installed app; the browser preview can't reach the Guard.</p>
    {:else if !guard}
      <p>The Guard isn't running yet.</p>
      <button onclick={() => setup("install")} disabled={busy}>Install Lock In Guard</button>
    {:else}
      {#if about.app && guard.version !== about.app}
        <p class="msg">The Guard is on {guard.version} and the app is on {about.app}. <button class="link" onclick={() => setup("install")} disabled={busy}>Update the Guard</button></p>
      {/if}
      <p class="ok">Guard {guard.version} is running.{guard.sinkhole.length ? "" : " (Attempt tracking is off: ports 80 and 443 are in use by something else.)"}</p>
      {#if guard.blocking}
        <div class="live">
          <strong>Blocking for {fmt(guard.secondsLeft)}</strong>
          <span>{guard.hosts.join(", ")}</span>
          <button class="ghost" onclick={unblock}>Unblock now</button>
        </div>
      {:else}
        <div class="row">
          <input bind:value={sites} aria-label="Sites to block" />
          <select bind:value={minutes} aria-label="How long">
            <option value={1}>1 min</option><option value={2}>2 min</option><option value={5}>5 min</option>
          </select>
          <button onclick={block}>Block these</button>
        </div>
      {/if}
      {#if guard.attempts.length}
        <h3>Attempts the Guard saw</h3>
        <ul class="attempts">
          {#each guard.attempts.slice(-6).reverse() as a}<li><span>{a.host}</span><span>{ago(a.at)}</span></li>{/each}
        </ul>
      {/if}
      <button class="link" onclick={() => setup("uninstall")} disabled={busy}>Remove the Guard</button>
    {/if}
    {#if guardMsg}<p class="msg">{guardMsg}</p>{/if}
  </section>

  <section>
    <div class="head">
      <span class="num">3</span>
      <div>
        <h2>Closing games</h2>
        <p>The Guard finds games from Steam, Epic, Riot, Battle.net and EA folders and closes them.</p>
      </div>
    </div>
    {#if guard}
      <div class="row">
        <input bind:value={killName} aria-label="Program to close" />
        <button onclick={() => kill([killName])}>Close it</button>
        <button class="ghost" onclick={findGames}>Show running games</button>
      </div>
      {#if games}
        {#if games.length}
          <ul class="games">
            {#each games as g}<li><span title={g.path}>{g.name}</span><button class="ghost small" onclick={() => kill([g.name])}>Close</button></li>{/each}
          </ul>
        {:else}<p>No games running. Start one from Steam or Riot and press the button again.</p>{/if}
      {/if}
      {#if killMsg}<p class="msg">{killMsg}</p>{/if}
    {:else}<p>Install the Guard in step 2 first.</p>{/if}
  </section>

  <section class="results">
    <h2>Your results</h2>
    {#each ["Camera", "Blocking", "Games"] as g}
      <h3>{g}</h3>
      <ul class="checks">
        {#each checks.filter((c) => c.group === g) as c}
          <li><button class="check {marks[c.id] ?? ''}" onclick={() => cycle(c.id)}><span class="box"></span>{c.text}</button></li>
        {/each}
      </ul>
    {/each}
    <textarea bind:value={note} placeholder="Anything odd? Write it here." rows="3"></textarea>
    <button onclick={copy}>{copied ? "Copied" : "Copy results"}</button>
  </section>

  <footer>
    <p>Version {about.app}, WebView2 {about.webview || "unknown"}. Closing this window hides it to the tray; quit from the tray icon.</p>
    <p>
      {#if upd.kind === "checking"}Checking for updates...
      {:else if upd.kind === "downloading"}Downloading {upd.version}, {Math.round(upd.pct * 100)}%
      {:else if upd.kind === "none"}Up to date.
      {:else if upd.kind === "error"}Couldn't check for updates.
      {/if}
      {#if upd.kind !== "checking" && upd.kind !== "downloading"}<button class="link" onclick={checkUpdates}>Check for updates</button>{/if}
    </p>
  </footer>
</main>
