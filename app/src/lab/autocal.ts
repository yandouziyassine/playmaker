// Automatic pitch calibration from the detected painted lines (lines.ts), no taps. Pure functions, unit-tested in
// app/test/lab-autocal.test.ts.
//
// Search, factorised by line family so it stays cheap:
//  1. the detected lines are clustered into two pencils by vanishing point ("goal-line-parallel" lines meet at one point,
//     "touchline-parallel" lines at the other); the line through the two vanishing points is the horizon;
//  2. in a pencil, the lines of the pitch model (x = const for one family, y = const for the other) map to the pencil
//     parameter by a 1-D projectivity which, with the horizon known, is affine: two line correspondences fix it. Every
//     pair of detected lines x every ordered pair of model lines gives a family hypothesis, scored by how well the
//     predicted lines explain the detected paint of the family;
//  3. the best family hypotheses are combined (2 lines + 2 lines = 4 line correspondences = 4 points), solved by DLT,
//     scored by the fit metric of lines.ts (mean distance of all reprojected model lines to detected paint, arcs and circle
//     included, which tells the penalty box from the goal area or the whole pitch) plus the paint left unexplained;
//  4. the best hypothesis is refined by least squares on the intersections of all inlier lines.
// Convention of landmarks.ts: the camera is on the near touchline side (y = -34 at the bottom of the picture, x to the
// right), so the Jacobian of pitch -> image is negative; the goal position (which side the goal line is on) then tells the
// left box from the right one, and both halves are searched. Distinct solutions are returned ranked (alternatives) so an
// ambiguous view (few lines) can be reported.
import { applyH, computeHomography, hasCollinearTriple, invert3, mul3, orientH, wOf, type Mat3, type Pt } from "./homography.ts";
import { LANDMARKS, MODEL_X, MODEL_Y, pitchLines, straightSegments } from "./landmarks.ts";
import { FIT, fitQuality, intersect, pointAt, type FitRating, type Line, type LineScan } from "./lines.ts";

type Vec3 = [number, number, number];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const lineVec = (l: { nx: number; ny: number; rho: number }): Vec3 => [l.nx, l.ny, -l.rho];
/** Homogeneous point -> pixel point (null at infinity). */
const dehom = (v: Vec3): Pt | null => (Math.abs(v[2]) < 1e-9 * Math.hypot(v[0], v[1]) ? null : { x: v[0] / v[2], y: v[1] / v[2] });
/** Distance from p to the line (a, b, c). */
const lineDist = (l: Vec3, p: Pt) => Math.abs(l[0] * p.x + l[1] * p.y + l[2]) / (Math.hypot(l[0], l[1]) || 1e-12);

export type AutoCalOpts = {
  budgetMs: number;      // time cap of the search
  vpTolDeg: number;      // a line belongs to a vanishing point when its direction is within this angle of it
  keep: number;          // family hypotheses kept per family
  explainTol: number;    // working px: a detected line is explained by a model line within this mean distance
  inlierTol: number;     // working px: inlier lines for the final refinement
  step: number;          // fit sampling step during the search (working px); the final metric uses FIT.step
  samplesPerLine: number;
  ambiguity: number;     // a 2nd distinct solution within this factor of the best score makes the result "check"
};
export const AUTOCAL: AutoCalOpts = { budgetMs: 300, vpTolDeg: 2.5, keep: 24, explainTol: 2.5, inlierTol: 3, step: 6, samplesPerLine: 10, ambiguity: 1.15 };

/** Points along the painted runs of a line (working px). */
export function lineSamples(l: Line, n: number): Pt[] {
  const total = l.runs.reduce((s, [a, b]) => s + b - a, 0);
  if (total <= 0) return [];
  const out: Pt[] = [];
  for (const [a, b] of l.runs) {
    const k = Math.max(1, Math.round((n * (b - a)) / total));
    for (let i = 0; i < k; i++) out.push(pointAt(l, a + ((b - a) * (i + 0.5)) / k));
  }
  return out;
}

const midOf = (l: Line): Pt => {
  const longest = l.runs.reduce((m, r) => (r[1] - r[0] > m[1] - m[0] ? r : m), l.runs[0] ?? [0, 0]);
  return pointAt(l, (longest[0] + longest[1]) / 2);
};

/** sin of the angle between the line and the direction from its midpoint to the (homogeneous) point v. */
function sinDev(l: Line, mid: Pt, v: Vec3): number {
  const num = Math.abs(l.nx * v[0] + l.ny * v[1] - l.rho * v[2]);
  const den = Math.hypot(v[0] - mid.x * v[2], v[1] - mid.y * v[2]);
  return den < 1e-9 ? 1 : num / den;
}

export type Family = { v: Vec3; idx: number[] };

/**
 * Two vanishing points from the detected lines: the point (intersection of two lines) supported by most lines within
 * tolDeg, then the same among the remaining lines; each line goes to the point it deviates least from. Null when a
 * family would have fewer than 2 lines or the two points coincide.
 */
