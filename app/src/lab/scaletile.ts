// Scale-aware tiling and two-stage refinement for small players (docs/cv-robustness.md, "Small players"). Pure planning:
// detector.ts runs the passes. EfficientDet-Lite sees a 15-25 px player badly; a tile of side T resized to the model input I
// magnifies by I / T, so a player of h px reaches `target` px in a tile of side I * h / target. The expected h per image row
// comes from the first pass (perspective: players get smaller towards the top of a broadcast picture), so the extra tiles
// are small far away, large (or none) near, restricted to the grass and capped in number.
import type { Person } from "./players.ts";
import type { Box } from "./teams.ts";

/** Expected player height (px) at a feet row y. */
export type HeightAt = (y: number) => number;

export type ScaleOpts = {
  /** Model input (px) and the base tile of the regular pass (px). */
  input: number; base: number;
  /** Player height wanted inside the model input after the resize (px). */
  target: number;
  /** Smallest tile side (px): more magnification than input / minTile only blurs. */
  minTile: number;
  overlap: number;
  /** Rows where the base tile already brings players to >= skip * target are left to the regular pass. */
  skip: number;
  /** Most extra tiles per frame (time budget); over it, all sides grow by `grow` steps until the plan fits. */
  maxTiles: number; grow: number;
};

export const SCALE_DEFAULTS: Omit<ScaleOpts, "input" | "base" | "maxTiles"> = { target: 48, minTile: 128, overlap: 0.25, skip: 0.8, grow: 1.15 };

/** When the first pass finds too few people to measure, players are assumed this small (px) everywhere. */
export const FALLBACK_H = 24;

/**
 * Height profile from the first-pass persons: per horizontal band, a low quantile of the box heights (the first pass misses
 * the smallest players, so its median overestimates), then a weighted line h = a + b * feetY through the bands (b >= 0:
 * farther = higher up = smaller), clamped to [minH, imgH / 2]. null with fewer than `minPersons` usable boxes.
 */
export function heightProfile(persons: Person[], imgH: number, bands = 6, minPersons = 3, q = 0.4, minH = 8): HeightAt | null {
  const pts = persons.filter((p) => p.box.h >= minH && p.box.h > 0.9 * p.box.w).map((p) => ({ y: p.box.y + p.box.h, h: p.box.h }));
  if (pts.length < minPersons) return null;
  const bh = imgH / bands;
  const rows: { y: number; h: number; n: number }[] = [];
  for (let k = 0; k < bands; k++) {
    const hs = pts.filter((p) => Math.min(bands - 1, Math.max(0, Math.floor(p.y / bh))) === k).map((p) => p.h).sort((a, b) => a - b);
    if (hs.length) rows.push({ y: (k + 0.5) * bh, h: hs[Math.min(hs.length - 1, Math.floor(q * hs.length))]!, n: hs.length });
  }
  const W = rows.reduce((s, r) => s + r.n, 0);
  const my = rows.reduce((s, r) => s + r.n * r.y, 0) / W, mh = rows.reduce((s, r) => s + r.n * r.h, 0) / W;
  const sxx = rows.reduce((s, r) => s + r.n * (r.y - my) ** 2, 0), sxy = rows.reduce((s, r) => s + r.n * (r.y - my) * (r.h - mh), 0);
  const b = rows.length > 1 && sxx > 0 ? Math.max(0, sxy / sxx) : 0;
  const maxH = imgH / 2;
  return (y) => Math.min(maxH, Math.max(minH, mh + b * (y - my)));
}

/** Tile side that brings a player of h px to the target height, clamped to [minTile, base]. */
export const sideFor = (h: number, o: Pick<ScaleOpts, "input" | "target" | "minTile" | "base">): number =>
  Math.round(Math.min(o.base, Math.max(o.minTile, (o.input * h) / o.target)));

/** One row of square tiles of side t at y, spread evenly over the width so the last ends on the right edge. */
function rowOf(w: number, y: number, t: number, overlap: number): Box[] {
  const n = w <= t ? 1 : Math.ceil((w - t * overlap) / (t * (1 - overlap)));
  const step = n > 1 ? (w - t) / (n - 1) : 0;
  return Array.from({ length: n }, (_, c) => ({ x: Math.round(c * step), y: Math.round(y), w: Math.min(t, w), h: t }));
}

/** Perspective rows for a given growth factor k (all sides x k): top to bottom, each row sized by the height at its centre. */
function rows(w: number, h: number, hAt: HeightAt, o: ScaleOpts, k: number, keep: (t: Box) => boolean): Box[] {
  const out: Box[] = [];
  const side = (y: number, t0: number) => Math.min(o.base, Math.round(k * sideFor(hAt(y + t0 / 2), o)));
  for (let y = 0; y < h;) {
    let t = side(y, o.base);
    t = Math.min(h, side(y, t));
    const y0 = Math.min(y, h - t);
    // the regular pass already magnifies enough here (players >= skip * target in a base tile)
    const enough = (o.input * hAt(y0 + t / 2)) / o.base >= o.skip * o.target;
    if (!enough) out.push(...rowOf(w, y0, t, o.overlap).filter(keep));
    if (y0 + t >= h) break;
    y = y0 + t * (1 - o.overlap);
  }
  return out;
}

