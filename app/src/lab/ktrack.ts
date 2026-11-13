// Clip-mode player tracker, pure logic (no DOM): a constant-velocity Kalman filter per track (position + velocity in pitch
// metres), Hungarian assignment with a gate and an appearance cue (the torso colour in CIELAB, as for the teams), tracks
// kept alive through short misses, re-identification of lost tracks after a pause or a cut when position and colour agree,
// and a team label by majority vote over the track's life. Also the adaptive tile planning of the clip loop.
// Unit-tested in app/test/lab-ktrack.test.ts.
import type { Pt } from "./homography.ts";
import { dist, type Box, type Lab, type TeamLabel } from "./teams.ts";

// ---------- Hungarian assignment (rectangular, minimum cost) ----------

/**
 * Minimum-cost assignment of rows to columns (Kuhn-Munkres with potentials, O(n^2 m)). Works on any n x m matrix; returns
 * the column of each row (-1 when the row is left out, which only happens when n > m).
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length, m = n ? cost[0]!.length : 0;
  if (!n || !m) return new Array<number>(n).fill(-1);
  if (n > m) {
    const t = Array.from({ length: m }, (_, j) => cost.map((r) => r[j]!));
    const colOf = hungarian(t), out = new Array<number>(n).fill(-1);
    colOf.forEach((i, j) => { if (i >= 0) out[i] = j; });
    return out;
  }
  const INF = Infinity, u = new Array<number>(n + 1).fill(0), v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0), way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF), used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) { minv[j] = cur; way[j] = j0; }
        if (minv[j]! < delta) { delta = minv[j]!; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]!] = u[p[j]!]! + delta; v[j] = v[j]! - delta; } else minv[j] = minv[j]! - delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]!; p[j0] = p[j1]!; j0 = j1; } while (j0);
  }
  const out = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) out[p[j]! - 1] = j - 1;
  return out;
}

// ---------- constant-velocity Kalman filter (state x, y, vx, vy; covariance 4 x 4 row-major) ----------

export type KState = { x: number[]; P: number[] };
/** q: acceleration noise (m/s^2, std); r: measurement noise (m, std); p0v: initial velocity std (m/s). */
export const KALMAN = { q: 3, r: 0.7, p0v: 3 } as const;

export function kInit(p: Pt, o: typeof KALMAN = KALMAN): KState {
  const r2 = o.r * o.r, v2 = o.p0v * o.p0v;
  return { x: [p.x, p.y, 0, 0], P: [r2, 0, 0, 0, 0, r2, 0, 0, 0, 0, v2, 0, 0, 0, 0, v2] };
}

const mm = (A: number[], B: number[]) => { const C = new Array<number>(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += A[4 * i + k]! * B[4 * k + j]!; C[4 * i + j] = s; } return C; };
const tr = (A: number[]) => { const C = new Array<number>(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) C[4 * j + i] = A[4 * i + j]!; return C; };

/** x <- F x, P <- F P F' + Q (white-acceleration model). */
export function kPredict(s: KState, dt: number, o: typeof KALMAN = KALMAN): KState {
  const F = [1, 0, dt, 0, 0, 1, 0, dt, 0, 0, 1, 0, 0, 0, 0, 1];
  const x = [s.x[0]! + dt * s.x[2]!, s.x[1]! + dt * s.x[3]!, s.x[2]!, s.x[3]!];
  const q = o.q * o.q, a = (dt ** 4 / 4) * q, b = (dt ** 3 / 2) * q, c = dt * dt * q;
  const Q = [a, 0, b, 0, 0, a, 0, b, b, 0, c, 0, 0, b, 0, c];
  const P = mm(mm(F, s.P), tr(F)).map((v, i) => v + Q[i]!);
  return { x, P };
}

/** Position measurement z (H = [I 0]), noise r. */
export function kUpdate(s: KState, z: Pt, o: typeof KALMAN = KALMAN): KState {
  const r2 = o.r * o.r, P = s.P;
  const S00 = P[0]! + r2, S01 = P[1]!, S10 = P[4]!, S11 = P[5]! + r2;
  const det = S00 * S11 - S01 * S10;
  const i00 = S11 / det, i01 = -S01 / det, i10 = -S10 / det, i11 = S00 / det;
  // K = P H' S^-1 (4 x 2)
  const K: number[] = [];
  for (let r = 0; r < 4; r++) { const p0 = P[4 * r]!, p1 = P[4 * r + 1]!; K.push(p0 * i00 + p1 * i10, p0 * i01 + p1 * i11); }
  const y0 = z.x - s.x[0]!, y1 = z.y - s.x[1]!;
  const x = s.x.map((v, r) => v + K[2 * r]! * y0 + K[2 * r + 1]! * y1);
  // P <- (I - K H) P
  const nP = new Array<number>(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) nP[4 * r + c] = P[4 * r + c]! - K[2 * r]! * P[c]! - K[2 * r + 1]! * P[4 + c]!;
  return { x, P: nP };
}

