<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { CHECK_EVERY_MS, checkAndDownload, installNow, type UpdateState } from "./lib/updates";
  import SiteList from "./lib/SiteList.svelte";
  import { blockedHosts, loadSites } from "./lib/sites";
  import AppList from "./lib/AppList.svelte";
  import CaughtCard from "./lib/CaughtCard.svelte";
  import UpdatingCard from "./lib/UpdatingCard.svelte";
  import { buildRows, closedExes, type AppRow, type InstalledApp } from "./lib/apps";
  import { CamTest, coreShare, listCameras, openCamera, preferredCamera, type CamStats } from "./lib/camtest";
  import CameraBench from "./lib/CameraBench.svelte";
  import LiveCamera from "./lib/LiveCamera.svelte";
  import TestClips from "./lib/TestClips.svelte";

  type Mark = "pass" | "fail" | "";
  const inTauri = "__TAURI_INTERNALS__" in window;

  let about = $state({ app: "", webview: "", os: "" });

  // ---------- updates ----------
  let upd = $state<UpdateState>({ kind: "idle" });
  const checkUpdates = () => checkAndDownload((s) => (upd = s));

  // ---------- camera ----------
  let video = $state<HTMLVideoElement>();
  let cams = $state<MediaDeviceInfo[]>([]);
  let camId = $state(savedCamera());
  let camState = $state<"idle" | "loading" | "running" | "error">("idle");
  let camError = $state("");
  let stats = $state<CamStats | null>(null);
  let test: CamTest | null = null;
  let benchSummary = $state("");
  let liveSummary = $state("");
  let clipsSummary = $state("");

  function savedCamera(): string {
    try {
      return localStorage.getItem("lockin.camera") ?? "";
    } catch {
      return "";
    }
  }

  // Camera names only show up after the camera has been opened once. The app is allowed the
  // camera without a prompt, so open it for a moment to get the full list.
  async function loadCameras() {
    try {
      let list = await listCameras();
      if (list.length && !list[0].label) {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((t) => t.stop());
        list = await listCameras();
      }
      cams = list;
      if (!cams.some((c) => c.deviceId === camId)) camId = preferredCamera(cams);
    } catch {
      /* no camera, or blocked: the start button shows the error */
    }
  }

  async function pickCamera(id: string) {
    camId = id;
    try {
      localStorage.setItem("lockin.camera", id);
    } catch {
      /* fine, it just won't be remembered */
    }
    if (camState === "running") {
      stopCam();
      await startCam();
    }
  }

  async function startCam() {
    camState = "loading";
    camError = "";
    try {
      if (!cams.length || !cams[0].label) await loadCameras();
      if (!video) throw new Error("The camera preview isn't ready yet.");
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
    closed?: { name: string; at: number }[];
    sinkhole: string[];
    layers?: string[];
    hostsOk?: boolean;
  };
  let guard = $state<Status | null>(null);
  let guardMsg = $state("");
  let busy = $state(false);
  let sites = $state(loadSites());
  let minutes = $state(2);

  async function call<T>(req: object): Promise<T> {
    return (await invoke("guard", { req })) as T;
  }

  async function refresh() {
    if (!inTauri) return;
    try {
      guard = await call<Status>({ cmd: "status" });
      noticeClosed(guard);
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
    const hosts = blockedHosts(sites);
    if (!hosts.length) {
      guardMsg = "Switch on at least one site first.";
      return;
    }
    const r = await call<{ ok: boolean; error?: string }>({ cmd: "block", hosts, minutes, apps: closedExes(appRows) });
    guardMsg = r.ok ? "Blocking. Try a few sites in Chrome and Opera, try YouTube (search works, the feed doesn't), and try opening a game." : `Could not block: ${r.error}`;
    refresh();
  }

  async function unblock() {
    await call({ cmd: "unblock" });
    guardMsg = "Unblocked.";
    refresh();
  }

  // ---------- installing an update ----------
  // The installer runs silently, so the app shows its own calm screen while it closes and reopens.
  let updating = $state<{ version: string; error?: string } | null>(null);

  async function startUpdate() {
    if (upd.kind !== "ready") return;
    updating = { version: upd.version };
    // Let the screen paint before the app closes for the installer.
    await new Promise((r) => setTimeout(r, 600));
    try {
      await installNow();
    } catch (e) {
      updating = { version: upd.kind === "ready" ? upd.version : "", error: String(e) };
    }
  }

  // ---------- caught opening an app ----------
  // When the Guard closes an app during a round, the window comes forward with a card saying so,
  // so a game vanishing doesn't look like the laptop misbehaving.
  let lastClosedAt = -1; // -1 until the first status, so older closings don't pop up on launch
  let caught = $state<{ name: string; secondsLeft: number } | null>(null);

  function appName(exe: string) {
    const low = exe.toLowerCase();
    const row = appRows.find((r) => r.exes.some((x) => x.toLowerCase() === low)) ?? installed.find((a) => a.exes.some((x) => x.toLowerCase() === low));
    return row?.name ?? exe.replace(/\.exe$/i, "");
  }

  function noticeClosed(s: Status) {
    const closed = s.closed ?? [];
    const newest = closed.reduce((m, c) => Math.max(m, c.at), 0);
    if (lastClosedAt < 0) {
      lastClosedAt = newest;
      return;
    }
    if (newest <= lastClosedAt) return;
    const fresh = closed.filter((c) => c.at > lastClosedAt);
    lastClosedAt = newest;
    if (!s.blocking) return;
    caught = { name: appName(fresh[fresh.length - 1].name), secondsLeft: s.secondsLeft };
    invoke("bring_forward").catch(() => {});
  }

  // ---------- apps ----------
  let installed = $state<InstalledApp[]>([]);
  let appRows = $state<AppRow[]>(buildRows([]));
  let appsLoading = $state(false);
  let appsLoaded = false;
  let appsNeedGuard = $state(false);

  async function loadApps() {
    if (appsLoaded || !guard) return;
    appsLoaded = true;
    appsLoading = true;
    try {
      const r = await call<{ ok: boolean; apps?: InstalledApp[] }>({ cmd: "apps" });
      if (r.ok && Array.isArray(r.apps)) {
        installed = r.apps;
        appRows = buildRows(installed);
        appsNeedGuard = false;
      } else {
        // An older Guard doesn't know how to list apps. Ask again once it's updated.
        appsLoaded = false;
        appsNeedGuard = true;
      }
    } catch {
      appsLoaded = false;
    }
    appsLoading = false;
  }

  function lookAgain() {
    appsLoaded = false;
    loadApps();
  }
  $effect(() => {
    if (guard) loadApps();
  });

  // ---------- your results ----------
  const checks = [
    { id: "bench-run", group: "Camera speed test", text: "The speed test finished without an error" },
    { id: "bench-saw", group: "Camera speed test", text: "\"What it saw\" found a person (you) for each detector" },
    { id: "bench-smooth", group: "Camera speed test", text: "The app stayed responsive while it ran" },
    { id: "bench-sandbox", group: "Camera speed test", text: "It said it ran in its sandbox" },
    { id: "live-picker", group: "Live camera check", text: "The camera picker showed a moving picture of you, marked \"Sees you\"" },
    { id: "live-broadcast", group: "Live camera check", text: "NVIDIA Broadcast never showed its crossed-out camera" },
    { id: "live-hour", group: "Live camera check", text: "Left minimised while you studied for 20 min or more, with no long gap" },
    { id: "live-away", group: "Live camera check", text: "Walking away for 20 s showed Away, and sitting down showed Here again within a few seconds" },
    { id: "live-ipad", group: "Live camera check", text: "Reading your iPad for 5 minutes never showed Away or Phone" },
    { id: "live-phone", group: "Live camera check", text: "Holding your phone showed \"In your hand\" within about 5 s (this model isn't trained for it yet, so misses are expected)" },
    { id: "live-cover", group: "Live camera check", text: "Covering the camera said it looks covered, not Away" },
    { id: "clips-record", group: "Test clips", text: "Recorded the phone, iPad and leaving clips (more if you can)" },
    { id: "clips-preview", group: "Test clips", text: "The countdown and picture showed while recording" },
    { id: "clips-score", group: "Test clips", text: "Scoring finished and showed which clips each detector got right" },
    { id: "cam-open", group: "Camera", text: "The camera opened with no permission prompt" },
    { id: "cam-run", group: "Camera", text: "Ran for a minute with \"person\" right most of the time" },
    { id: "cam-phone", group: "Camera", text: "Holding up your phone raises the phone score" },
    { id: "guard-install", group: "Blocking", text: "The Guard installed after one admin prompt" },
    { id: "chrome", group: "Blocking", text: "Blocked in Chrome" },
    { id: "incognito", group: "Blocking", text: "Blocked in Chrome Incognito" },
    { id: "edge", group: "Blocking", text: "Blocked in Edge" },
    { id: "opera", group: "Blocking", text: "Blocked in Opera" },
    { id: "opentab", group: "Blocking", text: "A tab that was already open stopped working" },
    { id: "subdomain", group: "Blocking", text: "Other parts of a site were blocked too (like music.youtube.com)" },
    { id: "attempts", group: "Blocking", text: "Your attempts showed up in the list" },
    { id: "defender", group: "Blocking", text: "Windows Security stayed quiet" },
    { id: "unblock", group: "Blocking", text: "Sites came back on their own when time ran out" },
    { id: "page", group: "Blocking", text: "A blocked site showed the \"This can wait\" page" },
    { id: "apps-found", group: "Apps", text: "Your games, launchers and Discord showed in the apps list" },
    { id: "apps-close", group: "Apps", text: "A game on the list closed when you opened it during a round" },
    { id: "apps-add", group: "Apps", text: "Adding an app from the suggestions worked" },
    { id: "yt-feed", group: "Study YouTube", text: "youtube.com opened with no feed, just search" },
    { id: "yt-search", group: "Study YouTube", text: "A study search worked, and a fun search said \"That search can wait\"" },
    { id: "yt-play", group: "Study YouTube", text: "A lesson or explainer played" },
    { id: "yt-hold", group: "Study YouTube", text: "A gaming or music video opened from search said \"This video can wait\" straight away" },
    { id: "yt-notif", group: "Study YouTube", text: "Same for a video opened from a channel or a notification" },
    { id: "yt-channel", group: "Study YouTube", text: "A channel's videos and playlists opened" },
    { id: "yt-queue", group: "Study YouTube", text: "A playlist's queue showed beside the video, with no suggestions" },
    { id: "page-center", group: "Blocking", text: "The \"This can wait\" page sat in the middle of the window" },
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
    if (benchSummary) lines.push(benchSummary);
    if (liveSummary) lines.push(liveSummary);
    if (clipsSummary) lines.push(clipsSummary);
    if (stats)
      lines.push(
        `Camera: ${stats.frames} frames, ${stats.avgMs.toFixed(0)} ms avg, ${stats.maxMs.toFixed(0)} ms max, pose on ${stats.poseDelegate}${stats.error ? `, error ${stats.error}` : ""}`,
      );
    if (camError) lines.push(`Camera error: ${camError}`);
    if (upd.kind === "error") lines.push(`Update check: ${upd.message}`);
    if (guard)
      lines.push(
        `Guard ${guard.version}, sinkhole on ${guard.sinkhole.join(" ") || "none"}, ${guard.attempts.length} attempts seen${guard.blocking ? `, layers: hosts ${(guard.layers ?? []).join(" ")}, hosts file ${guard.hostsOk === false ? "REVERTED" : "ok"}` : ""}`,
      );
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
    loadCameras();
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
      <button onclick={startUpdate}>Restart to update</button>
    </div>
  {/if}
  <header>
    <p class="eyebrow">Test build {about.app}</p>
    <h1>The new camera engine</h1>
    <p class="lede">Steps 1 to 3 of the camera plan. Run the speed test, leave the live check running while you study, and record a few test clips when you have ten minutes. Tap the checks at the bottom and copy your results into the chat.</p>
  </header>

  <section>
    <div class="head">
      <span class="num">1</span>
      <div>
        <h2>Camera speed test</h2>
        <p>Times the new phone and posture models on your PC, on the CPU and on the graphics chip. They run in a separate background program with no internet access, and the picture never leaves memory.</p>
      </div>
    </div>
    <CameraBench {camId} live={camState === "running" ? video : null} bind:text={benchSummary} />
  </section>

  <section>
    <div class="head">
      <span class="num">2</span>
      <div>
        <h2>Live camera check</h2>
        <p>The new engine running for real: here or away, phone in hand, someone else in the room, and whether the camera is working. It keeps going with this window minimised or closed to the tray. Nothing is saved; the picture only ever exists in memory.</p>
      </div>
    </div>
    <LiveCamera bind:text={liveSummary} />
  </section>

  <section>
    <div class="head">
      <span class="num">3</span>
      <div>
        <h2>Your test clips</h2>
        <p>Short clips of you studying the way you really do, so the detector can be checked and tuned on your desk, your light and your iPad. Each one tells you what to do. They stay on this PC, and you can delete them any time.</p>
      </div>
    </div>
    <TestClips bind:text={clipsSummary} />
  </section>

  <section>
    <div class="head">
      <span class="num">4</span>
      <div>
        <h2>Today's camera check</h2>
        <p>The current models, running inside the app window, for comparison. Opens your camera and checks twice a second.</p>
      </div>
    </div>

    <div class="cam">
      <div class="frame">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} muted playsinline></video>
        {#if camState !== "running"}<div class="veil">{camState === "loading" ? "Loading models..." : "Camera off"}</div>{/if}
      </div>
      <div class="side">
        {#if cams.length}
          <label>Camera
            <select value={camId} onchange={(e) => pickCamera(e.currentTarget.value)} disabled={camState === "loading"}>
              {#each cams as c, i}<option value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>{/each}
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
      <span class="num">4</span>
      <div>
        <h2>Site blocking</h2>
        <p>Installs Lock In Guard, then blocks the sites below in every browser for a few minutes. YouTube stays open for studying.</p>
      </div>
    </div>

    {#if !inTauri}
      <p class="err">Open this inside the installed app; the browser preview can't reach the Guard.</p>
    {:else if !guard}
      <p>The Guard isn't running yet.</p>
      <button onclick={() => setup("install")} disabled={busy}>Install Lock In Guard</button>
    {:else}
      {#if about.app && guard.version !== about.app}
        <div class="update">
          <span>The Guard needs an update to {about.app} (it's on {guard.version}). Windows will ask for admin once.</span>
          <button onclick={() => setup("install")} disabled={busy}>Update the Guard</button>
        </div>
      {/if}
      <p class="ok">Guard {guard.version} is running.{guard.sinkhole.length ? "" : " (Attempt tracking is off: ports 80 and 443 are in use by something else.)"}</p>
      {#if guard.blocking}
        <div class="live">
          <strong>Blocking for {fmt(guard.secondsLeft)}</strong>
          <span>{guard.hosts.length} site names, YouTube in study mode</span>
          <button class="ghost" onclick={unblock}>Unblock now</button>
        </div>
        {#if guard.layers}<p class="msg">Blocked through: hosts file{guard.layers.length ? `, ${guard.layers.join(", ")}` : ""}</p>{/if}
        {#if guard.hostsOk === false}<p class="err">Something (probably antivirus) took the block back out of the hosts file. Tell Claude.</p>{/if}
      {:else}
        <div class="row">
          <select bind:value={minutes} aria-label="How long">
            <option value={1}>1 min</option><option value={2}>2 min</option><option value={5}>5 min</option><option value={25}>25 min</option>
          </select>
          <button onclick={block}>Block for {minutes} min</button>
        </div>
      {/if}
      <SiteList bind:sites locked={guard.blocking} />
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
      <span class="num">5</span>
      <div>
        <h2>Closing apps</h2>
        <p>Games, game launchers and anything else you pick stay closed for the whole round. Open one and it closes again within a few seconds.</p>
      </div>
    </div>
    {#if guard}
      <AppList bind:rows={appRows} {installed} locked={guard.blocking} loading={appsLoading} needGuard={appsNeedGuard} onlookagain={lookAgain} />
    {:else}<p>Install the Guard in step 4 first.</p>{/if}
  </section>

  <section class="results">
    <h2>Your results</h2>
    {#each ["Camera speed test", "Live camera check", "Camera", "Blocking", "Study YouTube", "Apps"] as g}
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

{#if updating}<UpdatingCard version={updating.version} error={updating.error} onclose={() => (updating = null)} />{/if}

{#if caught}{#key caught}<CaughtCard name={caught.name} secondsLeft={caught.secondsLeft} ondone={() => (caught = null)} />{/key}{/if}