/**
 * Extra tiles for the small players: perspective rows (smaller tiles where hAt is small), skipping rows the base tiling
 * already handles and tiles `keep` rejects (no grass), at most maxTiles (sides grow by `grow` until the plan fits; the
 * returned `k` is the growth used, 1 = full magnification). maxTiles 0 = no tiles.
 */
export function planScaleTiles(w: number, h: number, hAt: HeightAt, o: ScaleOpts, keep: (t: Box) => boolean = () => true): { tiles: Box[]; k: number } {
  if (o.maxTiles <= 0) return { tiles: [], k: 1 };
  let last: { tiles: Box[]; k: number } | null = null;
  for (let k = 1; k < 20; k *= o.grow) {
    const ts = rows(w, h, hAt, o, k, keep);
    if (ts.length <= o.maxTiles) return { tiles: ts, k };
    // tiles grown to the base side magnify no more than the regular pass: stop growing there
    if (ts.some((t) => t.w >= Math.min(o.base, w, h))) break;
    last = { tiles: ts, k };
  }
  if (!last) return { tiles: [], k: Infinity };
  // still over the cap at the largest useful growth: keep the tiles of the smallest expected players
  const ranked = [...last.tiles].sort((a, b) => hAt(a.y + a.h / 2) - hAt(b.y + b.h / 2) || a.y - b.y || a.x - b.x);
  return { tiles: ranked.slice(0, o.maxTiles), k: last.k };
}

/** Keeps boxes whose height fits the expected height at their feet row (lo..hi times). */
export function gateBySize<T extends { box: Box }>(ps: T[], hAt: HeightAt, lo = 0.45, hi = 2): T[] {
  return ps.filter((p) => { const e = hAt(p.box.y + p.box.h); return p.box.h >= lo * e && p.box.h <= hi * e; });
}

/** Drops boxes cut by an inner edge of their tile (within `pad` px; the picture's own edges do not count). */
export function dropCut<T extends { box: Box }>(ps: T[], t: Box, imgW: number, imgH: number, pad = 2): T[] {
  return ps.filter(({ box: b }) => !((b.x <= t.x + pad && t.x > 0) || (b.y <= t.y + pad && t.y > 0) ||
    (b.x + b.w >= t.x + t.w - pad && t.x + t.w < imgW) || (b.y + b.h >= t.y + t.h - pad && t.y + t.h < imgH)));
}

export type RefineOpts = { input: number; target: number; minSide: number; maxSide: number; max: number };
export const REFINE_DEFAULTS: Omit<RefineOpts, "input" | "max"> = { target: 56, minSide: 112, maxSide: 320 };

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/**
 * Second-stage regions: square crops centred on the seeds, side bringing the expected height to `target`, clamped to the
 * picture. Seeds: predicted boxes first (clip mode: tracked players the frame's passes did not find), then low-confidence
 * candidates by score (best first). A candidate overlapping an accepted box (IoU > 0.3 or its centre inside it) is
 * skipped, and so is a seed whose centre falls in the inner half of a region already chosen. At most `max` regions.
 */
export type Region = Box & { seed: Box };

export function refineRegions(weak: Person[], accepted: Box[], predicted: Box[], hAt: HeightAt | null, imgW: number, imgH: number, o: RefineOpts): Region[] {
  if (o.max <= 0) return [];
  const covered = (b: Box) => accepted.some((a) => {
    const c = centre(b);
    if (c.x >= a.x && c.x <= a.x + a.w && c.y >= a.y && c.y <= a.y + a.h) return true;
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    return inter / (a.w * a.h + b.w * b.h - inter) > 0.3;
  });
  const seeds = [...predicted.map((b) => ({ b, pred: true })), ...[...weak].sort((a, b) => b.score - a.score).filter((p) => !covered(p.box)).map((p) => ({ b: p.box, pred: false }))];
  const out: Region[] = [];
  for (const { b: s, pred } of seeds) {
    if (out.length >= o.max) break;
    const c = centre(s);
    if (c.x < 0 || c.y < 0 || c.x > imgW || c.y > imgH) continue;
    if (out.some((r) => Math.abs(c.x - (r.x + r.w / 2)) < r.w / 4 && Math.abs(c.y - (r.y + r.h / 2)) < r.h / 4)) continue;
    const eh = hAt ? (s.h + hAt(s.y + s.h)) / 2 : s.h;
    const want = (o.input * eh) / o.target;
    // a candidate already large enough for the regular tiles gains nothing from a zoom (predictions are always re-scanned)
    if (!pred && want > o.maxSide) continue;
    const side = Math.min(imgW, imgH, Math.round(Math.min(o.maxSide, Math.max(o.minSide, want))));
    const x = Math.round(Math.min(imgW - side, Math.max(0, c.x - side / 2))), y = Math.round(Math.min(imgH - side, Math.max(0, c.y - side / 2)));
    out.push({ x, y, w: side, h: side, seed: s });
  }
  return out;
}

/** Detections of a refinement crop that belong to its seed: centre within `k` seed heights of the seed's centre. */
export function nearSeed<T extends { box: Box }>(ps: T[], seed: Box, k = 0.75): T[] {
  const c = centre(seed), r = k * Math.max(seed.h, 8);
  return ps.filter((p) => { const d = centre(p.box); return Math.hypot(d.x - c.x, d.y - c.y) <= r; });
}