/** Squared Mahalanobis distance of z from the predicted position (innovation covariance P_pos + r^2 I). */
export function kMahalanobis2(s: KState, z: Pt, o: typeof KALMAN = KALMAN): number {
  const r2 = o.r * o.r, S00 = s.P[0]! + r2, S01 = s.P[1]!, S11 = s.P[5]! + r2;
  const det = S00 * S11 - S01 * S01, dx = z.x - s.x[0]!, dy = z.y - s.x[1]!;
  return (S11 * dx * dx - 2 * S01 * dx * dy + S00 * dy * dy) / det;
}

// ---------- team: majority vote over the track's life ----------

export type TeamCount = [number, number, number];
export function countTeam(c: TeamCount, l: TeamLabel): TeamCount {
  const k = l === "other" ? 2 : l;
  return c.map((x, i) => x + (i === k ? 1 : 0)) as TeamCount;
}
/** The label seen most often (ties: team A, then B, then other). */
export function majority(c: TeamCount): TeamLabel {
  const k = c[0] >= c[1] && c[0] >= c[2] ? 0 : c[1] >= c[2] ? 1 : 2;
  return k === 2 ? "other" : (k as 0 | 1);
}

// ---------- the tracker ----------

export type KTrack = {
  id: number; k: KState; hits: number; misses: number; lastT: number; count: TeamCount; team: TeamLabel; lab: Lab | null;
};
export type KDet = { p: Pt; team: TeamLabel; lab: Lab | null };
/**
 * gate: max distance (m) between a prediction and a detection, plus 2 x the predicted position std; colourW: cost (m) per
 * 10 CIELAB units of torso colour difference (capped at colourCap units); maxMissSec: a track survives that long without a
 * detection; reidSec / reidGate / reidSpeed / reidColour: a lost track (miss, pause or cut) is revived by a new detection
 * within reidGate + reidSpeed x elapsed metres and reidColour CIELAB units, up to reidSec seconds after it was last seen;
 * minHits: detections before a velocity is reported; maxSpeed: velocity cap (m/s).
 */
export const KTRACK = {
  gate: 5, colourW: 0.6, colourCap: 40, maxMissSec: 1, reidSec: 4, reidGate: 3, reidSpeed: 3, reidColour: 18, minHits: 3, maxSpeed: 9, maxDt: 1,
} as const;
export type KTracker = { tracks: KTrack[]; lost: KTrack[]; nextId: number };
export const newTracker = (): KTracker => ({ tracks: [], lost: [], nextId: 1 });

const conflict = (a: TeamLabel, b: TeamLabel) => a !== "other" && b !== "other" && a !== b;
const BIG = 1e6;

function colourCost(a: Lab | null, b: Lab | null, o: typeof KTRACK): number {
  return a && b ? (o.colourW * Math.min(o.colourCap, dist(a, b))) / 10 : 0;
}
const blendLab = (a: Lab | null, b: Lab | null): Lab | null => (!a ? b : !b ? a : [0.8 * a[0] + 0.2 * b[0], 0.8 * a[1] + 0.2 * b[1], 0.8 * a[2] + 0.2 * b[2]]);
const posOf = (t: KTrack): Pt => ({ x: t.k.x[0]!, y: t.k.x[1]! });
export const velOf = (t: KTrack, o: typeof KTRACK = KTRACK): Pt | null => {
  if (t.hits < o.minHits) return null;
  const v = { x: t.k.x[2]!, y: t.k.x[3]! }, s = Math.hypot(v.x, v.y);
  return s > o.maxSpeed ? { x: (v.x * o.maxSpeed) / s, y: (v.y * o.maxSpeed) / s } : v;
};
export { posOf as trackPos };

/** Sends every active track to the lost pool (a cut or a pause: positions stay comparable, the motion does not). */
export function suspend(tr: KTracker): KTracker {
  return { tracks: [], lost: [...tr.lost, ...tr.tracks.filter((t) => t.hits >= 2)], nextId: tr.nextId };
}

function absorb(t: KTrack, d: KDet, now: number, k: KState): KTrack {
  const count = countTeam(t.count, d.team);
  return { ...t, k: kUpdate(k, d.p), hits: t.hits + 1, misses: 0, lastT: now, count, team: majority(count), lab: blendLab(t.lab, d.lab) };
}

/**
 * One step at time `now` (s): predict, Hungarian on gated costs (distance + colour; clear team conflicts forbidden), update,
 * re-identify lost tracks for the unmatched detections, start new tracks. Returns the tracker and the track of each detection.
 */
