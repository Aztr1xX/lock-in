<script lang="ts">
  // Shown over the app when a round closes an app the person opened, in the same voice as the
  // browser's "This can wait." page, so it's clear Lock In closed it on purpose.
  import { onMount, untrack } from "svelte";

  let { name, secondsLeft, ondone }: { name: string; secondsLeft: number; ondone: () => void } = $props();

  // The parent remounts this card for each new closing, so the starting value is all it needs.
  const start = untrack(() => secondsLeft);
  const end = Date.now() + start * 1000;
  let left = $state(start);
  let button: HTMLButtonElement | undefined = $state();

  const when = $derived(left <= 0 ? "Your round is over. You can open it now." : left < 60 ? "Back in under a minute." : `Back in ${Math.ceil(left / 60)} minutes.`);

  onMount(() => {
    button?.focus();
    const t = setInterval(() => (left = Math.max(0, Math.round((end - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  });

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") ondone();
  }
</script>

<svelte:window onkeydown={key} />

<div class="veil" role="dialog" aria-modal="true" aria-labelledby="caught-title">
  <div class="card">
    <span class="mark">Lock In</span>
    <h1 id="caught-title">This can wait.</h1>
    <p>Lock In closed <span class="app">{name}</span> because you're in a focus round.</p>
    <p>Nothing is wrong with your computer. It'll open normally after the round.</p>
    <p class="when">{when}</p>
    <button bind:this={button} onclick={ondone}>Back to studying</button>
  </div>
</div>

<style>
  .veil {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--paper);
    animation: fade 0.18s ease-out;
  }
  .card { width: min(30rem, 100%); max-height: 100%; overflow: auto; text-align: center; }
  .mark { display: inline-block; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--moss); margin-bottom: 28px; }
  h1 { font: 600 clamp(40px, 8vw, 64px) / 1.05 Georgia, "Times New Roman", serif; margin: 0 0 18px; letter-spacing: -0.01em; color: var(--ink); }
  p { margin: 0 0 8px; color: var(--muted); font-size: 17px; line-height: 1.55; }
  .app { color: var(--ink); font-weight: 600; }
  .when { margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--ink); font-variant-numeric: tabular-nums; }
  button { margin-top: 20px; }
  @keyframes fade { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .veil { animation: none; } }
</style>