export function vanishingPoints(lines: Line[], tolDeg = AUTOCAL.vpTolDeg): [Family, Family] | null {
  if (lines.length < 4) return null;
  const mids = lines.map(midOf), tol = Math.sin((tolDeg * Math.PI) / 180);
  const vecs = lines.map(lineVec);
  // ties (e.g. 2 + 2 lines: every pair is a vanishing point) go to the members with the most similar directions: lines
  // parallel on the pitch keep similar directions in the picture, except very close to the camera
  const spread = (idx: number[]) => {
    let s = 0;
    for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
      const la = lines[idx[a]!]!, lb = lines[idx[b]!]!;
      s += 1 - Math.abs(la.nx * lb.nx + la.ny * lb.ny);
    }
    return s / Math.max(1, (idx.length * (idx.length - 1)) / 2);
  };
  const bestOf = (pool: number[]): Family | null => {
    let best: Family | null = null, bestKey = Infinity;
    for (let a = 0; a < pool.length; a++) for (let b = a + 1; b < pool.length; b++) {
      const v = unit(cross(vecs[pool[a]!]!, vecs[pool[b]!]!));
      if (Math.hypot(v[0], v[1], v[2]) < 1e-9) continue;
      const idx: number[] = []; let dev = 0;
      for (const i of pool) { const d = sinDev(lines[i]!, mids[i]!, v); if (d < tol) { idx.push(i); dev += d; } }
      if (idx.length < 2) continue;
      const key = spread(idx) + dev;
      if (!best || idx.length > best.idx.length || (idx.length === best.idx.length && key < bestKey)) { best = { v, idx }; bestKey = key; }
    }
    return best;
  };
  const all = lines.map((_, i) => i);
  const f1 = bestOf(all);
  if (!f1) return null;
  const f2 = bestOf(all.filter((i) => !f1.idx.includes(i)));
  if (!f2) return null;
  // the two families must look in different directions (a horizon exists)
  if (Math.hypot(...cross(f1.v, f2.v)) < 1e-6) return null;
  const i1: number[] = [], i2: number[] = [];
  for (const i of all) {
    const d1 = sinDev(lines[i]!, mids[i]!, f1.v), d2 = sinDev(lines[i]!, mids[i]!, f2.v);
    if (d1 < tol && d1 <= d2) i1.push(i); else if (d2 < tol) i2.push(i);
  }
  if (i1.length < 2 || i2.length < 2) return null;
  return [{ v: f1.v, idx: i1 }, { v: f2.v, idx: i2 }];
}

/** A family as a pencil: line(t) = l0 + t h (h = horizon), with each member's parameter t. */
type Pencil = { l0: Vec3; h: Vec3; idx: number[]; t: number[]; samples: Pt[][] };

function pencil(lines: Line[], fam: Family, other: Family, n: number): Pencil | null {
  const h = unit(cross(fam.v, other.v));
  const strongest = fam.idx.reduce((a, i) => (lines[i]!.votes > lines[a]!.votes ? i : a), fam.idx[0]!);
  const l0 = unit(lineVec(lines[strongest]!));
  const idx: number[] = [], t: number[] = [], samples: Pt[][] = [];
  for (const i of fam.idx) {
    const l = unit(lineVec(lines[i]!));
    // least squares l ~ lam l0 + mu h
    const a = l0[0] * l0[0] + l0[1] * l0[1] + l0[2] * l0[2], b = l0[0] * h[0] + l0[1] * h[1] + l0[2] * h[2], c = h[0] * h[0] + h[1] * h[1] + h[2] * h[2];
    const r0 = l0[0] * l[0] + l0[1] * l[1] + l0[2] * l[2], r1 = h[0] * l[0] + h[1] * l[1] + h[2] * l[2];
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-12) continue;
    const lam = (r0 * c - r1 * b) / det, mu = (a * r1 - b * r0) / det;
    if (Math.abs(lam) < 1e-9) continue;
    idx.push(i); t.push(mu / lam); samples.push(lineSamples(lines[i]!, n));
  }
  return idx.length >= 2 ? { l0, h, idx, t, samples } : null;
}

const pencilLine = (p: Pencil, t: number): Vec3 => [p.l0[0] + t * p.h[0], p.l0[1] + t * p.h[1], p.l0[2] + t * p.h[2]];

/** One family hypothesis: model coordinate m -> pencil parameter a m + b, from detected lines (i, j) <-> model (mi, mj). */
export type FamilyHyp = { a: number; b: number; i: number; j: number; mi: number; mj: number; score: number; explained: number };

function familyHypotheses(p: Pencil, model: readonly number[], o: AutoCalOpts): FamilyHyp[] {
  const out: FamilyHyp[] = [];
  const cap = 6;
  for (let a = 0; a < p.idx.length; a++) for (let b = a + 1; b < p.idx.length; b++) {
    const ti = p.t[a]!, tj = p.t[b]!;
    if (Math.abs(tj - ti) < 1e-9) continue;
    for (let k = 0; k < model.length; k++) for (let l = 0; l < model.length; l++) {
      if (k === l) continue;
      const A = (tj - ti) / (model[l]! - model[k]!), B = ti - A * model[k]!;
      const pred = model.map((m) => pencilLine(p, A * m + B));
      let sum = 0, n = 0, explained = 0;
      for (let q = 0; q < p.idx.length; q++) {
        let s = 0;
        for (const pt of p.samples[q]!) {
          let d = Infinity;
          for (const L of pred) d = Math.min(d, lineDist(L, pt));
          s += Math.min(cap, d);
        }
        const mean = s / (p.samples[q]!.length || 1);
        if (mean < o.explainTol) explained++;
        sum += s; n += p.samples[q]!.length;
      }
      out.push({ a: A, b: B, i: p.idx[a]!, j: p.idx[b]!, mi: k, mj: l, score: n ? sum / n : cap, explained });
    }
  }
  out.sort((x, y) => y.explained - x.explained || x.score - y.score);
  return out.slice(0, o.keep);
}

// ---------- full hypotheses ----------

export type AutoCal = {
  H: Mat3;          // pitch metres -> source px
  Hwork: Mat3;      // pitch metres -> working px (scan)
  score: number;    // lower is better: fit mean + unexplained paint (working px)
  fitMean: number | null; // source px (the Lab's fit metric)
  fitWork: number | null; // working px
  rating: FitRating;
  inliers: number;  // detected lines explained by the model
  points: { model: Pt; p: Pt }[]; // inlier line intersections <-> model intersections (source px)
  matched: { id: string; p: Pt }[]; // those that are real landmarks (source px)
  side: "L" | "R" | "both";
};

export type AutoCalResult = {
  best: AutoCal | null;
  alternatives: AutoCal[]; // other distinct solutions, best first
  ms: number;
  tried: number;
  truncated: boolean;
  reason?: "lines" | "families" | "none";
};

