// Calibration assist: painted pitch lines (white on green) -> Hough lines -> intersections, tap snapping, and a fit-quality
// score of the reprojected pitch lines. Written from scratch (no OpenCV). Pure functions on a small, downscaled RGBA image:
// unit-tested in app/test/lab-lines.test.ts.
import { applyH, computeHomography, reprojectionError, wOf, type Mat3, type Pt } from "./homography.ts";
import { isGrass, type Box, type ImageLike } from "./teams.ts";

/** Working size of the line search (longest side, pixels). */
export const LINE_SIDE = 640;

export type MaskOpts = { tau: number; margin: number };
export const MASK: MaskOpts = { tau: 4, margin: 22 };

/**
 * White-line mask: a pixel is a line pixel when it is whiter (min of R, G, B) than the pixels `tau` away on BOTH sides,
 * horizontally or vertically, by more than `margin`, and those two pixels are grass. This keeps thin bright stripes inside
 * the green area (painted lines, up to ~2 tau - 1 px wide) and drops wide white blobs (shirts, ads) and anything off the grass.
 * `exclude`: boxes (same pixels as img) cleared afterwards, e.g. the detected players.
 */
export function whiteLineMask(img: ImageLike, o: MaskOpts = MASK, exclude: Box[] = []): Uint8Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const white = new Int16Array(n), grass = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[4 * i]!, g = data[4 * i + 1]!, b = data[4 * i + 2]!;
    white[i] = Math.min(r, g, b);
    grass[i] = isGrass(r, g, b) ? 1 : 0;
  }
  const out = new Uint8Array(n);
  const t = o.tau, m = o.margin;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = white[i]!;
    let hit = false;
    if (x >= t && x < w - t) {
      const a = i - t, b = i + t;
      hit = grass[a]! === 1 && grass[b]! === 1 && v - white[a]! > m && v - white[b]! > m;
    }
    if (!hit && y >= t && y < h - t) {
      const a = i - t * w, b = i + t * w;
      hit = grass[a]! === 1 && grass[b]! === 1 && v - white[a]! > m && v - white[b]! > m;
    }
    if (hit) out[i] = 1;
  }
  for (const bx of exclude) {
    const x0 = Math.max(0, Math.floor(bx.x)), x1 = Math.min(w, Math.ceil(bx.x + bx.w));
    const y0 = Math.max(0, Math.floor(bx.y)), y1 = Math.min(h, Math.ceil(bx.y + bx.h));
    for (let y = y0; y < y1; y++) out.fill(0, y * w + x0, y * w + x1);
  }
  return out;
}

/** A line n.p = rho (unit normal n), with the painted runs along it as [t0, t1] intervals of t = d.p, d = (-ny, nx). */
export type Line = { nx: number; ny: number; rho: number; votes: number; runs: [number, number][] };

export type HoughOpts = { thetaBins: number; minVotes: number; maxLines: number; inlier: number; maxGap: number; minRun: number; minLen: number };
export const HOUGH: HoughOpts = { thetaBins: 180, minVotes: 28, maxLines: 24, inlier: 1.6, maxGap: 10, minRun: 10, minLen: 28 };

/** Total-least-squares line through points (principal axis). */
export function fitLine(pts: Pt[]): { nx: number; ny: number; rho: number } | null {
  if (pts.length < 2) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  // direction of largest variance: angle phi; the normal is perpendicular
  const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(phi), ny = Math.cos(phi);
  return { nx, ny, rho: nx * mx + ny * my };
}

/** Runs of sorted positions with gaps <= maxGap, kept when at least minRun long. */
export function runsOf(ts: number[], maxGap: number, minRun: number): [number, number][] {
  if (!ts.length) return [];
  const s = [...ts].sort((a, b) => a - b);
  const out: [number, number][] = [];
  let a = s[0]!, prev = a;
  for (let k = 1; k <= s.length; k++) {
    const t = s[k];
    if (t === undefined || t - prev > maxGap) {
      if (prev - a >= minRun) out.push([a, prev]);
      if (t !== undefined) a = t;
    }
    if (t !== undefined) prev = t;
  }
  return out;
}

/**
 * Sequential Hough transform: vote, take the strongest cell, refine it by least squares on its inliers, record the line if its
 * painted runs are long enough, then remove those points (and their votes) and repeat.
 */
