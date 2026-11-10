// Lazy MediaPipe ObjectDetector (EfficientDet-Lite0, IMAGE mode, plus a VIDEO-mode instance for the live camera), with an optional tiled pass so the small
// players of a wide TV shot are seen at a usable resolution (the model looks at 320 x 320 pixels).
import { keepPersons, type Person, type RawDetection } from "./players.ts";
import { BALL_CLASS, BALL_MIN_SCORE, keepBalls, type Ball } from "./ball.ts";
import { isGrass, type Box } from "./teams.ts";

/** Pinned to the installed npm version (checked by a unit test). The wasm (~15 MB per build) is loaded from the CDN. */
export const MEDIAPIPE_VERSION = "1.2.2";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_PATH = "lab/efficientdet_lite0.tflite"; // self-hosted, next to lab.html

type Img = HTMLCanvasElement | HTMLVideoElement;
type Detector = { detect(img: Img): { detections: RawDetection[] } };
type VideoDetector = { detectForVideo(img: Img, timestampMs: number): { detections: RawDetection[] } };
let pending: Promise<Detector> | null = null;
let pendingVideo: Promise<VideoDetector> | null = null;

async function create(mode: "IMAGE" | "VIDEO") {
  const { FilesetResolver, ObjectDetector } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const make = (delegate: "GPU" | "CPU") => ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL(MODEL_PATH, document.baseURI).href, delegate },
    // the threshold is the ball's (lower); people are filtered again at MIN_SCORE by keepPersons
    runningMode: mode, scoreThreshold: BALL_MIN_SCORE, categoryAllowlist: ["person", BALL_CLASS], maxResults: 100,
  });
  // CPU (wasm + XNNPACK) by default: ~75 ms per 320 px pass here, vs ~1 s on a software-WebGL GPU delegate.
  // ?gpu tries the WebGL delegate (falls back to CPU).
  if (!new URLSearchParams(location.search).has("gpu")) return make("CPU");
  try { return await make("GPU"); } catch { return await make("CPU"); }
}

export function loadDetector(): Promise<Detector> {
  pending ??= create("IMAGE");
  pending.catch(() => { pending = null; });
  return pending;
}

/** A second instance in VIDEO mode (detectForVideo, monotonic timestamps) for the live camera. */
export function loadVideoDetector(): Promise<VideoDetector> {
  pendingVideo ??= create("VIDEO");
  pendingVideo.catch(() => { pendingVideo = null; });
  return pendingVideo;
}

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/** Greedy non-maximum suppression; also drops a box mostly contained in a better one (tile-cut duplicates). */
export function nms<T extends Person>(ps: T[], thr = 0.45): T[] {
  const sorted = [...ps].sort((a, b) => b.score - a.score);
  const out: T[] = [];
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

/** persons: after NMS; balls: every "sports ball" candidate (after NMS), the caller picks one (ball.ts: pickBall). */
export type DetectRun = { persons: Person[]; balls: Ball[]; ms: number; passes: number };
type Found = { persons: Person[]; balls: Ball[] };

const shift = <T extends { box: Box }>(xs: T[], dx: number, dy: number): T[] => xs.map((p) => ({ ...p, box: { ...p.box, x: p.box.x + dx, y: p.box.y + dy } }));
const split = (dets: RawDetection[]): Found => ({ persons: keepPersons(dets), balls: keepBalls(dets) });

/** 3 x 2 tiled pass (IMAGE detector) over src, boxes shifted back to source pixels. The tiles matter most for the tiny ball. */
async function tiledPass(src: HTMLCanvasElement): Promise<Found> {
  const det = await loadDetector();
  const crop = document.createElement("canvas");
  const cx = crop.getContext("2d")!;
  const all: Found = { persons: [], balls: [] };
  for (const t of tiles(src.width, src.height, 3, 2)) {
    crop.width = t.w; crop.height = t.h;
    cx.drawImage(src, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
    const f = split(det.detect(crop).detections);
    all.persons.push(...shift(f.persons, t.x, t.y));
    all.balls.push(...shift(f.balls, t.x, t.y));
  }
  return all;
}

/** Share of grass in a coarse sample of a region (the ball pass skips tiles of crowd and sky). */
export function grassShare(img: { data: ArrayLike<number>; width: number; height: number }, t: Box, n = 12): number {
  let g = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = Math.min(img.width - 1, Math.floor(t.x + ((i + 0.5) * t.w) / n)), y = Math.min(img.height - 1, Math.floor(t.y + ((j + 0.5) * t.h) / n));
    const k = 4 * (y * img.width + x);
    if (isGrass(img.data[k]!, img.data[k + 1]!, img.data[k + 2]!)) g++;
  }
  return g / (n * n);
}

export const BALL_TILES = { cols: 6, rows: 4, minGrass: 0.15 } as const;

/**
 * Ball-only pass on finer tiles (6 x 4 on a 1280 px picture: ~256 px tiles, magnified to the model's 320 px), skipping tiles
 * with almost no grass. A ball of ~18 px is invisible to the 3 x 2 pass (it shrinks to ~12 px) but found here.
 */
async function ballPass(src: HTMLCanvasElement): Promise<{ balls: Ball[]; passes: number }> {
  const det = await loadDetector();
  const data = src.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height);
  const crop = document.createElement("canvas");
  const cx = crop.getContext("2d")!;
  const balls: Ball[] = [];
  let passes = 0;
  for (const t of tiles(src.width, src.height, BALL_TILES.cols, BALL_TILES.rows)) {
    if (grassShare(data, t) < BALL_TILES.minGrass) continue;
    crop.width = t.w; crop.height = t.h;
    cx.drawImage(src, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
    balls.push(...shift(keepBalls(det.detect(crop).detections), t.x, t.y));
    passes++;
  }
  return { balls, passes };
}

function finish(full: Found, tiledRes: Found | null, t0: number, passes: number): DetectRun {
  const persons = nms(tiledRes ? full.persons.concat(tiledRes.persons) : full.persons);
  const balls = nms(tiledRes ? full.balls.concat(tiledRes.balls) : full.balls, 0.3);
  return { persons, balls, ms: performance.now() - t0, passes };
}

/** Full-image pass, plus a 3 x 2 tiled pass and the finer ball pass when `tiled`. Boxes are in source pixels. */
export async function detectPeople(src: HTMLCanvasElement, tiled: boolean): Promise<DetectRun> {
  const det = await loadDetector();
  const t0 = performance.now();
  const full = split(det.detect(src).detections);
  if (!tiled) return finish(full, null, t0, 1);
  const tl = await tiledPass(src);
  const bp = await ballPass(src);
  return finish(full, { persons: tl.persons, balls: tl.balls.concat(bp.balls) }, t0, 7 + bp.passes);
}

let lastTs = 0;
/** Live: one VIDEO-mode pass on the current frame (+ the tiled IMAGE pass when asked). */
export async function detectVideoFrame(src: HTMLCanvasElement, tiled: boolean): Promise<DetectRun> {
  const det = await loadVideoDetector();
  if (tiled) await loadDetector();
  const t0 = performance.now();
  lastTs = Math.max(lastTs + 1, Math.round(t0));
  const full = split(det.detectForVideo(src, lastTs).detections);
  // live: no ball-only pass (too slow for several frames a second); the ball comes from the regular passes
  return finish(full, tiled ? await tiledPass(src) : null, t0, tiled ? 7 : 1);
}
