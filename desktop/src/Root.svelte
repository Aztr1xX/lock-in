<script lang="ts">
  import App from "./App.svelte";
  import { isUnlocked, tryPassword } from "./lib/gate";

  let unlocked = $state(isUnlocked());
  let pw = $state("");
  let busy = $state(false);
  let wrong = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    wrong = false;
    unlocked = await tryPassword(pw);
    wrong = !unlocked;
    busy = false;
    if (!unlocked) pw = "";
  }
</script>

<div class="devbar">In development. This is an early test build of Lock In, not the finished app.</div>
{#if unlocked}
  <App />
{:else}
  <main class="gate">
    <form onsubmit={submit}>
      <p class="eyebrow">Lock In, in development</p>
      <h1>This build is private</h1>
      <label for="pw">Password</label>
      <input id="pw" type="password" inputmode="numeric" autocomplete="current-password" bind:value={pw} disabled={busy} />
      {#if wrong}<p class="err">That's not it. Try again.</p>{/if}
      <button type="submit" disabled={busy || !pw}>{busy ? "Checking..." : "Unlock"}</button>
    </form>
  </main>
{/if}
