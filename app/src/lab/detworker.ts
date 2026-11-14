// Web Worker of the tile pool (tilepool.ts): one IMAGE-mode MediaPipe ObjectDetector (CPU / wasm) per worker, so the tiles
// of a frame run in parallel off the main thread. Messages: {init: {wasm, model, scoreThreshold, allow}} -> {ready} |
// {error}; {id, bmp: ImageBitmap} -> {id, dets} (the bitmap is closed after use).
import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";

type InitMsg = { init: { wasm: string; model: string; scoreThreshold: number; allow: string[] } };
type JobMsg = { id: number; bmp: ImageBitmap };
const ctx = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<InitMsg | JobMsg>) => void) | null };
let det: ObjectDetector | null = null;

/** A module worker (Vite dev) cannot importScripts: MediaPipe then needs its ES-module wasm loader. */
function moduleWorker(): boolean {
  try { (self as unknown as { importScripts: () => void }).importScripts(); return false; } catch { return true; }
}

ctx.onmessage = async (e) => {
  const m = e.data;
  if ("init" in m) {
    try {
      const fileset = await FilesetResolver.forVisionTasks(m.init.wasm, moduleWorker());
      det = await ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: m.init.model, delegate: "CPU" },
        runningMode: "IMAGE", scoreThreshold: m.init.scoreThreshold, categoryAllowlist: m.init.allow, maxResults: 100,
      });
      ctx.postMessage({ ready: true });
    } catch (err) { ctx.postMessage({ error: String(err) }); }
    return;
  }
  try {
    const dets = det ? det.detect(m.bmp).detections : [];
    ctx.postMessage({ id: m.id, dets: dets.map((d) => ({ boundingBox: d.boundingBox, categories: d.categories })) });
  } catch (err) {
    ctx.postMessage({ id: m.id, error: String(err) });
  } finally { m.bmp.close(); }
};
