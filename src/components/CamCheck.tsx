import { useEffect, useRef, useState } from "react";
import { type CamDebug, type CamStatus, FocusCamera } from "../lib/camera";
import type { Settings } from "../lib/store";
import { IconClose } from "./Icons";
import { drawCam, nice } from "../lib/camDraw";

interface Props {
  /** The running session's camera. Without one, the check starts its own for a quick look. */
  cam: FocusCamera | null;
  settings: Settings;
  onClose: () => void;
  onToggleSelf?: () => void;
}

const W = 640, H = 480;

/** Shows what the camera sees and what it makes of it, live. Nothing leaves this PC. */
export default function CamCheck({ cam: sessionCam, settings, onClose, onToggleSelf }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cam, setCam] = useState<FocusCamera | null>(sessionCam);
  const [status, setStatus] = useState<CamStatus>(sessionCam?.status ?? { state: "loading", present: false, faceVisible: false });
  const [dbg, setDbg] = useState<CamDebug | null>(null);

  // A quick look from Home gets its own camera, switched off again on close.
  useEffect(() => {
    if (sessionCam) return;
    const own = new FocusCamera(settings.cam, () => {}, setStatus, () => {});
    own.setFeatures({ ...settings.cam, timelapse: false });
    setCam(own);
    void own.start().then(() => own.setFocusing(true));
    return () => own.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!cam) return;
    let raf = 0, last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (!canvas.current || !drawCam(canvas.current, cam)) return;
      if (t - last > 250) {
        last = t;
        setDbg({ ...cam.debug });
        setStatus(cam.status);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [cam]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const on = status.state === "on";
  const phones = dbg?.objects.filter((o) => o.verdict === "phone") ?? [];
  const things = dbg?.objects.filter((o) => o.verdict !== "you") ?? [];
  const rows: [string, string, "ok" | "warn" | "off"][] = dbg && on
    ? [
        ["You", dbg.present ? "At your desk" : "Not in view. After 10 seconds this pauses the timer.", dbg.present ? "ok" : "warn"],
        ["Face", dbg.faceVisible ? "Facing the screen" : dbg.lookingDown ? "Looking down. That's fine, it still counts." : dbg.present ? "Not visible. Fine as long as your shoulders are." : "Not visible", dbg.faceVisible || dbg.present ? "ok" : "off"],
        ["Eyes", !dbg.faceVisible ? "Only checked when you face the screen" : dbg.eyesClosed ? "Closed" : dbg.yawning ? "Yawning" : "Open", dbg.eyesClosed || dbg.yawning ? "warn" : dbg.faceVisible ? "ok" : "off"],
        ["Posture", dbg.posture === "calibrating" ? "Learning how you normally sit…" : dbg.posture === "hunched" ? "Hunched. Nudges after 3 minutes of this." : dbg.posture === "good" ? "Good" : "Needs your shoulders in view", dbg.posture === "hunched" ? "warn" : dbg.posture === "good" ? "ok" : "off"],
        ["Phone", phones.length ? `${phones[0].why[0].toUpperCase()}${phones[0].why.slice(1)}. Nudges after 3 sightings in 6 seconds (${Math.min(3, dbg.phoneHits)}/3).` : "None in your hand", phones.length ? "warn" : "ok"],
      ]
    : [];

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet cam-check" role="dialog" aria-modal="true" aria-labelledby="camcheck-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="camcheck-title">What the camera sees</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close camera check"><IconClose /></button>
        </header>

        <div className={`cc-view ${on ? "" : "waiting"}`}>
          <canvas ref={canvas} width={W} height={H} />
          {!on && (
            <p className="cc-wait">
              {status.state === "denied"
                ? "Camera is blocked. Click the camera icon in Chrome's address bar and allow it."
                : status.state === "error"
                  ? "Couldn't start the camera. Is another app using it?"
                  : "Starting the camera…"}
            </p>
          )}
        </div>

        <ul className="cc-legend" aria-hidden="true">
          <li><i className="k-head" />You</li>
          <li><i className="k-shoulder" />Shoulders</li>
          <li><i className="k-wrist" />Hands</li>
          <li><i className="k-phone" />Phone</li>
          <li><i className="k-ignored" />Ignored</li>
        </ul>

        {rows.length > 0 && (
          <dl className="cc-rows">
            {rows.map(([k, v, tone]) => (
              <div key={k} className={`cc-row ${tone}`}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}

        {things.length > 0 && (
          <div className="cc-objects">
            <h3>Things it spotted</h3>
            <ul>
              {things.map((o, i) => (
                <li key={i} className={o.verdict}>
                  <b>{o.verdict === "phone" ? "Phone" : nice(o.label)}</b>
                  <span>{o.why}</span>
                  <small>{Math.round(o.score * 100)}% sure</small>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="hint">
          Hold up your phone, your calculator and your iPad one at a time to see how each is read. Only a dark,
          phone-sized thing near your hand counts as your phone. Your card holder is fine.
        </p>
        {onToggleSelf && (
          <label className="toggle-row">
            <span>Show me in the corner<small>The little bubble at the top of the timer.</small></span>
            <input type="checkbox" className="toggle" checked={settings.showSelf} onChange={onToggleSelf} />
          </label>
        )}
        <p className="privacy">This picture is only on your screen. Nothing is recorded or uploaded.</p>
      </aside>
    </div>
  );
}

