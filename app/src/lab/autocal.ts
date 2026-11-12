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