const POLYLINES = pitchLines();
const SEGMENTS = straightSegments();

/** Working px -> source px (inverse of lines.ts toSource). */
const toSourceMat = (scale: number): Mat3 => [1 / scale, 0, 0.5 / scale, 0, 1 / scale, 0.5 / scale, 0, 0, 1];

function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** The straight model segments through H (working px), those in front of the camera and not through the horizon. */
function modelSegments(Hw: Mat3, w: number, h: number): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (const [a, b] of SEGMENTS) {
    if (wOf(Hw, a) <= 0 || wOf(Hw, b) <= 0) continue;
    const pa = applyH(Hw, a), pb = applyH(Hw, b);
    if (!pa || !pb || Math.hypot(pb.x - pa.x, pb.y - pa.y) > 4 * (w + h)) continue;
    out.push([pa, pb]);
  }
  return out;
}

type Scored = { score: number; fitWork: number | null; fitMean: number | null; rating: FitRating; inliers: number; perLine: number[] };

/** Scores H (pitch -> working px): fit of the model lines to the paint + mean distance of the paint to the model. */
function scoreH(scan: LineScan, Hw: Mat3, samples: Pt[][], step: number): Scored {
  const fit = fitQuality(scan, mul3(toSourceMat(scan.scale), Hw), POLYLINES, { ...FIT, step });
  const fitWork = fit ? fit.mean * scan.scale : null;
  const segs = modelSegments(Hw, scan.w, scan.h);
  const cap: number = FIT.cap;
  let sum = 0, n = 0, inliers = 0;
  const perLine: number[] = [];
  for (const pts of samples) {
    let s = 0;
    for (const p of pts) {
      let d = cap;
      for (const [a, b] of segs) { d = Math.min(d, segDist(p, a, b)); if (d === 0) break; }
      s += d;
    }
    const mean = pts.length ? s / pts.length : cap;
    perLine.push(mean);
    if (mean < AUTOCAL.explainTol) inliers++;
    sum += s; n += pts.length;
  }
  const unexplained = n ? sum / n : cap;
  const score = fitWork === null ? Infinity : fitWork + unexplained;
  const rating: FitRating = fitWork === null ? "poor" : fitWork < FIT.good ? "good" : fitWork < FIT.check ? "check" : "poor";
  return { score, fitWork, fitMean: fit ? fit.mean : null, rating, inliers, perLine };
}

/**
 * Camera convention of landmarks.ts (near touchline at the bottom, x to the right): the Jacobian of pitch -> image is
 * negative AND pitch y grows upwards in the picture. The second test tells a view from a view of the pitch rotated by
 * 180 degrees (the model is centrally symmetric, so the lines alone cannot: the left box seen from the far side is the
 * right box seen from the near side).
 */
function orientationOk(Hw: Mat3, at: Pt): boolean {
  const p = applyH(Hw, at), px = applyH(Hw, { x: at.x + 0.5, y: at.y }), py = applyH(Hw, { x: at.x, y: at.y + 0.5 });
  if (!p || !px || !py) return false;
  return (px.x - p.x) * (py.y - p.y) - (px.y - p.y) * (py.x - p.x) < 0 && py.y < p.y;
}

/** Pitch positions of 4 image points: two solutions are the same when these agree within tol metres. */
function signature(Hw: Mat3, w: number, h: number): (Pt | null)[] {
  const inv = invert3(Hw);
  const pts = [{ x: w / 4, y: h / 4 }, { x: (3 * w) / 4, y: h / 4 }, { x: w / 4, y: (3 * h) / 4 }, { x: (3 * w) / 4, y: (3 * h) / 4 }];
  return pts.map((p) => (inv && wOf(inv, p) > 0 ? applyH(inv, p) : null));
}
function sameSolution(a: (Pt | null)[], b: (Pt | null)[], tol = 1.5): boolean {
  return a.every((p, i) => { const q = b[i]!; return (!p && !q) || (!!p && !!q && Math.hypot(p.x - q.x, p.y - q.y) < tol); });
}

/**
 * Inlier line correspondences for H: each detected line goes to the nearest model line (x = const or y = const) when its
 * paint lies within tol px of it; the intersections of inlier lines of the two families give point correspondences.
 */
export function inlierPoints(scan: LineScan, Hw: Mat3, samples: Pt[][], tol: number): { model: Pt; p: Pt }[] {
  type Corr = { line: Line; fam: "x" | "y"; m: number };
  const corr: Corr[] = [];
  const far = 3 * (scan.w + scan.h);
  const modelLine = (fam: "x" | "y", m: number): Vec3 | null => {
    // the image line through the images of two points of the model line (both in front of the camera)
    const a = fam === "x" ? { x: m, y: -20 } : { x: -20, y: m }, b = fam === "x" ? { x: m, y: 20 } : { x: 20, y: m };
    if (wOf(Hw, a) <= 0 || wOf(Hw, b) <= 0) return null;
    const pa = applyH(Hw, a), pb = applyH(Hw, b);
    if (!pa || !pb || Math.abs(pa.x) > far || Math.abs(pb.x) > far || Math.abs(pa.y) > far || Math.abs(pb.y) > far) return null;
    return cross([pa.x, pa.y, 1], [pb.x, pb.y, 1]);
  };
  const cands: { fam: "x" | "y"; m: number; L: Vec3 }[] = [];
  for (const m of MODEL_X) { const L = modelLine("x", m); if (L) cands.push({ fam: "x", m, L }); }
  for (const m of MODEL_Y) { const L = modelLine("y", m); if (L) cands.push({ fam: "y", m, L }); }
  scan.lines.forEach((line, i) => {
    const pts = samples[i]!;
    if (!pts.length) return;
    let best: typeof cands[number] | null = null, bestD = tol;
    for (const c of cands) {
      let s = 0;
      for (const p of pts) s += lineDist(c.L, p);
      const d = s / pts.length;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) corr.push({ line, fam: best.fam, m: best.m });
  });
  const out: { model: Pt; p: Pt }[] = [];
  for (const cx of corr) for (const cy of corr) {
    if (cx.fam !== "x" || cy.fam !== "y") continue;
    const p = intersect(cx.line, cy.line, 4);
    if (!p || Math.abs(p.x) > far || Math.abs(p.y) > far) continue;
    out.push({ model: { x: cx.m, y: cy.m }, p });
  }
  return out;
}