export function houghLines(mask: Uint8Array, w: number, h: number, o: HoughOpts = HOUGH): Line[] {
  const xs: number[] = [], ys: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { xs.push(x); ys.push(y); }
  const N = xs.length, T = o.thetaBins;
  const D = Math.ceil(Math.hypot(w, h)), R = 2 * D + 1;
  const cos = new Float64Array(T), sin = new Float64Array(T);
  for (let k = 0; k < T; k++) { cos[k] = Math.cos((Math.PI * k) / T); sin[k] = Math.sin((Math.PI * k) / T); }
  const acc = new Int32Array(T * R);
  const vote = (i: number, d: number) => {
    for (let k = 0; k < T; k++) acc[k * R + Math.round(xs[i]! * cos[k]! + ys[i]! * sin[k]!) + D]! += d;
  };
  for (let i = 0; i < N; i++) vote(i, 1);
  const alive = new Uint8Array(N).fill(1);
  const lines: Line[] = [];
  for (let iter = 0; iter < o.maxLines * 3 && lines.length < o.maxLines; iter++) {
    let best = 0, bi = -1;
    for (let j = 0; j < acc.length; j++) if (acc[j]! > best) { best = acc[j]!; bi = j; }
    if (best < o.minVotes || bi < 0) break;
    const k = Math.floor(bi / R), rho0 = (bi % R) - D;
    let line = { nx: cos[k]!, ny: sin[k]!, rho: rho0 };
    let inl: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      inl = [];
      const tol = pass === 0 ? o.inlier + 0.5 : o.inlier;
      for (let i = 0; i < N; i++) if (alive[i] && Math.abs(xs[i]! * line.nx + ys[i]! * line.ny - line.rho) <= tol) inl.push(i);
      const f = fitLine(inl.map((i) => ({ x: xs[i]!, y: ys[i]! })));
      if (!f) break;
      line = f;
    }
    // the cell's own voters must go even when the refit drifted, or the same peak would come back forever
    const gone = new Set(inl);
    for (let i = 0; i < N; i++) if (alive[i] && Math.abs(xs[i]! * cos[k]! + ys[i]! * sin[k]! - rho0) <= 0.5) gone.add(i);
    for (const i of gone) { alive[i] = 0; vote(i, -1); }
    const ts = inl.map((i) => -line.ny * xs[i]! + line.nx * ys[i]!);
    const runs = runsOf(ts, o.maxGap, o.minRun);
    const len = runs.reduce((s, [a, b]) => s + b - a, 0);
    if (len >= o.minLen && inl.length >= o.minVotes * 0.7) lines.push({ ...line, votes: inl.length, runs });
  }
  return lines;
}

/** Point on line at parameter t. */
export function pointAt(l: { nx: number; ny: number; rho: number }, t: number): Pt {
  return { x: l.nx * l.rho - l.ny * t, y: l.ny * l.rho + l.nx * t };
}

/** Intersection of two lines (null when nearly parallel: angle < minAngleDeg). */
export function intersect(a: { nx: number; ny: number; rho: number }, b: { nx: number; ny: number; rho: number }, minAngleDeg = 20): Pt | null {
  const det = a.nx * b.ny - a.ny * b.nx; // sin of the angle between the normals
  if (Math.abs(det) < Math.sin((minAngleDeg * Math.PI) / 180)) return null;
  return { x: (a.rho * b.ny - b.rho * a.ny) / det, y: (a.nx * b.rho - b.nx * a.rho) / det };
}

const onRuns = (l: Line, p: Pt, tol: number) => {
  const t = -l.ny * p.x + l.nx * p.y;
  return l.runs.some(([a, b]) => t >= a - tol && t <= b + tol);
};

/**
 * Corners and junctions: intersections of two detected lines that lie on (or within `tol` px of the end of) a painted run of
 * both lines and inside the image; duplicates closer than 3 px are merged.
 */
export function lineIntersections(lines: Line[], w: number, h: number, tol = 6, minAngleDeg = 20): Pt[] {
  const out: { p: Pt; n: number }[] = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const p = intersect(lines[i]!, lines[j]!, minAngleDeg);
    if (!p || p.x < -tol || p.y < -tol || p.x > w + tol || p.y > h + tol) continue;
    if (!onRuns(lines[i]!, p, tol) || !onRuns(lines[j]!, p, tol)) continue;
    const dup = out.find((q) => Math.hypot(q.p.x - p.x, q.p.y - p.y) < 3);
    if (dup) { dup.p = { x: (dup.p.x * dup.n + p.x) / (dup.n + 1), y: (dup.p.y * dup.n + p.y) / (dup.n + 1) }; dup.n++; }
    else out.push({ p, n: 1 });
  }
  return out.map((q) => q.p);
}

/** Snapping rule: the nearest candidate within `radius` of the tap, or null (the tap is then kept as is). */
export function snapPoint(tap: Pt, candidates: Pt[], radius: number): { p: Pt; d: number } | null {
  let best: { p: Pt; d: number } | null = null;
  for (const c of candidates) {
    const d = Math.hypot(c.x - tap.x, c.y - tap.y);
    if (d <= radius && (!best || d < best.d)) best = { p: c, d };
  }
  return best;
}

/** Chamfer (3-4) distance transform: distance in pixels from each pixel to the nearest mask pixel (approximately Euclidean). */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? 0 : INF;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? INF : d[y * w + x]!);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    d[i] = Math.min(d[i]!, at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    d[i] = Math.min(d[i]!, at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
  }
  for (let i = 0; i < w * h; i++) d[i] = d[i]! / 3;
  return d;
}

