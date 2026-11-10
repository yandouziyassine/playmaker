// Lazy MediaPipe ObjectDetector (EfficientDet-Lite0, IMAGE mode), with an optional tiled pass so the small
// players of a wide TV shot are seen at a usable resolution (the model looks at 320 x 320 pixels).
import { keepPersons, MIN_SCORE, type Person, type RawDetection } from "./players.ts";
import type { Box } from "./teams.ts";

/** Pinned to the installed npm version (checked by a unit test). The wasm (~15 MB per build) is loaded from the CDN. */
export const MEDIAPIPE_VERSION = "1.2.2";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_PATH = "lab/efficientdet_lite0.tflite"; // self-hosted, next to lab.html

type Detector = { detect(img: HTMLCanvasElement): { detections: RawDetection[] } };
let pending: Promise<Detector> | null = null;

export function loadDetector(): Promise<Detector> {
  pending ??= (async () => {
    const { FilesetResolver, ObjectDetector } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const make = (delegate: "GPU" | "CPU") => ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL(MODEL_PATH, document.baseURI).href, delegate },
      runningMode: "IMAGE", scoreThreshold: MIN_SCORE, categoryAllowlist: ["person"], maxResults: 100,
    });
    // CPU (wasm + XNNPACK) by default: ~75 ms per 320 px pass here, vs ~1 s on a software-WebGL GPU delegate.
    // ?gpu tries the WebGL delegate (falls back to CPU).
    if (!new URLSearchParams(location.search).has("gpu")) return make("CPU");
    try { return await make("GPU"); } catch { return await make("CPU"); }
  })();
  pending.catch(() => { pending = null; });
  return pending;
}

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/** Greedy non-maximum suppression; also drops a box mostly contained in a better one (tile-cut duplicates). */
export function nms(ps: Person[], thr = 0.45): Person[] {
  const sorted = [...ps].sort((a, b) => b.score - a.score);
  const out: Person[] = [];
  for (const p of sorted) {
    const dup = out.some((q) => {
      if (iou(p.box, q.box) > thr) return true;
      const x0 = Math.max(p.box.x, q.box.x), y0 = Math.max(p.box.y, q.box.y);
      const x1 = Math.min(p.box.x + p.box.w, q.box.x + q.box.w), y1 = Math.min(p.box.y + p.box.h, q.box.y + q.box.h);
      const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
      return inter > 0.7 * Math.min(p.box.w * p.box.h, q.box.w * q.box.h);
    });
    if (!dup) out.push(p);
  }
  return out;
}

/** Overlapping tiles covering a w x h image (cols x rows, ~20 % overlap). */
export function tiles(w: number, h: number, cols: number, rows: number, overlap = 0.2): Box[] {
  const tw = w / (cols - (cols - 1) * overlap), th = h / (rows - (rows - 1) * overlap);
  const out: Box[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    out.push({ x: Math.round(c * tw * (1 - overlap)), y: Math.round(r * th * (1 - overlap)), w: Math.round(tw), h: Math.round(th) });
  return out;
}

export type DetectRun = { persons: Person[]; ms: number; passes: number };

/** Full-image pass, plus a 3 x 2 tiled pass when `tiled`. Boxes are in source pixels. */
export async function detectPeople(src: HTMLCanvasElement, tiled: boolean): Promise<DetectRun> {
  const det = await loadDetector();
  const t0 = performance.now();
  let all = keepPersons(det.detect(src).detections);
  let passes = 1;
  if (tiled) {
    const crop = document.createElement("canvas");
    const cx = crop.getContext("2d")!;
    for (const t of tiles(src.width, src.height, 3, 2)) {
      crop.width = t.w; crop.height = t.h;
      cx.drawImage(src, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
      const found = keepPersons(det.detect(crop).detections).map((p) => ({ ...p, box: { ...p.box, x: p.box.x + t.x, y: p.box.y + t.y } }));
      all = all.concat(found);
      passes++;
    }
  }
  const persons = nms(all);
  return { persons, ms: performance.now() - t0, passes };
}