/** Least-squares homography on the inlier intersections (normalised DLT); null with too few or degenerate points. */
function refineH(scan: LineScan, Hw: Mat3, samples: Pt[][], tol: number): { H: Mat3; points: { model: Pt; p: Pt }[] } | null {
  const points = inlierPoints(scan, Hw, samples, tol);
  if (points.length < 4) return null;
  const src = points.map((q) => q.model), dst = points.map((q) => q.p);
  if (new Set(src.map((p) => p.x)).size < 2 || new Set(src.map((p) => p.y)).size < 2) return null;
  const H = computeHomography(src, dst);
  if (!H) return null;
  const c = src.reduce((s, p) => ({ x: s.x + p.x / src.length, y: s.y + p.y / src.length }), { x: 0, y: 0 });
  const Ho = orientH(H, c);
  if (!orientationOk(Ho, c)) return null;
  return { H: Ho, points };
}

function finish(scan: LineScan, Hw: Mat3, sc: Scored, points: { model: Pt; p: Pt }[]): AutoCal {
  const S = toSourceMat(scan.scale);
  const toSrc = (p: Pt) => applyH(S, p)!;
  const matched: { id: string; p: Pt }[] = [];
  for (const q of points) {
    const lm = LANDMARKS.find((l) => Math.abs(l.x - q.model.x) < 0.05 && Math.abs(l.y - q.model.y) < 0.05);
    if (lm && !matched.some((m) => m.id === lm.id)) matched.push({ id: lm.id, p: toSrc(q.p) });
  }
  const xs = points.map((q) => q.model.x).filter((x) => Math.abs(x) > 1);
  const side = xs.length === 0 ? "both" : xs.every((x) => x > 0) ? "R" : xs.every((x) => x < 0) ? "L" : "both";
  return { H: mul3(S, Hw), Hwork: Hw, score: sc.score, fitMean: sc.fitMean, fitWork: sc.fitWork, rating: sc.rating, inliers: sc.inliers,
    points: points.map((q) => ({ model: q.model, p: toSrc(q.p) })), matched, side };
}

/** Full search (see the file comment). `now` is injectable for tests. */
export function autoCalibrate(scan: LineScan, opts: Partial<AutoCalOpts> = {}, now: () => number = () => performance.now()): AutoCalResult {
  const o = { ...AUTOCAL, ...opts };
  const t0 = now();
  const done = (r: Omit<AutoCalResult, "ms">): AutoCalResult => ({ ...r, ms: now() - t0 });
  if (scan.lines.length < 4) return done({ best: null, alternatives: [], tried: 0, truncated: false, reason: "lines" });
  const fams = vanishingPoints(scan.lines, o.vpTolDeg);
  if (!fams) return done({ best: null, alternatives: [], tried: 0, truncated: false, reason: "families" });
  const samples = scan.lines.map((l) => lineSamples(l, o.samplesPerLine));
  type Cand = { Hw: Mat3; sc: Scored; sig: (Pt | null)[] };
  const cands: Cand[] = [];
  let tried = 0, truncated = false;
  // both assignments of the two families to the model's x-lines and y-lines; the more horizontal family first (touchlines)
  const horiz = (f: Family) => f.idx.reduce((s, i) => s + Math.abs(scan.lines[i]!.ny), 0) / f.idx.length;
  const order = horiz(fams[0]) >= horiz(fams[1]) ? [[fams[1], fams[0]], [fams[0], fams[1]]] : [[fams[0], fams[1]], [fams[1], fams[0]]];
  search: for (const [fx, fy] of order as [Family, Family][]) {
    // the other assignment is only worth trying when this one found nothing convincing
    if (cands.some((c) => c.sc.rating === "good" && c.sc.inliers >= 4)) break;
    const px = pencil(scan.lines, fx, fy, o.samplesPerLine), py = pencil(scan.lines, fy, fx, o.samplesPerLine);
    if (!px || !py) continue;
    const hx = familyHypotheses(px, MODEL_X, o), hy = familyHypotheses(py, MODEL_Y, o);
    // combos by increasing rank sum, so the best pairs come first when the time runs out
    const combos: [number, number][] = [];
    for (let a = 0; a < hx.length; a++) for (let b = 0; b < hy.length; b++) combos.push([a, b]);
    combos.sort((u, v) => u[0] + u[1] - v[0] - v[1]);
    for (const [a, b] of combos) {
      if (now() - t0 > o.budgetMs) { truncated = true; break search; }
      const X = hx[a]!, Y = hy[b]!;
      const lx = [MODEL_X[X.mi]!, MODEL_X[X.mj]!].map((m) => pencilLine(px, X.a * m + X.b));
      const ly = [MODEL_Y[Y.mi]!, MODEL_Y[Y.mj]!].map((m) => pencilLine(py, Y.a * m + Y.b));
      const model: Pt[] = [], img: Pt[] = [];
      let ok = true;
      for (let u = 0; u < 2 && ok; u++) for (let v = 0; v < 2; v++) {
        const p = dehom(cross(lx[u]!, ly[v]!));
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 10 * scan.w || Math.abs(p.y) > 10 * scan.h) { ok = false; break; }
        model.push({ x: u === 0 ? MODEL_X[X.mi]! : MODEL_X[X.mj]!, y: v === 0 ? MODEL_Y[Y.mi]! : MODEL_Y[Y.mj]! });
        img.push(p);
      }
      tried++;
      if (!ok) continue;
      const H0 = computeHomography(model, img);
      if (!H0) continue;
      const c = { x: (model[0]!.x + model[3]!.x) / 2, y: (model[0]!.y + model[3]!.y) / 2 };
      const Hw = orientH(H0, c);
      if (model.some((m) => wOf(Hw, m) <= 0) || !orientationOk(Hw, c)) continue;
      const sc = scoreH(scan, Hw, samples, o.step);
      if (!Number.isFinite(sc.score)) continue;
      cands.push({ Hw, sc, sig: signature(Hw, scan.w, scan.h) });
    }
  }
  if (!cands.length) return done({ best: null, alternatives: [], tried, truncated, reason: "none" });
  cands.sort((u, v) => u.sc.score - v.sc.score);
  // distinct solutions, best first
  const distinct: Cand[] = [];
  for (const c of cands) { if (!distinct.some((d) => sameSolution(d.sig, c.sig))) distinct.push(c); if (distinct.length >= 4) break; }
  // refine the top ones with all their inlier intersections, re-score with the final metric
  const results: AutoCal[] = [];
  for (const c of distinct.slice(0, 3)) {
    let Hw = c.Hw, sc = scoreH(scan, Hw, samples, FIT.step);
    const r = refineH(scan, Hw, samples, o.inlierTol);
    let points = r?.points ?? inlierPoints(scan, Hw, samples, o.inlierTol);
    if (r) {
      const sr = scoreH(scan, r.H, samples, FIT.step);
      if (sr.score <= sc.score + 0.05) { Hw = r.H; sc = sr; points = inlierPoints(scan, Hw, samples, o.inlierTol); }
    }
    results.push(finish(scan, Hw, sc, points));
  }
  results.sort((u, v) => u.score - v.score);
  const best = results[0]!;
  const second = results[1];
  if (best.inliers < 4) best.rating = "poor";
  else if (best.rating === "good" && second && second.score < best.score * o.ambiguity + 0.2) best.rating = "check";
  return done({ best, alternatives: results.slice(1), tried, truncated });
}

