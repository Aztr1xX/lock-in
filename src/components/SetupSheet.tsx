import { useEffect } from "react";
import type { Helpers } from "../lib/bridge";
import { IconClose } from "./Icons";

interface Props {
  helpers: Helpers;
  onClose: () => void;
}

export default function SetupSheet({ helpers, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="setup-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="setup-title">Blocking</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button>
        </header>
        <p className="hint">Two small add-ons switch on by themselves when you press Start. You only set them up once.</p>

        <section className="set-group">
          <h3>1 · Site blocker for Chrome</h3>
          <div className={`setup-status ${helpers.blocker ? "on" : ""}`}>
            <span className="helper-dot" />
            {helpers.blocker ? (
              <span><b>Connected.</b> Twitch, game sites and non-study YouTube get blocked the moment you press Start.</span>
            ) : (
              <span><b>Not set up yet.</b> This is what stops you wandering off to Twitch.</span>
            )}
          </div>
          {!helpers.blocker && (
            <ol className="setup-steps">
              <li>
                <b>Download it</b>
                <span>Unzip <code>lock-in-blocker.zip</code> somewhere it can stay, like your Documents folder.</span>
                <a className="ghost-btn" href="/lock-in-blocker.zip" download>Download blocker</a>
              </li>
              <li>
                <b>Open Chrome's extensions page</b>
                <span>Type <code>chrome://extensions</code> in the address bar and switch on <b>Developer mode</b> (top right).</span>
              </li>
              <li>
                <b>Load it</b>
                <span>Click <b>Load unpacked</b> and pick the <code>lock-in-blocker</code> folder. The dot here turns green straight away.</span>
              </li>
            </ol>
          )}
        </section>

        <section className="set-group">
          <h3>2 · Game closer for Windows</h3>
          <div className={`setup-status ${helpers.closer ? "on" : ""}`}>
            <span className="helper-dot" />
            {helpers.closer ? (
              <span><b>Running.</b> Steam, Minecraft and Valorant get closed if they open mid-session.</span>
            ) : helpers.blocker ? (
              <span><b>Not running.</b> Set it up to close Steam, Minecraft and Valorant during sessions.</span>
            ) : (
              <span><b>Set up the site blocker first.</b> The game closer talks to the app through it.</span>
            )}
          </div>
          {!helpers.closer && (
            <ol className="setup-steps">
              <li>
                <b>Download it</b>
                <span>Unzip <code>lock-in-game-closer.zip</code> anywhere.</span>
                <a className="ghost-btn" href="/lock-in-game-closer.zip" download>Download game closer</a>
              </li>
              <li>
                <b>Run Install.cmd</b>
                <span>Double-click it. If Windows shows "Windows protected your PC", click <b>More info</b>, then <b>Run anyway</b>. It's a short script you can open and read.</span>
              </li>
              <li>
                <b>Look for the green ring</b>
                <span>It sits in your system tray by the clock and starts with Windows from now on. No admin rights needed.</span>
              </li>
            </ol>
          )}
        </section>

        <section className="set-group">
          <h3>What gets blocked</h3>
          <p className="hint">Twitch and game sites like Poki, CrazyGames, Roblox and the Steam store. Click the extension's icon in Chrome to add or remove sites (not mid-session, nice try).</p>
          <p className="hint">YouTube stays open, but only videos YouTube files under Education or Science &amp; Technology will play. The home feed and Shorts are off. If a real study video gets caught, you can allow that channel after a 30 second wait.</p>
          <p className="hint">Closing the Lock In tab doesn't switch any of this off. It stays on for 15 more minutes unless you end the session properly.</p>
        </section>
      </aside>
    </div>
  );
}