/**
 * Working pixel indices to source coordinates: pixel i covers [i, i + 1) of the working image, so its centre is at i + 0.5,
 * i.e. at (i + 0.5) / scale in the source (canvas coordinates, where a pixel's centre is at its index + 0.5 too).
 */
export function toSource(scale: number, p: Pt): Pt {
  return { x: (p.x + 0.5) / scale, y: (p.y + 0.5) / scale };
}

/** Everything the page needs from one picture, in working pixels (scale = working px per source px). */
export type LineScan = { w: number; h: number; scale: number; mask: Uint8Array; lines: Line[]; corners: Pt[]; dist: Float32Array; grass: Uint8Array };

export function scanLines(img: ImageLike, scale: number, exclude: Box[] = []): LineScan {
  const mask = whiteLineMask(img, MASK, exclude);
  const lines = houghLines(mask, img.width, img.height);
  const grass = new Uint8Array(img.width * img.height);
  for (let i = 0; i < grass.length; i++) grass[i] = isGrass(img.data[4 * i]!, img.data[4 * i + 1]!, img.data[4 * i + 2]!) || mask[i] ? 1 : 0;
  return { w: img.width, h: img.height, scale, mask, lines, corners: lineIntersections(lines, img.width, img.height),
    dist: distanceTransform(mask, img.width, img.height), grass };
}

export type FitRating = "good" | "check" | "poor";
/** Thresholds on the mean distance, in working pixels (640 px wide): good < 1.5 (~0.25 % of the width), check < 4. */
export const FIT = { good: 1.5, check: 4, cap: 12, step: 3, minSamples: 40 } as const;
export type FitOpts = { good: number; check: number; cap: number; step: number; minSamples: number };

/**
 * Fit quality: samples the reprojected pitch lines every `step` working px, keeps the samples inside the picture and on the
 * grass (lines hidden off the pitch area cannot be checked), and averages their distance to the nearest detected line pixel
 * (capped at `cap`, so an occluded stretch counts as "far" but cannot dominate). Returns null with too few samples.
 * `p2i` maps pitch metres to SOURCE pixels; distances are returned in source pixels.
 */
export function fitQuality(scan: LineScan, p2i: Mat3, polylines: Pt[][], o: FitOpts = FIT): { mean: number; rating: FitRating; samples: number } | null {
  const ds: number[] = [];
  const toWork = (m: Pt): Pt | null => {
    if (wOf(p2i, m) <= 0) return null;
    const q = applyH(p2i, m);
    return q ? { x: q.x * scan.scale - 0.5, y: q.y * scan.scale - 0.5 } : null; // inverse of toSource
  };
  for (const line of polylines) for (let k = 0; k < line.length - 1; k++) {
    const a = toWork(line[k]!), b = toWork(line[k + 1]!);
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 4 * (scan.w + scan.h)) continue; // segment through the horizon
    const n = Math.max(1, Math.round(len / o.step));
    for (let s = 0; s < n; s++) {
      const x = Math.round(a.x + ((b.x - a.x) * s) / n), y = Math.round(a.y + ((b.y - a.y) * s) / n);
      if (x < 0 || y < 0 || x >= scan.w || y >= scan.h) continue;
      if (!scan.grass[y * scan.w + x]) continue;
      ds.push(Math.min(o.cap, scan.dist[y * scan.w + x]!));
    }
  }
  if (ds.length < o.minSamples) return null;
  const meanWork = ds.reduce((s, d) => s + d, 0) / ds.length;
  return { mean: meanWork / scan.scale, rating: meanWork < o.good ? "good" : meanWork < o.check ? "check" : "poor", samples: ds.length };
}

/**
 * Reprojection error of the 4 calibration points. With exactly 4 points the homography fits them exactly (error 0), so the
 * check adds every other landmark whose reprojection lands within `maxPx` of a detected corner, fits a least-squares
 * homography on all of them, and reports the mean distance (source px) between the 4 points and their reprojection.
 * `extra`: candidate landmarks in pitch metres (the 4 chosen ones are skipped by the caller). Corners in SOURCE px.
 */
export function calibrationCheck(pitch4: Pt[], img4: Pt[], extra: Pt[], corners: Pt[], maxPx = 10): { err: number; n: number } | null {
  const H = computeHomography(pitch4, img4);
  if (!H) return null;
  const src = [...pitch4], dst = [...img4];
  for (const m of extra) {
    if (wOf(H, m) * wOf(H, pitch4[0]!) <= 0) continue; // behind the camera
    const q = applyH(H, m);
    if (!q) continue;
    const s = snapPoint(q, corners, maxPx);
    if (s) { src.push(m); dst.push(s.p); }
  }
  if (src.length === 4) return { err: 0, n: 4 };
  const Hls = computeHomography(src, dst);
  if (!Hls) return null;
  return { err: reprojectionError(Hls, pitch4, img4), n: src.length };
}