/**
 * Live mode: local refinement seeded by the current homography (pitch -> SOURCE px): inlier lines around the seed's
 * reprojection, least squares on their intersections. Null when the seed cannot be improved (or fewer than 4 points).
 */
export function refineCalibration(scan: LineScan, Hsource: Mat3, opts: Partial<AutoCalOpts> = {}): AutoCal | null {
  const o = { ...AUTOCAL, ...opts };
  const Sinv = invert3(toSourceMat(scan.scale));
  if (!Sinv) return null;
  const seed = mul3(Sinv, Hsource);
  const samples = scan.lines.map((l) => lineSamples(l, o.samplesPerLine));
  const r = refineH(scan, seed, samples, o.inlierTol * 2);
  if (!r) return null;
  const sc = scoreH(scan, r.H, samples, FIT.step);
  if (!Number.isFinite(sc.score)) return null;
  const res = finish(scan, r.H, sc, r.points);
  if (res.inliers < 4) res.rating = "poor";
  return res;
}

/** Residual of a calibration (pitch -> source px) on a scan, in working px; null with too few checkable samples. */
export function residualOf(scan: LineScan, Hsource: Mat3): number | null {
  const f = fitQuality(scan, Hsource, POLYLINES);
  return f ? f.mean * scan.scale : null;
}

/**
 * Four landmarks for the manual UI (ids + source px): the matched ones first, spread as far apart as possible, then other
 * landmarks in front of the camera (inside the picture first). Never 3 on a line.
 */
export function pickFour(cal: AutoCal, w: number, h: number): { ids: string[]; pts: Pt[] } | null {
  type C = { id: string; p: Pt; m: Pt; prio: number };
  const cands: C[] = [];
  for (const l of LANDMARKS) {
    const m = { x: l.x, y: l.y };
    const hit = cal.matched.find((q) => q.id === l.id);
    if (hit) { cands.push({ id: l.id, p: hit.p, m, prio: 0 }); continue; }
    if (wOf(cal.H, m) <= 0) continue;
    const p = applyH(cal.H, m);
    if (!p || Math.abs(p.x) > 3 * w || Math.abs(p.y) > 3 * h) continue;
    const inside = p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h;
    cands.push({ id: l.id, p, m, prio: inside ? 1 : 2 });
  }
  if (cands.length < 4) return null;
  const okWith = (set: C[], c: C) => {
    const s = [...set, c];
    return s.length < 3 || (!hasCollinearTriple(s.map((q) => q.m), 2e-3) && !hasCollinearTriple(s.map((q) => q.p), 1e-3));
  };
  // greedy: best priority, then farthest from the points already chosen
  const chosen: C[] = [];
  while (chosen.length < 4) {
    let best: C | null = null, bestKey = -Infinity;
    for (const c of cands) {
      if (chosen.includes(c) || !okWith(chosen, c)) continue;
      const d = chosen.length ? Math.min(...chosen.map((q) => Math.hypot(q.p.x - c.p.x, q.p.y - c.p.y))) : Math.hypot(c.p.x - w / 2, c.p.y - h / 2);
      const key = -c.prio * 1e6 + d;
      if (key > bestKey) { bestKey = key; best = c; }
    }
    if (!best) return null;
    chosen.push(best);
  }
  return { ids: chosen.map((c) => c.id), pts: chosen.map((c) => c.p) };
}

// ---------- chamfer refinement: all model lines (circle and arcs included) against the distance map of the paint ----------

