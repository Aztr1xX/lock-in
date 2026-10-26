import { useEffect, useRef, useState } from "react";
import { getFrames } from "../lib/timelapse";
import { fmtDur } from "../lib/timer";

interface Props {
  sessionId: string;
  durationMs: number;
  autoPlay?: boolean;
}

const FPS = 30;

/** Plays a session's snapshots back as a sped-up video, drawn on a canvas. */
export default function Timelapse({ sessionId, durationMs, autoPlay = true }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [images, setImages] = useState<HTMLImageElement[] | null>(null);
  const [playing, setPlaying] = useState(autoPlay);
  const [frame, setFrame] = useState(0);
  const [saving, setSaving] = useState<"idle" | "busy" | string>("idle");
  const urls = useRef<string[]>([]);

  useEffect(() => {
    let dead = false;
    getFrames(sessionId).then(async (blobs) => {
      const list = await Promise.all(
        blobs.map(
          (b) =>
            new Promise<HTMLImageElement>((resolve) => {
              const url = URL.createObjectURL(b);
              urls.current.push(url);
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = () => resolve(img);
              img.src = url;
            }),
        ),
      );
      if (!dead) setImages(list);
    });
    return () => {
      dead = true;
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      urls.current = [];
    };
  }, [sessionId]);

  const draw = (i: number) => {
    const c = canvas.current;
    const img = images?.[i];
    if (!c || !img) return;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0, c.width, c.height);
    // Running clock in the corner, like a real time-lapse.
    const t = images!.length > 1 ? (i / (images!.length - 1)) * durationMs : 0;
    const label = `+${fmtDur(t)}`;
    g.font = "600 13px 'JetBrains Mono', Consolas, monospace";
    const w = g.measureText(label).width + 14;
    g.fillStyle = "rgba(8,14,17,0.65)";
    g.beginPath();
    g.roundRect(c.width - w - 10, c.height - 30, w, 22, 11);
    g.fill();
    g.fillStyle = "#e9f2ee";
    g.fillText(label, c.width - w - 3, c.height - 14);
  };

  useEffect(() => {
    if (!images?.length) return;
    draw(frame);
    if (!playing) return;
    const id = setTimeout(() => setFrame((f) => (f + 1) % images.length), 1000 / FPS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, frame, playing]);

  const save = async () => {
    const c = canvas.current;
    if (!c || !images?.length || typeof MediaRecorder === "undefined") return;
    setSaving("busy");
    setPlaying(false);
    const rec = new MediaRecorder(c.captureStream(FPS), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start();
    for (let i = 0; i < images.length; i++) {
      draw(i);
      await new Promise((r) => setTimeout(r, 1000 / FPS));
    }
    rec.stop();
    await stopped;
    setSaving(URL.createObjectURL(new Blob(chunks, { type: "video/webm" })));
  };

  if (images === null) return <div className="tl tl-empty">Loading time-lapse…</div>;
  if (!images.length) return null;

  const secs = Math.max(1, Math.round(images.length / FPS));
  return (
    <div className="tl">
      <canvas ref={canvas} width={320} height={240} className="tl-canvas" onClick={() => setPlaying((p) => !p)} />
      <div className="tl-bar">
        <button className="ghost-btn" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
        <input
          id={`tl-scrub-${sessionId}`}
          type="range"
          min={0}
          max={images.length - 1}
          value={frame}
          aria-label="Scrub time-lapse"
          onChange={(e) => { setPlaying(false); setFrame(Number(e.target.value)); }}
        />
        <span className="tl-len">{secs}s</span>
        {saving === "idle" ? (
          <button className="ghost-btn" onClick={save}>Save video</button>
        ) : saving === "busy" ? (
          <span className="tl-len">Making video…</span>
        ) : (
          <a className="ghost-btn" href={saving} download={`lock-in-${sessionId}.webm`}>Download</a>
        )}
      </div>
    </div>
  );
}
