<script lang="ts">
  // The sites a round blocks: popular distractions on from the start, each with a switch,
  // plus any the person adds. Changes are remembered on this computer.
  import { cleanSite, saveSites, type Site } from "./sites";

  let { sites = $bindable(), locked = false }: { sites: Site[]; locked?: boolean } = $props();

  let adding = $state("");
  let addError = $state("");
  const onCount = $derived(sites.filter((s) => s.on).length);

  function toggle(id: string) {
    sites = sites.map((s) => (s.id === id ? { ...s, on: !s.on } : s));
    saveSites(sites);
  }

  function add(e: Event) {
    e.preventDefault();
    const h = cleanSite(adding);
    if (!h) {
      addError = "That doesn't look like a site. Try something like example.com.";
      return;
    }
    const existing = sites.find((s) => s.hosts.includes(h));
    if (existing) {
      if (!existing.on) toggle(existing.id);
      addError = `${existing.name} is already on the list${existing.on ? "" : ", and it's switched on now"}.`;
      adding = "";
      return;
    }
    sites = [...sites, { id: `custom:${h}`, name: h, hosts: [h], on: true, custom: true }];
    saveSites(sites);
    adding = "";
    addError = "";
  }

  function remove(id: string) {
    sites = sites.filter((s) => s.id !== id);
    saveSites(sites);
  }
</script>

<div class="top">
  <h3>Blocked during a round</h3>
  <span class="count">{onCount} of {sites.length} on</span>
</div>
{#if locked}<p class="msg">Changes apply from your next round.</p>{/if}

<ul class="sites">
  {#each sites as s (s.id)}
    <li class:off={!s.on}>
      <label class="switch">
        <input type="checkbox" checked={s.on} onchange={() => toggle(s.id)} />
        <span class="name">{s.name}</span>
        {#if s.note}<span class="note">{s.note}</span>{/if}
      </label>
      {#if s.custom}<button class="link small-link" onclick={() => remove(s.id)} aria-label={`Remove ${s.name}`}>Remove</button>{/if}
    </li>
  {/each}
</ul>

<form class="row" onsubmit={add}>
  <input bind:value={adding} placeholder="Add another site, like coolmathgames.com" aria-label="Add another site" />
  <button type="submit" class="ghost" disabled={!adding.trim()}>Add site</button>
</form>
{#if addError}<p class="msg" role="status">{addError}</p>{/if}

<style>
  .top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .top h3 { margin-top: 4px; }
  .count { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .sites { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 2px 18px; margin: 4px 0 6px; }
  .sites li { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--line); min-height: 40px; }
  .switch { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: 15px; color: var(--ink); cursor: pointer; padding: 6px 0; flex: 1; min-width: 0; }
  .switch input { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--moss); cursor: pointer; }
  .switch input:focus-visible { outline: 2px solid var(--moss); outline-offset: 2px; }
  .name { font-weight: 600; }
  .off .name { color: var(--muted); font-weight: 400; }
  .note { flex-basis: 100%; padding-left: 28px; font-size: 12px; color: var(--muted); }
  .small-link { padding: 4px 0; font-size: 13px; }
</style>