/** Chamfer cost of H (pitch -> working px): mean capped distance from the reprojected model lines to the paint, n samples. */
export function chamferCost(scan: LineScan, Hw: Mat3, step = 4, cap = 8): { mean: number; n: number } {
  let s = 0, n = 0;
  for (const line of POLYLINES) for (let k = 0; k < line.length - 1; k++) {
    if (wOf(Hw, line[k]!) <= 0 || wOf(Hw, line[k + 1]!) <= 0) continue;
    const a = applyH(Hw, line[k]!), b = applyH(Hw, line[k + 1]!);
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 4 * (scan.w + scan.h)) continue;
    const m = Math.max(1, Math.round(len / step));
    for (let i = 0; i < m; i++) {
      const x = Math.round(a.x + ((b.x - a.x) * i) / m), y = Math.round(a.y + ((b.y - a.y) * i) / m);
      if (x < 0 || y < 0 || x >= scan.w || y >= scan.h || !scan.grass[y * scan.w + x]) continue;
      s += Math.min(cap, scan.dist[y * scan.w + x]!); n++;
    }
  }
  return { mean: n ? s / n : cap, n };
}

/** The image-space correction that moves the 4 picture corners by d (8 numbers, working px). */
function cornerWarp(w: number, h: number, d: number[]): Mat3 | null {
  const src = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  return computeHomography(src, src.map((p, i) => ({ x: p.x + d[2 * i]!, y: p.y + d[2 * i + 1]! })));
}

/** maxShift / shiftStep: translation search of the propagation (working px); accept: chamfer mean (working px) to keep it. */
export const CHAMFER = { maxShift: 48, shiftStep: 4, steps: [6, 3, 1.5, 0.75, 0.4], minSamples: 60, accept: 2.5 } as const;

/**
 * Local refinement of H (pitch -> working px) by coordinate descent on the corner displacements of an image-space
 * correction, minimising chamferCost. With `shift`, a coarse translation search (the camera motion since the frame H
 * came from) runs first. Returns the refined H, its cost and the translation found (working px).
 */
export function chamferRefine(scan: LineScan, Hw: Mat3, shift = 0): { Hw: Mat3; mean: number; n: number; motion: Pt } {
  const evalD = (d: number[]) => { const D = cornerWarp(scan.w, scan.h, d); if (!D) return null; const H = mul3(D, Hw); return { H, c: chamferCost(scan, H) }; };
  const ok = (c: { mean: number; n: number }) => c.n >= CHAMFER.minSamples;
  let d = new Array<number>(8).fill(0);
  let cur = chamferCost(scan, Hw);
  if (!ok(cur)) cur = { mean: Infinity, n: cur.n };
  const motion = { x: 0, y: 0 };
  if (shift > 0) {
    for (let dy = -shift; dy <= shift; dy += CHAMFER.shiftStep) for (let dx = -shift; dx <= shift; dx += CHAMFER.shiftStep) {
      const e = [dx, dy, dx, dy, dx, dy, dx, dy];
      const r = evalD(e);
      if (r && ok(r.c) && r.c.mean < cur.mean - 1e-6) { cur = r.c; d = e; motion.x = dx; motion.y = dy; }
    }
  }
  for (const st of CHAMFER.steps) {
    for (let it = 0, improved = true; improved && it < 6; it++) {
      improved = false;
      for (let k = 0; k < 8; k++) for (const sg of [1, -1]) {
        const e = [...d]; e[k] = e[k]! + sg * st;
        const r = evalD(e);
        if (r && ok(r.c) && r.c.mean < cur.mean - 1e-4) { cur = r.c; d = e; improved = true; }
      }
    }
  }
  const D = cornerWarp(scan.w, scan.h, d);
  return { Hw: D ? mul3(D, Hw) : Hw, mean: cur.mean, n: cur.n, motion };
}

function chamferResult(scan: LineScan, Hw: Mat3): AutoCal | null {
  const samples = scan.lines.map((l) => lineSamples(l, AUTOCAL.samplesPerLine));
  const sc = scoreH(scan, Hw, samples, FIT.step);
  if (!Number.isFinite(sc.score) || sc.rating === "poor") return null;
  return finish(scan, Hw, sc, inlierPoints(scan, Hw, samples, AUTOCAL.inlierTol));
}

/**
 * Clip mode, temporal continuity: the previous homography (pitch -> SOURCE px) moved by the camera motion found by a
 * translation search on the paint (at most CHAMFER.maxShift working px), then refined on all the model lines. Null when
 * the result does not fit the paint.
 */
export function propagateCalibration(scan: LineScan, Hsource: Mat3, maxShift: number = CHAMFER.maxShift): (AutoCal & { motion: Pt }) | null {
  const Sinv = invert3(toSourceMat(scan.scale));
  if (!Sinv) return null;
  const r = chamferRefine(scan, mul3(Sinv, Hsource), maxShift);
  if (!Number.isFinite(r.mean) || r.mean > CHAMFER.accept) return null;
  const res = chamferResult(scan, r.Hw);
  return res ? { ...res, motion: r.motion } : null;
}

// ---------- the centre circle: ellipse fit + halfway line + a touchline ----------

/** Conic a x^2 + b xy + c y^2 + d x + e y + f = 0 as [a, b, c, d, e, f]. */
export type Conic = [number, number, number, number, number, number];

/** Eigenvector of the smallest eigenvalue of a symmetric matrix (cyclic Jacobi). */
export function smallestEigenvector(M: number[][]): number[] {
  const n = M.length, A = M.map((r) => [...r]), V: number[][] = M.map((_, i) => M.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0, diag = 0;
    for (let p = 0; p < n; p++) { diag += A[p]![p]! ** 2; for (let q = p + 1; q < n; q++) off += A[p]![q]! ** 2; }
    if (off <= 1e-24 * (diag || 1)) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = A[p]![q]!;
      if (Math.abs(apq) < 1e-300) continue;
      const th = (A[q]![q]! - A[p]![p]!) / (2 * apq);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k]![p]!, akq = A[k]![q]!; A[k]![p] = c * akp - s * akq; A[k]![q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p]![k]!, aqk = A[q]![k]!; A[p]![k] = c * apk - s * aqk; A[q]![k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k]![p]!, vkq = V[k]![q]!; V[k]![p] = c * vkp - s * vkq; V[k]![q] = s * vkp + c * vkq; }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (A[i]![i]! < A[best]![best]!) best = i;
  return V.map((r) => r[best]!);
}

