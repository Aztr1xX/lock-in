import { useEffect, useState } from "react";

export interface ToastData {
  id: number;
  icon: string;
  text: string;
  action?: { label: string; run: () => void };
}

const LIFE = 5_000;

/** One gentle message at the top of the screen. Fades out by itself. */
export default function Toast({ toast, onDone }: { toast: ToastData | null; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setLeaving(false);
    const life = LIFE;
    const a = setTimeout(() => setLeaving(true), life);
    const b = setTimeout(onDone, life + 400);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [toast, onDone]);
  if (!toast) return null;
  return (
    <div className={`toast ${leaving ? "leaving" : ""}`} role="status" key={toast.id}>
      <span className="toast-icon" aria-hidden="true">{toast.icon}</span>
      <span className="toast-text">{toast.text}</span>
      {toast.action && (
        <button className="toast-action" onClick={() => { toast.action!.run(); onDone(); }}>
          {toast.action.label}
        </button>
      )}
      <button className="toast-x" aria-label="Dismiss" onClick={onDone}>×</button>
      <span className="toast-timer" style={{ animationDuration: `${LIFE}ms` }} aria-hidden="true" />
    </div>
  );
}
