<script lang="ts">
  // Apps closed during a round: what the Guard found installed, sorted into games, launchers,
  // chat and media, each with a switch. Other installed apps can be added from the box below.
  import { cleanExe, KIND_LABEL, saveApps, type AppRow, type InstalledApp } from "./apps";

  let {
    rows = $bindable(),
    installed,
    locked = false,
    loading = false,
    needGuard = false,
    onlookagain,
  }: { rows: AppRow[]; installed: InstalledApp[]; locked?: boolean; loading?: boolean; needGuard?: boolean; onlookagain?: () => void } = $props();

  let adding = $state("");
  let addError = $state("");
  const onCount = $derived(rows.filter((r) => r.on).length);
  const others = $derived(installed.filter((a) => a.kind === "other" && !rows.some((r) => r.name === a.name)));

  function toggle(name: string) {
    rows = rows.map((r) => (r.name === name ? { ...r, on: !r.on } : r));
    saveApps(rows);
  }

  function add(e: Event) {
    e.preventDefault();
    const typed = adding.trim();
    if (!typed) return;
    const found = installed.find((a) => a.name.toLowerCase() === typed.toLowerCase());
    const existing = rows.find((r) => r.name.toLowerCase() === typed.toLowerCase() || r.exes.some((x) => x.toLowerCase() === typed.toLowerCase()));
    if (existing) {
      if (!existing.on) toggle(existing.name);
      addError = `${existing.name} is already on the list${existing.on ? "" : ", and it's switched on now"}.`;
      adding = "";
      return;
    }
    let app: InstalledApp | null = found ?? null;
    if (!app) {
      const exe = cleanExe(typed);
      if (!exe) {
        addError = "Type an app from the suggestions, or a program name like game.exe.";
        return;
      }
      app = { name: exe, exes: [exe], kind: "other" };
    }
    rows = [...rows, { ...app, on: true, custom: true }];
    saveApps(rows);
    adding = "";
    addError = "";
  }

  function remove(name: string) {
    rows = rows.filter((r) => r.name !== name);
    saveApps(rows);
  }
</script>

<div class="top">
  <h3>Closed during a round</h3>
  <span class="count">{onCount} of {rows.length} on</span>
</div>
{#if locked}<p class="msg">Changes apply from your next round.</p>{/if}

{#if loading}
  <p class="msg">Looking for installed apps...</p>
{:else if needGuard}
  <p class="msg">Click Update the Guard above, and your games and launchers will show here.</p>
{:else if !rows.length}
  <p class="msg">No games, launchers or chat apps found on this PC. Add any app below, or <button class="link inline-link" onclick={() => onlookagain?.()}>look again</button>.</p>
{:else}
  <ul class="apps">
    {#each rows as r (r.name)}
      <li class:off={!r.on}>
        <label class="switch">
          <input type="checkbox" checked={r.on} onchange={() => toggle(r.name)} />
          <span class="name">{r.name}</span>
          <span class="kind">{KIND_LABEL[r.kind] ?? "App"}</span>
        </label>
        {#if r.custom}<button class="link small-link" onclick={() => remove(r.name)} aria-label={`Remove ${r.name}`}>Remove</button>{/if}
      </li>
    {/each}
  </ul>
{/if}

<form class="row" onsubmit={add}>
  <input bind:value={adding} list="installed-apps" placeholder="Add another app, like Spotify or game.exe" aria-label="Add another app" />
  <datalist id="installed-apps">
    {#each others as a (a.name)}<option value={a.name}></option>{/each}
  </datalist>
  <button type="submit" class="ghost" disabled={!adding.trim()}>Add app</button>
</form>
{#if addError}<p class="msg" role="status">{addError}</p>{/if}

<style>
  .top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .count { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .apps { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 2px 18px; margin: 4px 0 6px; }
  .apps li { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--line); min-height: 40px; }
  .switch { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: 15px; color: var(--ink); cursor: pointer; padding: 6px 0; flex: 1; min-width: 0; }
  .switch input { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--moss); cursor: pointer; }
  .switch input:focus-visible { outline: 2px solid var(--moss); outline-offset: 2px; }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  .off .name { color: var(--muted); font-weight: 400; }
  .kind { flex-basis: 100%; padding-left: 28px; font-size: 12px; color: var(--muted); }
  .inline-link { padding: 0; font-size: inherit; }
  .small-link { padding: 4px 0; font-size: 13px; }
</style>