/** Least-squares (algebraic, normalised) conic through >= 5 points. */
export function fitConic(pts: Pt[]): Conic | null {
  if (pts.length < 5) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sc = Math.SQRT2 / (pts.reduce((s, p) => s + Math.hypot(p.x - mx, p.y - my), 0) / pts.length || 1);
  const M = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  for (const p of pts) {
    const x = (p.x - mx) * sc, y = (p.y - my) * sc, r = [x * x, x * y, y * y, x, y, 1];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) M[i]![j] = M[i]![j]! + r[i]! * r[j]!;
  }
  const [a, b, c, d, e, f] = smallestEigenvector(M) as Conic;
  // back to pixels: x' = s (x - mx), y' = s (y - my)
  const s2 = sc * sc;
  const A = a * s2, B = b * s2, C = c * s2;
  const D = d * sc - 2 * A * mx - B * my, E = e * sc - 2 * C * my - B * mx;
  const F = A * mx * mx + B * mx * my + C * my * my - d * sc * mx - e * sc * my + f;
  const k = Math.hypot(A, B, C, D, E, F) || 1;
  return [A / k, B / k, C / k, D / k, E / k, F / k];
}

/** Sampson (first-order geometric) distance of p to the conic, px. */
export function conicDist(q: Conic, p: Pt): number {
  const [a, b, c, d, e, f] = q;
  const v = a * p.x * p.x + b * p.x * p.y + c * p.y * p.y + d * p.x + e * p.y + f;
  const gx = 2 * a * p.x + b * p.y + d, gy = b * p.x + 2 * c * p.y + e;
  return Math.abs(v) / (Math.hypot(gx, gy) || 1e-12);
}

/** Centre and semi-axes of an ellipse conic; null for a hyperbola, a parabola or an imaginary ellipse. */
export function ellipseOf(q: Conic): { c: Pt; a: number; b: number } | null {
  const [A, B, C, D, E, F] = q;
  const disc = B * B - 4 * A * C;
  if (disc >= 0) return null;
  const cx = (2 * C * D - B * E) / disc, cy = (2 * A * E - B * D) / disc;
  const f0 = A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy + F;
  const tr = A + C, root = Math.sqrt((A - C) ** 2 + B * B);
  const l1 = (tr + root) / 2, l2 = (tr - root) / 2;
  const a2 = -f0 / l1, b2 = -f0 / l2;
  if (!(a2 > 0) || !(b2 > 0)) return null;
  return { c: { x: cx, y: cy }, a: Math.sqrt(Math.max(a2, b2)), b: Math.sqrt(Math.min(a2, b2)) };
}

/** RANSAC ellipse on points (deterministic LCG sampling); inliers within tol px. */
export function ransacEllipse(pts: Pt[], o: { iters?: number; tol?: number; minInliers?: number; maxAxis?: number; seed?: number } = {}): { conic: Conic; inliers: Pt[] } | null {
  const iters = o.iters ?? 400, tol = o.tol ?? 1.5, minIn = o.minInliers ?? 40, maxAxis = o.maxAxis ?? Infinity;
  if (pts.length < Math.max(5, minIn)) return null;
  let s = o.seed ?? 12345;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  let best: { conic: Conic; inliers: Pt[] } | null = null;
  const valid = (q: Conic) => { const e = ellipseOf(q); return !!e && e.a < maxAxis && e.b > 3 && e.b / e.a > 0.08; };
  for (let it = 0; it < iters; it++) {
    const pick: Pt[] = [];
    for (let k = 0; k < 5; k++) pick.push(pts[Math.floor(rnd() * pts.length)]!);
    const q = fitConic(pick);
    if (!q || !valid(q)) continue;
    let cnt = 0;
    for (const p of pts) if (conicDist(q, p) < tol) cnt++;
    if (cnt >= minIn && (!best || cnt > best.inliers.length)) best = { conic: q, inliers: pts.filter((p) => conicDist(q, p) < tol) };
  }
  if (!best) return null;
  for (let r = 0; r < 2; r++) {
    const q = fitConic(best.inliers);
    if (!q || !valid(q)) break;
    const inl = pts.filter((p) => conicDist(q, p) < tol);
    if (inl.length < best.inliers.length) break;
    best = { conic: q, inliers: inl };
  }
  return best;
}

const conicMat = (q: Conic): number[][] => [[q[0], q[1] / 2, q[3] / 2], [q[1] / 2, q[2], q[4] / 2], [q[3] / 2, q[4] / 2, q[5]]];
const polarOf = (q: Conic, p: Vec3): Vec3 => { const M = conicMat(q); return [0, 1, 2].map((i) => M[i]![0]! * p[0] + M[i]![1]! * p[1] + M[i]![2]! * p[2]) as Vec3; };

/** Intersections of the line l = (a, b, c) (a x + b y + c = 0) with the conic (0 or 2 points). */
export function lineConic(q: Conic, l: Vec3): Pt[] {
  const n = Math.hypot(l[0], l[1]);
  if (n < 1e-12) return [];
  const nx = l[0] / n, ny = l[1] / n, rho = -l[2] / n;
  const p0 = { x: nx * rho, y: ny * rho }, dx = -ny, dy = nx;
  const [a, b, c, d, e, f] = q;
  const A = a * dx * dx + b * dx * dy + c * dy * dy;
  const B = 2 * a * p0.x * dx + b * (p0.x * dy + p0.y * dx) + 2 * c * p0.y * dy + d * dx + e * dy;
  const C = a * p0.x * p0.x + b * p0.x * p0.y + c * p0.y * p0.y + d * p0.x + e * p0.y + f;
  const disc = B * B - 4 * A * C;
  if (Math.abs(A) < 1e-15 || disc < 0) return [];
  const r = Math.sqrt(disc);
  return [(-B - r) / (2 * A), (-B + r) / (2 * A)].map((t) => ({ x: p0.x + t * dx, y: p0.y + t * dy }));
}

