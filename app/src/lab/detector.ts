// Lazy MediaPipe ObjectDetector (EfficientDet-Lite0 or Lite2, IMAGE mode, plus a VIDEO-mode instance for the live camera), with
// a tiled pass so the small players of a wide TV shot are seen at a usable resolution (the models look at 320 / 448 pixels).
// Tiling, NMS and thresholds are tuned on the synthetic benchmark (scripts/cv-bench/, `npm run cv:bench`).
import { keepPersons, MIN_SCORE, type Person, type RawDetection } from "./players.ts";
import { BALL_CLASS, BALL_MIN_SCORE, keepBalls, type Ball } from "./ball.ts";
import { isGrass, type Box } from "./teams.ts";
import { getSettings, MODELS, type DetectorSettings, type ModelId } from "./settings.ts";
import { addTime, labProf, timed } from "./prof.ts";
import { getTilePool, poolSize, type TilePool } from "./tilepool.ts";
import { dropCut, FALLBACK_H, gateBySize, heightProfile, nearSeed, planScaleTiles, REFINE_DEFAULTS, refineRegions, SCALE_DEFAULTS, type HeightAt, type Region } from "./scaletile.ts";

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
/** Person candidates under the tile threshold (down to the detector's BALL_MIN_SCORE), seeds of the refinement stage. */
const weakOf = (dets: RawDetection[], minScore: number): Person[] => keepPersons(dets, BALL_MIN_SCORE).filter((p) => p.score < minScore);

const shift = <T extends { box: Box }>(xs: T[], dx: number, dy: number): T[] => xs.map((p) => ({ ...p, box: { ...p.box, x: p.box.x + dx, y: p.box.y + dy } }));
const split = (dets: RawDetection[], minScore?: number): Found => ({ persons: keepPersons(dets, minScore), balls: keepBalls(dets) });

/** Tiled pass (IMAGE detector) over src, boxes shifted back to source pixels. */
async function tiledPass(src: HTMLCanvasElement, s: DetectorSettings, only?: Box[], filter?: (ps: Person[], t: Box) => Person[]): Promise<Found & { passes: number; weak: Person[] }> {
  const det = await loadDetector(s.model);
  const crop = document.createElement("canvas");
  const cx = crop.getContext("2d")!;
  const all = { persons: [] as Person[], balls: [] as Ball[], passes: 0, weak: [] as Person[] };
  for (const t of only ?? peopleTiles(src.width, src.height, s)) {
    timed("det.tileCrop", () => { crop.width = t.w; crop.height = t.h; cx.drawImage(src, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h); });
    const dets = timed("det.tilePass", () => det.detect(crop).detections);
    const f = split(dets, s.tileMinScore);
    const ps = shift(f.persons, t.x, t.y);
    all.persons.push(...(filter ? filter(ps, t) : ps));
    all.balls.push(...shift(f.balls, t.x, t.y));
    all.weak.push(...shift(weakOf(dets, s.tileMinScore), t.x, t.y));
    all.passes++;
  }
  return all;
}

/** Small-player stages: tiles with less grass than this are skipped (crowd, sky, graphics). */
export const SMALL = { minGrass: 0.2 } as const;

/**
 * Small-player stages (scaletile.ts), after the full-frame and regular tiled passes: (1) perspective tiles sized from the
 * first pass's box heights per row, on grass only, capped at s.scaleTiles; (2) zoomed crops around the low-confidence
 * candidates of all passes and around `predicted` boxes, capped at s.refine. Detections of both stages must fit the
 * expected height at their row and not be cut by an inner tile edge.
 */
