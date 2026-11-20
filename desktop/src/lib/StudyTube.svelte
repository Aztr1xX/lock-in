<script lang="ts">
  // Study YouTube: search, see which videos count as study, and watch them here.
  // No feed, no comments, no recommendations. The Guard does the searching, so it keeps
  // working while youtube.com is blocked everywhere else.
  import { invoke } from "@tauri-apps/api/core";

  type Video = { id: string; title: string; channel: string; channelId: string; length: string; category: string; allowed: boolean; basis?: string };
  type Reply = { ok: boolean; verdict?: "study" | "fun" | "unsure"; results?: Video[]; error?: string };

  let { guardReady }: { guardReady: boolean } = $props();

  const KEY = "lockin.allowChannels";
  const ALLOW_WAIT_S = 15;

  let q = $state("");
  let phase = $state<"idle" | "loading" | "fun" | "error" | "done">("idle");
  let error = $state("");
  let results = $state<Video[]>([]);
  let playing = $state<Video | null>(null);
  let allowList = $state<{ id: string; name: string }[]>(loadAllowed());
  let pending = $state<{ video: Video; left: number } | null>(null);
  let timer = 0;

  function loadAllowed(): { id: string; name: string }[] {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "[]");
    } catch {
      return [];
    }
  }
  function saveAllowed() {
    try {
      localStorage.setItem(KEY, JSON.stringify(allowList));
    } catch {
      /* not remembered, but still works this session */
    }
  }

  async function search(e?: Event) {
    e?.preventDefault();
    const text = q.trim();
    if (!text || phase === "loading") return;
    phase = "loading";
    playing = null;
    try {
      const r = (await invoke("guard", { req: { cmd: "yt_search", q: text, allowChannels: allowList.map((c) => c.id) } })) as Reply;
      if (!r.ok) throw new Error(r.error ?? "unknown error");
      results = r.results ?? [];
      phase = r.verdict === "fun" ? "fun" : "done";
    } catch (err) {
      error = String(err).includes("not running") ? "Lock In Guard isn't running. Install it in step 2 first." : `Couldn't search: ${String(err).replace(/^Error: /, "")}`;
      phase = "error";
    }
  }

  function askAllow(v: Video) {
    clearInterval(timer);
    pending = { video: v, left: ALLOW_WAIT_S };
    timer = setInterval(() => {
      if (!pending) return clearInterval(timer);
      pending.left -= 1;
      if (pending.left <= 0) {
        clearInterval(timer);
        const v = pending.video;
        if (!allowList.some((c) => c.id === v.channelId)) allowList = [...allowList, { id: v.channelId, name: v.channel }];
        saveAllowed();
        results = results.map((r) => (r.channelId === v.channelId ? { ...r, allowed: true } : r));
        pending = null;
      }
    }, 1000) as unknown as number;
  }

  function cancelAllow() {
    clearInterval(timer);
    pending = null;
  }

  function removeAllowed(id: string) {
    allowList = allowList.filter((c) => c.id !== id);
    saveAllowed();
    results = results.map((r) => (r.channelId === id ? { ...r, allowed: ["Education", "Science & Technology"].includes(r.category) } : r));
  }

  const shown = $derived(results.filter((r) => r.allowed));
  const hidden = $derived(results.filter((r) => !r.allowed));
</script>

<form class="row" onsubmit={search}>
  <input bind:value={q} placeholder="What are you studying? e.g. integration by parts" aria-label="Search study videos" disabled={!guardReady} />
  <button type="submit" disabled={!guardReady || !q.trim() || phase === "loading"}>{phase === "loading" ? "Searching..." : "Search"}</button>
</form>

{#if !guardReady}
  <p class="msg">Install Lock In Guard in step 2 first. It does the searching, so this keeps working while YouTube is blocked.</p>
{:else if phase === "idle"}
  <p class="msg">Search for a topic. Videos filed under Education or Science &amp; Technology play here, and so do ones whose title is clearly about a topic. There's no feed and nothing plays next on its own.</p>
{:else if phase === "loading"}
  <p class="msg">Searching YouTube and checking what each video is filed under...</p>
{:else if phase === "fun"}
  <p class="err">That search looks like it's for fun, not study. Try searching for the topic you're working on.</p>
{:else if phase === "error"}
  <p class="err">{error}</p>
{/if}

{#if playing}
  <div class="player">
    <div class="screen">
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${playing.id}?autoplay=1&rel=0&modestbranding=1&iv_load_policy=3`}
        title={playing.title}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        referrerpolicy="strict-origin-when-cross-origin"
        allowfullscreen
      ></iframe>
    </div>
    <div class="row">
      <strong class="grow">{playing.title}</strong>
      <button class="ghost" onclick={() => (playing = null)}>Close video</button>
    </div>
  </div>
{/if}

{#if phase === "done"}
  {#if !results.length}
    <p class="msg">No videos found for that. Try different words.</p>
  {:else}
    {#if !shown.length}
      <p class="msg">None of these are filed as study videos. If one of them really is, you can allow its channel below.</p>
    {/if}
    <ul class="vids">
      {#each shown as v (v.id)}
        <li>
          <button class="vid" onclick={() => (playing = v)} aria-label={`Play ${v.title}`}>
            <img src={`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`} alt="" loading="lazy" width="160" height="90" />
            <span class="meta">
              <span class="title">{v.title}</span>
              <span class="sub">{v.channel} · {v.length}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
    {#if hidden.length}
      <h3>Not study videos ({hidden.length})</h3>
      <ul class="hidden-vids">
        {#each hidden as v (v.id)}
          <li>
            <span class="meta">
              <span class="title">{v.title}</span>
              <span class="sub">{v.channel} · {v.category ? `filed under ${v.category}` : "doesn't look like a study video"}</span>
            </span>
            {#if pending?.video.id === v.id}
              <button class="ghost small" onclick={cancelAllow}>Allowing in {pending.left}s · Cancel</button>
            {:else if v.channelId}
              <button class="ghost small" onclick={() => askAllow(v)} disabled={!!pending}>Allow this channel</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
{/if}

{#if allowList.length}
  <h3>Channels you've allowed</h3>
  <ul class="allowed">
    {#each allowList as c (c.id)}
      <li><span>{c.name}</span><button class="link" onclick={() => removeAllowed(c.id)}>Remove</button></li>
    {/each}
  </ul>
{/if}

<style>
  .grow { flex: 1; min-width: 0; }
  .player { margin: 14px 0; }
  .screen { position: relative; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: #111; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .vids { display: grid; gap: 4px; margin-top: 12px; }
  .vid { display: flex; gap: 14px; align-items: center; width: 100%; text-align: left; background: none; color: var(--ink); font-weight: 400; padding: 6px; border-radius: 10px; }
  .vid:hover, .vid:focus-visible { background: var(--paper); }
  .vid img { flex: none; width: 160px; height: 90px; object-fit: cover; border-radius: 6px; background: var(--line); }
  .meta { display: grid; gap: 2px; min-width: 0; }
  .title { font-weight: 600; line-height: 1.3; }
  .sub { color: var(--muted); font-size: 13px; }
  .hidden-vids li, .allowed li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
  .hidden-vids .title { font-weight: 400; color: var(--muted); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--moss); outline-offset: 2px; }
</style>
