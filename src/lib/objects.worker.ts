// Runs object detection off the main thread, so the timer and animations never stutter
// while it works.

import { type Crop, type Detectors, detectObjects, makeDetectors } from "./objects";

let detectors: Promise<Detectors> | null = null;
const probe = new OffscreenCanvas(160, 120);
const zoom = new OffscreenCanvas(320, 320);

self.onmessage = async (e: MessageEvent<{ id: number; frame?: ImageBitmap; crops?: Crop[]; base?: string }>) => {
  const { id, frame, crops, base } = e.data;
  try {
    if (base) {
      detectors ??= makeDetectors(base);
      await detectors;
      self.postMessage({ id, ready: true });
      return;
    }
    if (!frame || !detectors) return;
    const d = await detectors;
    const objects = detectObjects(d, frame, frame.width, frame.height, crops ?? [], probe, zoom);
    frame.close();
    self.postMessage({ id, objects });
  } catch (err) {
    frame?.close();
    self.postMessage({ id, error: String(err) });
  }
};
