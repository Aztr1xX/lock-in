const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const IconChart = () => (
  <svg {...base}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
);
export const IconGear = () => (
  <svg {...base}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);
export const IconFlame = () => (
  <svg {...base}><path d="M12 22c4 0 7-2.7 7-7 0-3-1.6-5.4-3.4-7.3-.4 2-1.5 3.3-2.6 3.8.3-3.4-1.2-6.6-4-8.5.2 3.4-1.6 5.6-3.2 7.5C4.6 12.2 5 13.5 5 15c0 4.3 3 7 7 7z" /></svg>
);
export const IconPlus = () => (
  <svg {...base} width={16} height={16}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconPause = () => (
  <svg {...base}><path d="M9 5v14M15 5v14" /></svg>
);
export const IconPlay = () => (
  <svg {...base}><path d="M7 4l13 8-13 8z" /></svg>
);
export const IconStop = () => (
  <svg {...base}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
);
export const IconSkip = () => (
  <svg {...base}><path d="M5 4l10 8-10 8zM19 5v14" /></svg>
);
export const IconBack = () => (
  <svg {...base}><path d="M15 18l-6-6 6-6" /></svg>
);
export const IconClose = () => (
  <svg {...base}><path d="M18 6L6 18M6 6l12 12" /></svg>
);
export const IconLock = () => (
  <svg {...base}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);
export const IconTrash = () => (
  <svg {...base} width={16} height={16}><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
);
