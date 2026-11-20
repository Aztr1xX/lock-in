// Password screen for the in-development build. Only a salted, slow hash of the password is
// stored here (PBKDF2, 600,000 rounds), never the password itself. Once unlocked, this PC
// remembers it, so the password is asked for once per device.

const SALT = "tEHvGxxxcQGjmPlRq+XREg==";
const ROUNDS = 600_000;
const HASH = "Ht75SNU8Hdzk9a704Clhl6bPEQ25ny3Tc+FNEga9Uhw=";
const KEY = "lockin.unlocked";

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function isUnlocked(): boolean {
  try {
    return localStorage.getItem(KEY) === HASH;
  } catch {
    return false;
  }
}

export async function tryPassword(pw: string): Promise<boolean> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: b64(SALT), iterations: ROUNDS }, base, 256);
  const got = btoa(String.fromCharCode(...new Uint8Array(bits)));
  if (got !== HASH) return false;
  try {
    localStorage.setItem(KEY, HASH);
  } catch {
    /* storage blocked: ask again next time */
  }
  return true;
}
