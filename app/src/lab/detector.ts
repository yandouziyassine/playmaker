// Lazy MediaPipe ObjectDetector (EfficientDet-Lite0 or Lite2, IMAGE mode, plus a VIDEO-mode instance for the live camera), with
// a tiled pass so the small players of a wide TV shot are seen at a usable resolution (the models look at 320 / 448 pixels).
// Tiling, NMS and thresholds are tuned on the synthetic benchmark (scripts/cv-bench/, `npm run cv:bench`).
import { keepPersons, type Person, type RawDetection } from "./players.ts";
import { BALL_CLASS, BALL_MIN_SCORE, keepBalls, type Ball } from "./ball.ts";
import { isGrass, type Box } from "./teams.ts";
import { getSettings, MODELS, type DetectorSettings, type ModelId } from "./settings.ts";

/** Pinned to the installed npm version (checked by a unit test). The wasm (~15 MB per build) is loaded from the CDN. */
export const MEDIAPIPE_VERSION = "1.2.2";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

type Img = HTMLCanvasElement | HTMLVideoElement;
type Detector = { detect(img: Img): { detections: RawDetection[] } };
type VideoDetector = { detectForVideo(img: Img, timestampMs: number): { detections: RawDetection[] } };
const pending = new Map<string, Promise<Detector>>();
const pendingVideo = new Map<string, Promise<VideoDetector>>();

async function create(mode: "IMAGE" | "VIDEO", model: ModelId) {
  const { FilesetResolver, ObjectDetector } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const make = (delegate: "GPU" | "CPU") => ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL(MODELS[model].path, document.baseURI).href, delegate },
    // the threshold is the ball's (lower); people are filtered again at MIN_SCORE by keepPersons
    runningMode: mode, scoreThreshold: BALL_MIN_SCORE, categoryAllowlist: ["person", BALL_CLASS], maxResults: 100,
  });
  // CPU (wasm + XNNPACK) by default: ~75 ms per 320 px pass here, vs ~1 s on a software-WebGL GPU delegate.
  // ?gpu tries the WebGL delegate (falls back to CPU).
  if (!new URLSearchParams(location.search).has("gpu")) return make("CPU");
  try { return await make("GPU"); } catch { return await make("CPU"); }
}

export function loadDetector(model: ModelId = getSettings().model): Promise<Detector> {
  let p = pending.get(model);
  if (!p) {
    p = create("IMAGE", model);
    pending.set(model, p);
    p.catch(() => pending.delete(model));
  }
  return p;
}

/** A second instance in VIDEO mode (detectForVideo, monotonic timestamps) for the live camera. */
export function loadVideoDetector(model: ModelId = getSettings().model): Promise<VideoDetector> {
  let p = pendingVideo.get(model);
  if (!p) {
    p = create("VIDEO", model);
    pendingVideo.set(model, p);
    p.catch(() => pendingVideo.delete(model));
  }
  return p;
}

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/** Share of the smaller box covered by the intersection (1 = one box inside the other). */
export function containment(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const small = Math.min(a.w * a.h, b.w * b.h);
  return small > 0 ? inter / small : 0;
}

/**
 * Greedy non-maximum suppression (best score first); also drops a box mostly contained (> `contain`) in a better one:
 * the same player cut by a tile edge, or a torso-only box inside a whole-body one.
 */
export function nms<T extends Person>(ps: T[], thr = 0.45, contain = 0.7): T[] {
  const sorted = [...ps].sort((a, b) => b.score - a.score);
  const out: T[] = [];
  for (const p of sorted) {
    if (!out.some((q) => iou(p.box, q.box) > thr || containment(p.box, q.box) > contain)) out.push(p);
  }
  return out;
}

/** Overlapping tiles covering a w x h image (cols x rows, ~20 % overlap). The legacy 3 x 2 grid. */
export function tiles(w: number, h: number, cols: number, rows: number, overlap = 0.2): Box[] {
  const tw = w / (cols - (cols - 1) * overlap), th = h / (rows - (rows - 1) * overlap);
  const out: Box[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    out.push({ x: Math.round(c * tw * (1 - overlap)), y: Math.round(r * th * (1 - overlap)), w: Math.round(tw), h: Math.round(th) });
  return out;
}

/**
 * Square tiles of `tile` px (clamped to the picture) with at least `overlap` between neighbours, spread evenly so the
 * last tile ends on the picture edge. Square tiles matter: MediaPipe letterboxes a wide tile into its square input, so a
 * 490 x 300 tile of the 3 x 2 grid only uses 320 x 195 of the 320 px model and shrinks every player by a third.
 */
export function planTiles(w: number, h: number, tile: number, overlap = 0.25): Box[] {
  const tw = Math.min(tile, w), th = Math.min(tile, h);
  const count = (len: number, t: number) => (len <= t ? 1 : Math.ceil((len - t * overlap) / (t * (1 - overlap))));
  const cols = count(w, tw), rows = count(h, th);
  const step = (len: number, t: number, n: number) => (n > 1 ? (len - t) / (n - 1) : 0);
  const sx = step(w, tw, cols), sy = step(h, th, rows);
  const out: Box[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: Math.round(c * sx), y: Math.round(r * sy), w: tw, h: th });
  return out;
}

