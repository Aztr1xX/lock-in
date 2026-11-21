<script lang="ts">
  // Covers the app while an update installs. The installer itself runs silently, so this is
  // all the person sees before Lock In closes and opens again on the new version.
  let { version, error, onclose }: { version: string; error?: string; onclose: () => void } = $props();
</script>

<div class="veil" role="dialog" aria-modal="true" aria-labelledby="updating-title" aria-live="polite">
  <div class="card">
    <span class="mark">Lock In {version}</span>
    {#if error}
      <h1 id="updating-title">The update didn't install.</h1>
      <p>Lock In is still on the version you had, so nothing is lost. Try again in a minute, or download the new version from the releases page.</p>
      <p class="detail">{error}</p>
      <button onclick={onclose}>Back to Lock In</button>
    {:else}
      <h1 id="updating-title">Updating</h1>
      <div class="bar" aria-hidden="true"><span></span></div>
      <p>Lock In will close for a few seconds and open again by itself.</p>
    {/if}
  </div>
</div>

<style>
  .veil { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 24px; background: var(--paper); animation: fade 0.18s ease-out; }
  .card { width: min(28rem, 100%); text-align: center; }
  .mark { display: inline-block; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--moss); margin-bottom: 24px; font-variant-numeric: tabular-nums; }
  h1 { font: 600 clamp(36px, 7vw, 52px) / 1.05 Georgia, "Times New Roman", serif; margin: 0 0 22px; color: var(--ink); }
  p { margin: 0 0 8px; color: var(--muted); font-size: 16px; line-height: 1.55; }
  .detail { font-size: 13px; overflow-wrap: anywhere; }
  button { margin-top: 18px; }
  .bar { position: relative; height: 3px; width: 160px; margin: 0 auto 22px; background: var(--line); border-radius: 2px; overflow: hidden; }
  .bar span { position: absolute; inset: 0 auto 0 0; width: 40%; background: var(--moss); border-radius: 2px; animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
  @keyframes fade { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .veil { animation: none; }
    .bar span { animation: none; width: 100%; opacity: 0.5; }
  }
</style>