async function smallPlayerPass(src: HTMLCanvasElement, s: DetectorSettings, first: Person[], weak: Person[], grass: ImageData | null, predictedFeet: { x: number; y: number }[] = []): Promise<{ persons: Person[]; passes: number }> {
  const W = src.width, Hh = src.height, input = MODELS[s.model].input;
  const prof = heightProfile(first, Hh);
  const hAt: HeightAt = prof ?? (() => FALLBACK_H);
  // a predicted feet point becomes a box of the expected height at its row
  const predicted = predictedFeet.map((p) => { const h = hAt(p.y); return { x: p.x - 0.2 * h, y: p.y - h, w: 0.4 * h, h }; });
  const out: Person[] = [];
  let passes = 0, weakAll = weak;
  const gate = (ps: Person[], t: Box) => gateBySize(dropCut(ps, t, W, Hh), hAt);
  if (s.scaleTiles) {
    const keep = (t: Box) => !grass || grassShare(grass, t, 8) >= SMALL.minGrass;
    const plan = timed("det.scalePlan", () => planScaleTiles(W, Hh, hAt, { ...SCALE_DEFAULTS, input, base: s.tile > 0 ? s.tile : 384, maxTiles: s.scaleTiles! }, keep));
    if (plan.tiles.length) {
      const r = await tiledPass(src, s, plan.tiles, gate);
      out.push(...r.persons); passes += r.passes; weakAll = weakAll.concat(r.weak);
    }
  }
  if (s.refine) {
    const accepted = nms(first.concat(out)).map((p) => p.box);
    const regions = refineRegions(gateBySize(weakAll, hAt, 0.3, 3), accepted, predicted, prof, W, Hh, { ...REFINE_DEFAULTS, input, max: s.refine });
    if (regions.length) {
      const r = await tiledPass(src, s, regions, (ps, t) => nearSeed(gate(ps, t), (t as Region).seed));
      out.push(...r.persons); passes += r.passes;
    }
  }
  return { persons: out, passes };
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

const readback = (src: HTMLCanvasElement): ImageData => timed("det.ballReadback", () => src.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height));

export const BALL_TILES = { cols: 6, rows: 4, minGrass: 0.15 } as const;

/**
 * Ball-only pass on finer tiles (6 x 4 on a 1280 px picture: ~256 px tiles, magnified to the model's 320 px), skipping tiles
 * with almost no grass. A ball of ~18 px is invisible to the 3 x 2 pass (it shrinks to ~12 px) but found here.
 */
async function ballPass(src: HTMLCanvasElement, model: ModelId, data: ImageData = readback(src)): Promise<{ balls: Ball[]; passes: number }> {
  const det = await loadDetector(model);
  const crop = document.createElement("canvas");
  const cx = crop.getContext("2d")!;
  const balls: Ball[] = [];
  let passes = 0;
  for (const t of tiles(src.width, src.height, BALL_TILES.cols, BALL_TILES.rows)) {
    if (grassShare(data, t) < BALL_TILES.minGrass) continue;
    timed("det.tileCrop", () => { crop.width = t.w; crop.height = t.h; cx.drawImage(src, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h); });
    balls.push(...shift(keepBalls(timed("det.ballPass", () => det.detect(crop).detections)), t.x, t.y));
    passes++;
  }
  return { balls, passes };
}

function finish(full: Found, tiledRes: Found | null, t0: number, passes: number): DetectRun {
  const persons = timed("det.nms", () => nms(tiledRes ? full.persons.concat(tiledRes.persons) : full.persons));
  const balls = timed("det.nms", () => nms(tiledRes ? full.balls.concat(tiledRes.balls) : full.balls, 0.3));
  return { persons, balls, ms: performance.now() - t0, passes };
}

/** Full-image pass, plus the tiled people pass and the finer ball pass when `tiled`. Boxes are in source pixels. */
export async function detectPeople(src: HTMLCanvasElement, tiled: boolean, s: DetectorSettings = getSettings()): Promise<DetectRun> {
  const det = await loadDetector(s.model);
  const t0 = performance.now();
  const fullDets = det.detect(src).detections;
  const full = split(fullDets);
  if (!tiled) return finish(full, null, t0, 1);
  const tl = await tiledPass(src, s);
  const data = readback(src);
  const bp = await ballPass(src, s.model, data);
  let persons = tl.persons, passes = 1 + tl.passes + bp.passes;
  if (s.scaleTiles || s.refine) {
    const sp = await smallPlayerPass(src, s, nms(full.persons.concat(tl.persons)), weakOf(fullDets, MIN_SCORE).concat(tl.weak), data);
    persons = persons.concat(sp.persons); passes += sp.passes;
  }
  return finish(full, { persons, balls: tl.balls.concat(bp.balls) }, t0, passes);
}

/**
 * The worker pool of the clip mode's tiled pass (tilepool.ts), started on demand; null when workers are unavailable
 * (the tiles then run on the main thread). `size` 0 = no pool, undefined = from the core count.
 */
