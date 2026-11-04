import { useEffect, useRef, useState } from "react";
import { type CamDebug, type CamStatus, FocusCamera, listCameras } from "../lib/camera";
import type { Overlay, Settings } from "../lib/store";
import { IconClose } from "./Icons";
import { drawCam, nice } from "../lib/camDraw";

interface Props {
  /** The running session's camera. Without one, the check starts its own for a quick look. */
  cam: FocusCamera | null;
  settings: Settings;
  onClose: () => void;
  onToggleSelf?: () => void;
  onOverlay: (o: Overlay) => void;
  onCamera: (id: string) => void;
}

/** Each thing it can draw, as a toggle. The swatch doubles as the legend. */
const LAYERS: [keyof Overlay, string, string][] = [
  ["you", "You", "k-you"],
  ["face", "Face", "k-face"],
  ["head", "Head", "k-head"],
  ["shoulders", "Shoulders", "k-shoulder"],
  ["hands", "Hands", "k-wrist"],
  ["things", "Phone and objects", "k-phone"],
];

const W = 640, H = 480;

/** Shows what the camera sees and what it makes of it, live. Nothing leaves this PC. */
export default function CamCheck({ cam: sessionCam, settings, onClose, onToggleSelf, onOverlay, onCamera }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cam, setCam] = useState<FocusCamera | null>(sessionCam);
  const [status, setStatus] = useState<CamStatus>(sessionCam?.status ?? { state: "loading", present: false, faceVisible: false });
  const [dbg, setDbg] = useState<CamDebug | null>(null);
  const show = useRef(settings.overlay);
  show.current = settings.overlay;

  // A quick look from Home gets its own camera, switched off again on close.
  useEffect(() => {
    if (sessionCam) return;
    const own = new FocusCamera(settings.cam, () => {}, setStatus, () => {});
    own.setFeatures({ ...settings.cam, timelapse: false });
    void own.setCamera(settings.cameraId);
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
      if (!canvas.current || !drawCam(canvas.current, cam, show.current)) return;
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
  // Camera picker. Names only show once the camera has been allowed, so list them after it's on.
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [current, setCurrent] = useState("");
  useEffect(() => {
    if (!on || !cam) return;
    void listCameras().then(setCams);
    const id = setInterval(() => setCurrent(cam.currentCamera()), 500);
    return () => clearInterval(id);
  }, [on, cam]);
  const pick = (id: string) => {
    onCamera(id);
    void cam?.setCamera(id);
  };
  // "This is how I sit": a 3 second look that becomes your normal posture.
  const [setPose, setSetPose] = useState<"idle" | "busy" | "done" | "fail">("idle");
  const markPosture = async () => {
    if (!cam || setPose === "busy") return;
    setSetPose("busy");
    setSetPose((await cam.setGoodPosture()) ? "done" : "fail");
  };
  const slumpText = (s: string[]) => {
    const words: Record<string, string> = { sinking: "sinking down", "leaning in": "leaning in close", neck: "head pushed forward", "leaning sideways": "leaning to one side" };
    const list = s.map((x) => words[x] ?? x);
    return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0];
  };
  const usingNvidia = cams.some((c) => c.deviceId === current && /nvidia broadcast/i.test(c.label));
  const phones = dbg?.objects.filter((o) => o.verdict === "phone") ?? [];
  const things = dbg?.objects.filter((o) => o.verdict !== "you") ?? [];
  const rows: [string, string, "ok" | "warn" | "off"][] = dbg && on
    ? [
        ["You", dbg.present ? "At your desk" : "Not in view. After 10 seconds this pauses the timer.", dbg.present ? "ok" : "warn"],
        ["Face", dbg.faceVisible ? "Facing the screen" : dbg.lookingDown ? "Looking down. That's fine, it still counts." : dbg.present ? "Not visible. Fine as long as your shoulders are." : "Not visible", dbg.faceVisible || dbg.present ? "ok" : "off"],
        ["Eyes", !dbg.faceVisible ? "Only checked when you face the screen" : dbg.eyesClosed ? "Closed" : dbg.yawning ? "Yawning" : "Open", dbg.eyesClosed || dbg.yawning ? "warn" : dbg.faceVisible ? "ok" : "off"],
        dbg.posture === "off" ? ["Posture", "Not checking. Turned off in Settings.", "off"] : ["Posture", dbg.posture === "calibrating" ? "Learning how you normally sit…" : dbg.slumps.length ? `${slumpText(dbg.slumps)[0].toUpperCase() + slumpText(dbg.slumps).slice(1)}. Nudges if it lasts 3 minutes.` : dbg.posture === "good" || dbg.posture === "hunched" ? "Good" : "Needs your shoulders in view", dbg.slumps.length ? "warn" : dbg.posture === "good" ? "ok" : "off"],
        !settings.cam.phone ? ["Phone", "Not checking. Turned off in Settings.", "off"] : ["Phone", phones.length || dbg.phoneSure > 0
          ? `${phones.length ? phones[0].why[0].toUpperCase() + phones[0].why.slice(1) : "Not seen right now"}. ${Math.round(dbg.phoneSure * 100)}% sure you're on it. It only nudges at 100%, after about 8 steady seconds.`
          : "None in your hand", dbg.alert === "phone" ? "warn" : "ok"],
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

        {cams.length > 1 && (
          <label className="cc-camera">
            <span>Camera</span>
            <select value={current} onChange={(e) => pick(e.target.value)}>
              {cams.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
            </select>
          </label>
        )}
        {usingNvidia && <p className="hint cc-nv">Using NVIDIA Broadcast. Keep background blur on, and leave Auto Frame and Eye Contact off so it sees you as you are.</p>}

        <div className="cc-layers" role="group" aria-label="What to show on the camera">
          {LAYERS.map(([k, label, swatch]) => (
            <button
              key={k}
              className={`cc-layer ${settings.overlay[k] ? "on" : ""}`}
              aria-pressed={settings.overlay[k]}
              onClick={() => onOverlay({ ...settings.overlay, [k]: !settings.overlay[k] })}
            >
              <i className={swatch} />{label}
            </button>
          ))}
        </div>

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

        {on && settings.cam.posture && (
          <div className="cc-posture">
            <button className="ghost-btn" onClick={markPosture} disabled={setPose === "busy"}>
              {setPose === "busy" ? "Hold still…" : "This is how I sit"}
            </button>
            <span>
              {setPose === "done"
                ? "Saved. Posture is now measured against that."
                : setPose === "fail"
                  ? "Couldn't see both shoulders. Sit back a little and try again."
                  : "Sit the way you normally study, then tap. Otherwise it learns from your first sessions."}
            </span>
          </div>
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
          Hold up your phone, your calculator and your iPad one at a time to see how each is read. Only a
          phone-sized thing in or by your hand counts as your phone. Your card holder is fine.
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