export function kStep(tr: KTracker, dets: KDet[], now: number, o: typeof KTRACK = KTRACK): { tracker: KTracker; byDet: KTrack[] } {
  // predicted from the time of the last update (a missed track keeps its last updated state, so this covers the gap)
  const pred = tr.tracks.map((t) => ({ t, k: kPredict(t.k, Math.max(0.01, now - t.lastT)) }));
  const cost = pred.map(({ t, k }) => dets.map((d) => {
    if (conflict(t.team, d.team)) return BIG;
    const dd = Math.hypot(d.p.x - k.x[0]!, d.p.y - k.x[1]!);
    const g = o.gate + 2 * Math.sqrt(Math.max(k.P[0]!, k.P[5]!));
    return dd > g ? BIG : dd + colourCost(t.lab, d.lab, o);
  }));
  const match = pred.length && dets.length ? hungarian(cost) : pred.map(() => -1);
  const byDet: KTrack[] = new Array(dets.length);
  const tracks: KTrack[] = [], lost = tr.lost.filter((t) => now - t.lastT <= o.reidSec);
  pred.forEach(({ t, k }, i) => {
    const j = match[i]!;
    if (j >= 0 && cost[i]![j]! < BIG) { const nt = absorb(t, dets[j]!, now, k); tracks.push(nt); byDet[j] = nt; return; }
    // missed: keep the predicted state but do not advance lastT (the next prediction covers the whole gap)
    if (now - t.lastT <= o.maxMissSec) tracks.push({ ...t, misses: t.misses + 1 });
    else if (t.hits >= 2) lost.push(t);
  });
  // re-identification: unmatched detections vs lost tracks (position from the last update, colour, team)
  const free = dets.map((_, j) => j).filter((j) => !byDet[j]);
  if (free.length && lost.length) {
    const rc = lost.map((t) => free.map((j) => {
      const d = dets[j]!, gap = now - t.lastT;
      if (conflict(t.team, d.team)) return BIG;
      if (t.lab && d.lab && dist(t.lab, d.lab) > o.reidColour) return BIG;
      const p = posOf(t), dd = Math.hypot(d.p.x - p.x, d.p.y - p.y);
      return dd > o.reidGate + o.reidSpeed * gap ? BIG : dd + colourCost(t.lab, d.lab, o);
    }));
    const rm = hungarian(rc), revived = new Set<number>();
    rm.forEach((c, i) => {
      if (c < 0 || rc[i]![c]! >= BIG) return;
      const t = lost[i]!, j = free[c]!;
      // the motion is stale after a gap: the filter restarts at the new detection, the identity, votes and colour carry on
      const d = dets[j]!, count = countTeam(t.count, d.team);
      const nt: KTrack = { ...t, k: kInit(d.p), hits: t.hits + 1, misses: 0, lastT: now, count, team: majority(count), lab: blendLab(t.lab, d.lab) };
      tracks.push(nt); byDet[j] = nt; revived.add(i);
    });
    for (let i = lost.length - 1; i >= 0; i--) if (revived.has(i)) lost.splice(i, 1);
  }
  let nextId = tr.nextId;
  dets.forEach((d, j) => {
    if (byDet[j]) return;
    const count = countTeam([0, 0, 0], d.team);
    const nt: KTrack = { id: nextId++, k: kInit(d.p), hits: 1, misses: 0, lastT: now, count, team: d.team, lab: d.lab };
    tracks.push(nt); byDet[j] = nt;
  });
  return { tracker: { tracks, lost, nextId }, byDet };
}

// ---------- adaptive tiling ----------

/**
 * Tiles of the full plan worth running on a cheap frame: for each point (predicted player, image px) not covered by a
 * detection of the full-frame pass, the plan tile that holds it farthest from its edges (points more than margin px
 * outside every tile are dropped). Deduplicated.
 */
export function focusTiles(plan: Box[], pts: Pt[], margin = 24): Box[] {
  const chosen = new Set<number>();
  for (const p of pts) {
    // (a point near the picture edge takes the tile that holds it best, even closer than margin to its edge)
    let best = -1, bestD = -margin;
    plan.forEach((t, i) => {
      const d = Math.min(p.x - t.x, t.x + t.w - p.x, p.y - t.y, t.y + t.h - p.y);
      if (d > bestD) { bestD = d; best = i; }
    });
    if (best >= 0) chosen.add(best);
  }
  return [...chosen].sort((a, b) => a - b).map((i) => plan[i]!);
}

/** The points that no box covers (feet point within `radius` px of a box's bottom centre, or inside the box). */
export function uncovered(pts: Pt[], boxes: Box[], radius = 20): Pt[] {
  return pts.filter((p) => !boxes.some((b) => (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h + radius) || Math.hypot(p.x - (b.x + b.w / 2), p.y - (b.y + b.h)) < radius));
}

/** Full tiled scan when `since` frames have passed since the last one (or forced: a cut, no tracks); focus pass otherwise. */
export function fullScanDue(since: number, every: number, forced: boolean): boolean {
  return forced || every <= 1 || since >= every;
}
