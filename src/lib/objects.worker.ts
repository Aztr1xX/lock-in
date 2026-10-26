// Runs object and hand detection off the main thread, so the timer and animations
// never stutter while it works.

import { type Detectors, detectObjects, makeDetectors } from "./objects";

let detectors: Promise<Detectors> | null = null;
const probe = new OffscreenCanvas(320, 240);
const zoom = new OffscreenCanvas(320, 320);

self.onmessage = async (e: MessageEvent<{ id: number; frame?: ImageBitmap; base?: string }>) => {
  const { id, frame, base } = e.data;
  try {
    if (base) {
      detectors ??= makeDetectors(base);
      await detectors;
      self.postMessage({ id, ready: true });
      return;
    }
    if (!frame || !detectors) return;
    const d = await detectors;
    const found = detectObjects(d, frame, frame.width, frame.height, probe, zoom);
    frame.close();
    self.postMessage({ id, found });
  } catch (err) {
    frame?.close();
    self.postMessage({ id, error: String(err) });
  }
};
