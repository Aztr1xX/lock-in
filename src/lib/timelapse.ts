// Time-lapse snapshots live in IndexedDB in this browser. One record per frame,
// keyed "<sessionId>:<frame number>", so saving a frame never rewrites the others.

const DB = "lockin";
const STORE = "frames";

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbp.catch(() => (dbp = null));
  return dbp;
}

const range = (id: string) => IDBKeyRange.bound(`${id}:`, `${id}:￿`);
const key = (id: string, n: number) => `${id}:${String(n).padStart(6, "0")}`;

export async function addFrame(id: string, n: number, blob: Blob) {
  try {
    const d = await db();
    d.transaction(STORE, "readwrite").objectStore(STORE).put(blob, key(id, n));
  } catch {
    /* storage blocked or full: skip this frame */
  }
}

export async function getFrames(id: string): Promise<Blob[]> {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const req = d.transaction(STORE).objectStore(STORE).getAll(range(id));
      req.onsuccess = () => resolve(req.result as Blob[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function deleteFrames(id: string) {
  try {
    const d = await db();
    d.transaction(STORE, "readwrite").objectStore(STORE).delete(range(id));
  } catch {
    /* nothing to delete */
  }
}
