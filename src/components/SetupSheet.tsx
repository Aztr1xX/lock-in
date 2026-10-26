import { useEffect } from "react";
import { IconClose } from "./Icons";

interface Props {
  blocker: boolean;
  onClose: () => void;
}

export default function SetupSheet({ blocker, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="setup-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="setup-title">Site blocking</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button>
        </header>

        <div className={`setup-status ${blocker ? "on" : ""}`}>
          <span className="helper-dot" />
          {blocker ? (
            <span><b>Connected.</b> Twitch, game sites and non-study YouTube get blocked the moment you press Start.</span>
          ) : (
            <span><b>Not set up yet.</b> The app works fine without it, but this is what stops you wandering off to Twitch.</span>
          )}
        </div>

        {!blocker && (
          <ol className="setup-steps">
            <li>
              <b>Download the blocker</b>
              <span>Get <code>lock-in-blocker.zip</code> and unzip it somewhere it can stay, like your Documents folder.</span>
              <a className="ghost-btn" href="/lock-in-blocker.zip" download>Download</a>
            </li>
            <li>
              <b>Open Chrome's extensions page</b>
              <span>Type <code>chrome://extensions</code> in the address bar and switch on <b>Developer mode</b> (top right).</span>
            </li>
            <li>
              <b>Load it</b>
              <span>Click <b>Load unpacked</b> and pick the unzipped <code>lock-in-blocker</code> folder. Pin it from the puzzle icon if you like.</span>
            </li>
            <li>
              <b>Come back here</b>
              <span>This page notices it straight away. The dot turns green.</span>
            </li>
          </ol>
        )}

        <section className="set-group">
          <h3>What gets blocked</h3>
          <p className="hint">Twitch and game sites like Poki, CrazyGames, Roblox and the Steam store. Click the extension's icon to add or remove sites (not mid-session, nice try).</p>
          <p className="hint">YouTube stays open, but only videos YouTube files under Education or Science &amp; Technology will play. The home feed and Shorts are off. If a real study video gets caught, you can allow that channel after a 30 second wait.</p>
          <p className="hint">Closing this tab doesn't turn blocking off. It stays on for 15 more minutes unless you end the session properly.</p>
        </section>
      </aside>
    </div>
  );
}