function solve3(M: number[][], b: number[]): number[] | null {
  const det = (m: number[][]) => m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const D = det(M);
  if (Math.abs(D) < 1e-12) return null;
  return [0, 1, 2].map((k) => det(M.map((r, i) => r.map((v, j) => (j === k ? b[i]! : v)))) / D);
}

/**
 * Point correspondences of a centre view, all from the picture: the halfway line l meets the image of the circle at the
 * images of (0, +-R) and a touchline at (0, +-34); the 1-D projectivity along l then gives the centre O; the horizon is the
 * polar of O, it meets l at the vanishing point of the goal-line direction, whose polar is the image of y = 0: it meets
 * the ellipse at (+-R, 0). Picture convention of landmarks.ts: far = up, x grows to the right.
 */
export function centreCorrespondences(q: Conic, l: Vec3, touch: { p: Pt; far: boolean }): { model: Pt; p: Pt }[] | null {
  const R = 9.15;
  const ps = lineConic(q, l);
  if (ps.length !== 2) return null;
  const [up, down] = ps[0]!.y < ps[1]!.y ? [ps[0]!, ps[1]!] : [ps[1]!, ps[0]!];
  // 1-D coordinate along l, growing upwards in the picture
  const n = Math.hypot(l[0], l[1]);
  let dx = -l[1] / n, dy = l[0] / n;
  if (dy > 0) { dx = -dx; dy = -dy; }
  const t = (p: Pt) => p.x * dx + p.y * dy;
  // projectivity y -> t from 3 points: t = (alpha y + beta) / (gamma y + 1)
  const Y = [R, -R, touch.far ? 34 : -34], T = [t(up), t(down), t(touch.p)];
  const sol = solve3(Y.map((y, i) => [y, 1, -y * T[i]!]), T);
  if (!sol) return null;
  const t0 = sol[1]!; // y = 0
  const base = { x: up.x - t(up) * dx, y: up.y - t(up) * dy };
  const O = { x: base.x + t0 * dx, y: base.y + t0 * dy };
  const hor = polarOf(q, [O.x, O.y, 1]);
  const vx = cross(hor, l);
  const yAxis = polarOf(q, vx);
  const es = lineConic(q, yAxis);
  if (es.length !== 2) return null;
  const [left, right] = es[0]!.x < es[1]!.x ? [es[0]!, es[1]!] : [es[1]!, es[0]!];
  return [
    { model: { x: 0, y: R }, p: up }, { model: { x: 0, y: -R }, p: down }, { model: { x: 0, y: 0 }, p: O },
    { model: { x: -R, y: 0 }, p: left }, { model: { x: R, y: 0 }, p: right }, { model: { x: 0, y: Y[2]! }, p: touch.p },
  ];
}

/**
 * Centre-circle calibration for midfield views, where the line search lacks straight lines: RANSAC ellipse on the paint
 * that is not on a long straight line, the halfway line (a steep long line through the ellipse), a touchline (a flat long
 * line crossing it in the picture), then centreCorrespondences, DLT and the chamfer refinement on all the model lines.
 */
export function centreCircleCalibrate(scan: LineScan): AutoCal | null {
  const long = scan.lines.filter((l) => l.runs.reduce((s, [a, b]) => s + b - a, 0) > 0.12 * scan.w);
  if (long.length < 2) return null;
  const pts: Pt[] = [];
  for (let y = 0; y < scan.h; y++) for (let x = 0; x < scan.w; x++) {
    if (!scan.mask[y * scan.w + x]) continue;
    if (long.some((l) => Math.abs(l.nx * x + l.ny * y - l.rho) < 2.5)) continue;
    pts.push({ x, y });
  }
  const stride = Math.max(1, Math.floor(pts.length / 2500));
  const sub = pts.filter((_, i) => i % stride === 0);
  const ell = ransacEllipse(sub, { minInliers: Math.max(25, Math.round(120 / stride)), maxAxis: scan.w });
  if (!ell) return null;
  const e = ellipseOf(ell.conic)!;
  const samples = scan.lines.map((l) => lineSamples(l, AUTOCAL.samplesPerLine));
  let best: AutoCal | null = null;
  for (const half of long) {
    // the halfway line: steep (not a touchline) and through the ellipse
    if (Math.abs(half.ny) > 0.7 || Math.abs(half.nx * e.c.x + half.ny * e.c.y - half.rho) > 0.5 * e.b + 2) continue;
    const lv = lineVec(half);
    for (const tl of long) {
      if (tl === half || Math.abs(tl.ny) < 0.7) continue;
      const p = intersect(half, tl, 20);
      if (!p || p.x < -2 || p.y < -2 || p.x > scan.w + 2 || p.y > scan.h + 2) continue;
      const corr = centreCorrespondences(ell.conic, lv, { p, far: p.y < e.c.y });
      if (!corr) continue;
      const H0 = computeHomography(corr.map((c) => c.model), corr.map((c) => c.p));
      if (!H0) continue;
      const Hw0 = orientH(H0, { x: 0, y: 0 });
      if (!orientationOk(Hw0, { x: 0, y: 0 })) continue;
      const r = chamferRefine(scan, Hw0, 0);
      if (r.mean > CHAMFER.accept) continue;
      const res = chamferResult(scan, r.Hw);
      if (res && (!best || res.score < best.score)) best = res;
    }
  }
  return best;
}

/** Chamfer polish of a calibration (pitch -> SOURCE px) on all the model lines; the input when it does not improve. */
export function polishCalibration(scan: LineScan, cal: AutoCal): AutoCal {
  const before = chamferCost(scan, cal.Hwork);
  const r = chamferRefine(scan, cal.Hwork, 0);
  if (!(r.mean < before.mean - 0.05)) return cal;
  const res = chamferResult(scan, r.Hw);
  return res && res.score <= cal.score + 0.3 ? res : cal;
}