/** The tiles of the people pass for the current settings. */
export function peopleTiles(w: number, h: number, s: DetectorSettings): Box[] {
  return s.tile > 0 ? planTiles(w, h, s.tile, s.overlap) : tiles(w, h, 3, 2);
}

/** persons: after NMS; balls: every "sports ball" candidate (after NMS), the caller picks one (ball.ts: pickBall). */
export type DetectRun = { persons: Person[]; balls: Ball[]; ms: number; passes: number };
type Found = { persons: Person[]; balls: Ball[] };

const shift = <T extends { box: Box }>(xs: T[], dx: number, dy: number): T[] => xs.map((p) => ({ ...p, box: { ...p.box, x: p.box.x + dx, y: p.box.y + dy } }));
const split = (dets: RawDetection[], minScore?: number): Found => ({ persons: keepPersons(dets, minScore), balls: keepBalls(dets) });

/** Tiled pass (IMAGE detector) over src, boxes shifted back to source pixels. */
async function tiledPass(src: HTMLCanvasElement, s: DetectorSettings, only?: Box[]): Promise<Found & { passes: number }> {
  const det = await loadDetector(s.model);
  const crop = document.createElement("canvas");
  const cx = crop.getContext("2d")!;
  const all = { persons: [] as Person[], balls: [] as Ball[], passes: 0 };
  for (const t of only ?? peopleTiles(src.width, src.height, s)) {
    crop.width = t.w; crop.height = t.h;
    cx.drawImage(src, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
    const f = split(det.detect(crop).detections, s.tileMinScore);
    all.persons.push(...shift(f.persons, t.x, t.y));
    all.balls.push(...shift(f.balls, t.x, t.y));
    all.passes++;
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
async function ballPass(src: HTMLCanvasElement, model: ModelId): Promise<{ balls: Ball[]; passes: number }> {
  const det = await loadDetector(model);
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

/** Full-image pass, plus the tiled people pass and the finer ball pass when `tiled`. Boxes are in source pixels. */
export async function detectPeople(src: HTMLCanvasElement, tiled: boolean, s: DetectorSettings = getSettings()): Promise<DetectRun> {
  const det = await loadDetector(s.model);
  const t0 = performance.now();
  const full = split(det.detect(src).detections);
  if (!tiled) return finish(full, null, t0, 1);
  const tl = await tiledPass(src, s);
  const bp = await ballPass(src, s.model);
  return finish(full, { persons: tl.persons, balls: tl.balls.concat(bp.balls) }, t0, 1 + tl.passes + bp.passes);
}

let lastTs = 0;
/** Live: one VIDEO-mode pass on the current frame (+ the tiled IMAGE pass when asked). */
export async function detectVideoFrame(src: HTMLCanvasElement, tiled: boolean, s: DetectorSettings = getSettings()): Promise<DetectRun> {
  const det = await loadVideoDetector(s.model);
  if (tiled) await loadDetector(s.model);
  const t0 = performance.now();
  lastTs = Math.max(lastTs + 1, Math.round(t0));
  const full = split(det.detectForVideo(src, lastTs).detections);
  // live: no ball-only pass (too slow for several frames a second); the ball comes from the regular passes
  if (!tiled) return finish(full, null, t0, 1);
  const tl = await tiledPass(src, s);
  return finish(full, tl, t0, 1 + tl.passes);
}

/**
 * Clip mode, cheap frame of the adaptive tiling: the VIDEO pass, then the tiled IMAGE pass only on the tiles that `focus`
 * picks from the full plan (given the persons of the full-frame pass), e.g. around predicted players it did not find.
 */
export async function detectVideoFrameFocus(src: HTMLCanvasElement, focus: (plan: Box[], persons: Person[]) => Box[], s: DetectorSettings = getSettings()): Promise<DetectRun> {
  const det = await loadVideoDetector(s.model);
  await loadDetector(s.model);
  const t0 = performance.now();
  lastTs = Math.max(lastTs + 1, Math.round(t0));
  const full = split(det.detectForVideo(src, lastTs).detections);
  const only = focus(peopleTiles(src.width, src.height, s), full.persons);
  if (!only.length) return finish(full, null, t0, 1);
  const tl = await tiledPass(src, s, only);
  return finish(full, tl, t0, 1 + tl.passes);
}
