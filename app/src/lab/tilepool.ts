// Pool of detector Web Workers (detworker.ts) for the tiled people pass of the clip mode: the tiles of a frame are cut as
// ImageBitmaps and detected in parallel (one IMAGE-mode detector per worker, CPU / wasm), while the main thread runs the
// full-frame VIDEO pass. Same model, same thresholds, same pixels as the main-thread pass, so the same detections.
// Falls back (getTilePool resolves null) when workers or OffscreenCanvas are missing or a worker fails to start.
import type { RawDetection } from "./players.ts";
import type { Box } from "./teams.ts";

/**
 * start: cuts the tiles (the canvas is snapshotted) and hands them to the workers; resolves once they are posted, with
 * `done`, the detections per tile in tile order. The caller can run the full-frame pass meanwhile, then await `done`.
 */
export type TilePool = { size: number; start(src: HTMLCanvasElement, tiles: Box[]): Promise<{ done: Promise<RawDetection[][]> }>; close(): void };
export type PoolInit = { wasm: string; model: string; scoreThreshold: number; allow: string[] };

/**
 * Workers to start: leave a core for the main thread (full-frame pass, lines, calibration) and one spare, at most `max`
 * (8 cores, headless Chromium, 15 tiles of 384 px: 4 workers 845 ms/frame, 6 workers 685 ms/frame, main thread ~2.6 s).
 */
export function poolSize(cores: number | undefined, max = 6): number {
  const c = Number.isFinite(cores) && cores! > 0 ? Math.floor(cores!) : 2;
  return Math.max(0, Math.min(max, c - 2));
}

/** Dynamic dispatch: the next job goes to the first idle worker (-1: all busy). */
export function nextIdle(busy: boolean[]): number { return busy.indexOf(false); }

const pools = new Map<string, Promise<TilePool | null>>();

export function getTilePool(init: PoolInit, size: number): Promise<TilePool | null> {
  const key = `${init.model}|${size}`;
  let p = pools.get(key);
  if (!p) { p = startPool(init, size); pools.set(key, p); }
  return p;
}

async function startPool(init: PoolInit, size: number): Promise<TilePool | null> {
  if (size < 1 || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return null;
  const workers: Worker[] = [];
  try {
    for (let i = 0; i < size; i++) workers.push(new Worker(new URL("./detworker.ts", import.meta.url), { type: "module" }));
    await Promise.all(workers.map((w) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker start timeout")), 60000);
      w.onmessage = (e) => { clearTimeout(timer); if (e.data?.ready) resolve(); else reject(new Error(e.data?.error ?? "worker failed")); };
      w.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message)); };
      w.postMessage({ init });
    })));
  } catch (err) {
    console.warn("tile pool unavailable, tiles run on the main thread:", err);
    workers.forEach((w) => w.terminate());
    return null;
  }
  const busy = workers.map(() => false);
  let nextId = 1;
  const waiting = new Map<number, { resolve: (d: RawDetection[]) => void; reject: (e: Error) => void; worker: number }>();
  const queue: { id: number; bmp: ImageBitmap }[] = [];
  const pump = () => {
    for (let k = nextIdle(busy); k >= 0 && queue.length; k = nextIdle(busy)) {
      const job = queue.shift()!;
      busy[k] = true;
      waiting.get(job.id)!.worker = k;
      workers[k]!.postMessage(job, [job.bmp]);
    }
  };
  workers.forEach((w, k) => {
    w.onmessage = (e) => {
      const m = e.data as { id: number; dets?: RawDetection[]; error?: string };
      const job = waiting.get(m.id);
      busy[k] = false;
      if (job) { waiting.delete(m.id); if (m.error) job.reject(new Error(m.error)); else job.resolve(m.dets ?? []); }
      pump();
    };
  });
  return {
    size,
    async start(src, tiles) {
      const bmps = await Promise.all(tiles.map((t) => createImageBitmap(src, t.x, t.y, t.w, t.h)));
      const out = bmps.map((bmp) => new Promise<RawDetection[]>((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { resolve, reject, worker: -1 });
        queue.push({ id, bmp });
      }));
      pump();
      return { done: Promise.all(out) };
    },
    close() { workers.forEach((w) => w.terminate()); },
  };
}