export async function loadTilePool(model: ModelId = getSettings().model, size?: number): Promise<TilePool | null> {
  const n = size ?? poolSize(typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined);
  if (n < 1) return null;
  return getTilePool({ wasm: WASM_BASE, model: new URL(MODELS[model].path, document.baseURI).href, scoreThreshold: BALL_MIN_SCORE, allow: ["person", BALL_CLASS] }, n);
}

/** Tiles through the pool: started before `meanwhile` (the full-frame pass) runs on the main thread. */
async function pooledPass<T>(pool: TilePool, src: HTMLCanvasElement, tilesToRun: Box[], s: DetectorSettings, meanwhile: () => T): Promise<{ tl: Found & { passes: number }; other: T }> {
  const t0 = performance.now();
  const job = await pool.start(src, tilesToRun);
  const other = meanwhile();
  const res = await job.done;
  addTime(labProf, "det.tilePool", performance.now() - t0, tilesToRun.length);
  const tl = { persons: [] as Person[], balls: [] as Ball[], passes: tilesToRun.length };
  tilesToRun.forEach((t, k) => {
    const f = split(res[k]!, s.tileMinScore);
    tl.persons.push(...shift(f.persons, t.x, t.y));
    tl.balls.push(...shift(f.balls, t.x, t.y));
  });
  return { tl, other };
}

let lastTs = 0;
/** Live: one VIDEO-mode pass on the current frame (+ the tiled IMAGE pass when asked; in the worker pool when given). */
export async function detectVideoFrame(src: HTMLCanvasElement, tiled: boolean, s: DetectorSettings = getSettings(), pool: TilePool | null = null): Promise<DetectRun> {
  const det = await loadVideoDetector(s.model);
  if (tiled) await loadDetector(s.model);
  const t0 = performance.now();
  lastTs = Math.max(lastTs + 1, Math.round(t0));
  if (tiled && pool) {
    const { tl, other: full } = await pooledPass(pool, src, peopleTiles(src.width, src.height, s), s,
      () => split(timed("det.fullPass", () => det.detectForVideo(src, lastTs).detections)));
    return finish(full, tl, t0, 1 + tl.passes);
  }
  const full = split(timed("det.fullPass", () => det.detectForVideo(src, lastTs).detections));
  // live: no ball-only pass (too slow for several frames a second); the ball comes from the regular passes
  if (!tiled) return finish(full, null, t0, 1);
  const tl = await tiledPass(src, s);
  return finish(full, tl, t0, 1 + tl.passes);
}

/**
 * Clip mode, cheap frame of the adaptive tiling: the VIDEO pass, then the tiled IMAGE pass only on the tiles that `focus`
 * picks from the full plan (given the persons of the full-frame pass), e.g. around predicted players it did not find.
 */
export async function detectVideoFrameFocus(src: HTMLCanvasElement, focus: (plan: Box[], persons: Person[]) => Box[], s: DetectorSettings = getSettings(), pool: TilePool | null = null,
  missed?: (persons: Person[]) => { x: number; y: number }[]): Promise<DetectRun> {
  const det = await loadVideoDetector(s.model);
  await loadDetector(s.model);
  const t0 = performance.now();
  lastTs = Math.max(lastTs + 1, Math.round(t0));
  const full = split(timed("det.fullPass", () => det.detectForVideo(src, lastTs).detections));
  const only = focus(peopleTiles(src.width, src.height, s), full.persons);
  const tl = !only.length ? null : pool ? (await pooledPass(pool, src, only, s, () => null)).tl : await tiledPass(src, s, only);
  let passes = 1 + (tl?.passes ?? 0);
  // second stage (s.refine): zoomed crops on the predicted players that the full-frame and focus tiles still missed
  if (s.refine && missed) {
    const found = nms(full.persons.concat(tl?.persons ?? []));
    const left = missed(found);
    if (left.length) {
      const sp = await smallPlayerPass(src, { ...s, scaleTiles: 0 }, found, [], null, left);
      passes += sp.passes;
      return finish(full, { persons: (tl?.persons ?? []).concat(sp.persons), balls: tl?.balls ?? [] }, t0, passes);
    }
  }
  return finish(full, tl, t0, passes);
}
