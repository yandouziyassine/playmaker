// Live camera mode, pure logic (no DOM): detection throttle, fixed team colour centroids, player tracking with
// smoothed positions and velocities, and a cheap "camera moved" check. Unit-tested in app/test/lab-live.test.ts.
import type { Pt } from "./homography.ts";
import { dist, rgbToLab, splitTeams, type ImageLike, type Lab, type RGB, type TeamLabel } from "./teams.ts";

// ---------- throttle: adapt the detection interval to the measured processing time ----------

export type Throttle = { avgMs: number | null; interval: number };
/** duty 0.5: the detector may use about half of the time, the rest stays free for drawing and taps. 100 ms = 10 fps max. */
export const THROTTLE = { minInterval: 100, maxInterval: 1000, duty: 0.5, ema: 0.3 } as const;
export const START_THROTTLE: Throttle = { avgMs: null, interval: 150 };

/** Updates the moving average of the processing time and derives the interval between two detection starts. */
export function nextThrottle(t: Throttle, spentMs: number, o: typeof THROTTLE = THROTTLE): Throttle {
  const avgMs = t.avgMs === null ? spentMs : t.avgMs + o.ema * (spentMs - t.avgMs);
  return { avgMs, interval: Math.min(o.maxInterval, Math.max(o.minInterval, avgMs / o.duty)) };
}

/** Wait before the next detection, given the time already spent since the last one started. */
export function delayUntilNext(interval: number, spentMs: number): number {
  return Math.max(0, interval - spentMs);
}

/** Exponential moving average of the period between detection starts, as frames per second. */
export function nextFps(fps: number | null, periodMs: number, ema = 0.2): number | null {
  if (!(periodMs > 0)) return fps;
  const now = 1000 / periodMs;
  return fps === null ? now : fps + ema * (now - fps);
}

// ---------- teams: centroids fixed after calibration, so labels do not flip between frames ----------

/** Two team centroids (CIELAB) and an optional third one for the "other" kit (referee), plus the reject distance. */
export type Centroids = { centres: Lab[]; rgb: RGB[]; cut: number; separation: number };

const meanRgb = (cs: RGB[]): RGB => cs.reduce<RGB>((a, c) => [a[0] + c[0] / cs.length, a[1] + c[1] / cs.length, a[2] + c[2] / cs.length], [0, 0, 0]);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Fixes the centroids from one frame's torso colours (k-means split of teams.ts). Needs at least 6 colours and
 * 2 players in each team (else the caller keeps splitting frame by frame and tries again on the next one). centres[2], when present, is the mean "other" colour (referee, keeper).
 */
export function fixCentroids(colours: RGB[]): Centroids | null {
  if (colours.length < 6) return null;
  const split = splitTeams(colours);
  const labs = colours.map(rgbToLab);
  const members = [0, 1].map((t) => colours.filter((_, i) => split.labels[i] === t));
  if (members.some((m) => m.length < 2) || split.centres.length < 2) return null;
  const centres: Lab[] = [split.centres[0]!, split.centres[1]!];
  const d = labs.flatMap((p, i) => { const l = split.labels[i]; return l === "other" ? [] : [dist(p, centres[l!]!)]; });
  const cut = Math.max(2.5 * median(d), 18);
  const rgb: RGB[] = [meanRgb(members[0]!), meanRgb(members[1]!)];
  const others = colours.filter((_, i) => split.labels[i] === "other");
  if (others.length) { rgb.push(meanRgb(others)); centres.push(rgbToLab(rgb[2]!)); }
  return { centres, rgb, cut, separation: split.separation };
}

/** Nearest stored centroid; "other" when it is the third centroid or farther than the cut from both teams. */
export function assignTeam(c: RGB, cents: Centroids): TeamLabel {
  const p = rgbToLab(c);
  let best = 0;
  cents.centres.forEach((q, i) => { if (dist(p, q) < dist(p, cents.centres[best]!)) best = i; });
  if (best >= 2 || dist(p, cents.centres[best]!) > cents.cut) return "other";
  return best as 0 | 1;
}

/** Decaying vote per label [A, B, other]: a track keeps its team unless the evidence changes for several frames. */
export type Votes = [number, number, number];
export function vote(v: Votes, l: TeamLabel, decay = 0.8): Votes {
  const k = l === "other" ? 2 : l;
  return v.map((x, i) => x * decay + (i === k ? 1 : 0)) as Votes;
}
export function voted(v: Votes): TeamLabel {
  const k = v[0] >= v[1] && v[0] >= v[2] ? 0 : v[1] >= v[2] ? 1 : 2;
  return k === 2 ? "other" : (k as 0 | 1);
}

// ---------- tracking: nearest-neighbour association + alpha-beta smoothing (positions and velocities) ----------

export type Track = { id: number; p: Pt; v: Pt; hits: number; misses: number; votes: Votes; team: TeamLabel };
export type LiveDet = { p: Pt; team: TeamLabel };

/**
 * maxDist: association gate in metres (plus 0.5 s of the track's speed); alpha: position smoothing (1 = raw);
 * beta: velocity gain; a track survives maxMisses frames without a detection; speeds are capped at maxSpeed m/s and
 * only reported after minHits detections.
 */
export const TRACK = { maxDist: 4, alpha: 0.5, beta: 0.25, maxMisses: 3, maxSpeed: 9, minHits: 3, maxDt: 1 } as const;

/** Exponential smoothing of a position. */
export function smooth(prev: Pt, meas: Pt, alpha: number): Pt {
  return { x: prev.x + alpha * (meas.x - prev.x), y: prev.y + alpha * (meas.y - prev.y) };
}

/** Velocity between two positions dt seconds apart (m/s); zero for a non-positive dt. */
export function velocityFrom(a: Pt, b: Pt, dt: number): Pt {
  return dt > 0 ? { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt } : { x: 0, y: 0 };
}

export function capSpeed(v: Pt, max: number): Pt {
  const s = Math.hypot(v.x, v.y);
  return s > max ? { x: (v.x * max) / s, y: (v.y * max) / s } : v;
}

const conflict = (a: TeamLabel, b: TeamLabel) => a !== "other" && b !== "other" && a !== b;

/**
 * Greedy global nearest-neighbour: all (track, detection) pairs closer than their gate, shortest first, each used
 * once; a pair whose team labels clearly differ is never matched. Returns det index per track (-1 = unmatched).
 */
export function associate(pred: Pt[], gates: number[], teams: TeamLabel[], dets: LiveDet[]): number[] {
  const pairs: { t: number; d: number; dist: number }[] = [];
  pred.forEach((p, t) => dets.forEach((q, d) => {
    const dd = Math.hypot(p.x - q.p.x, p.y - q.p.y);
    if (dd <= gates[t]! && !conflict(teams[t]!, q.team)) pairs.push({ t, d, dist: dd });
  }));
  pairs.sort((a, b) => a.dist - b.dist);
  const out = pred.map(() => -1), used = new Set<number>();
  for (const { t, d } of pairs) {
    if (out[t] !== -1 || used.has(d)) continue;
    out[t] = d; used.add(d);
  }
  return out;
}

/**
 * One tracking step, dt seconds after the previous one. Returns the surviving tracks and, for each detection,
 * the track it now belongs to (new tracks get ids from nextId).
 */
export function stepTracks(tracks: Track[], dets: LiveDet[], dtRaw: number, nextId: number, o: typeof TRACK = TRACK):
  { tracks: Track[]; byDet: Track[]; nextId: number } {
  const dt = Math.max(0.01, Math.min(o.maxDt, dtRaw));
  const pred = tracks.map((t) => ({ x: t.p.x + t.v.x * dt, y: t.p.y + t.v.y * dt }));
  const gates = tracks.map((t) => o.maxDist + 0.5 * Math.hypot(t.v.x, t.v.y));
  const match = associate(pred, gates, tracks.map((t) => t.team), dets);
  const byDet: Track[] = new Array(dets.length);
  const out: Track[] = [];
  tracks.forEach((t, i) => {
    const d = match[i]!;
    if (d < 0) {
      if (t.misses + 1 <= o.maxMisses) out.push({ ...t, p: pred[i]!, misses: t.misses + 1 });
      return;
    }
    const z = dets[d]!.p, pr = pred[i]!;
    const p = smooth(pr, z, o.alpha);
    // alpha-beta: the velocity follows the prediction error; from the 2nd hit, start from the raw displacement
    const v = t.hits === 1 ? velocityFrom(t.p, z, dt) : { x: t.v.x + (o.beta * (z.x - pr.x)) / dt, y: t.v.y + (o.beta * (z.y - pr.y)) / dt };
    const votes = vote(t.votes, dets[d]!.team);
    const nt: Track = { id: t.id, p, v: capSpeed(v, o.maxSpeed), hits: t.hits + 1, misses: 0, votes, team: voted(votes) };
    out.push(nt); byDet[d] = nt;
  });
  dets.forEach((q, d) => {
    if (byDet[d]) return;
    const votes = vote([0, 0, 0], q.team);
    const nt: Track = { id: nextId++, p: q.p, v: { x: 0, y: 0 }, hits: 1, misses: 0, votes, team: q.team };
    out.push(nt); byDet[d] = nt;
  });
  return { tracks: out, byDet, nextId };
}

/** Velocity worth showing / giving to the coach: only for tracks seen often enough. */
export function trackVelocity(t: Track, o: typeof TRACK = TRACK): Pt | null {
  return t.hits >= o.minHits ? t.v : null;
}

// ---------- calibration upkeep: smoothed reference points and a residual-based "camera moved" check ----------

/**
 * Exponential smoothing of the 4 calibration points (image px): the homography is rebuilt from them, so smoothing the
 * points keeps it a valid, slowly moving homography (smoothing the matrix entries would not).
 */
export function blendPoints(prev: (Pt | null)[], next: (Pt | null)[], alpha: number): (Pt | null)[] {
  return prev.map((p, i) => {
    const q = next[i] ?? null;
    if (!p) return q;
    if (!q) return p;
    return smooth(p, q, alpha);
  });
}

/**
 * Residual watch: the reprojection residual (mean distance of the reprojected lines to the painted lines, working px)
 * is checked every couple of seconds; its calm value is tracked by a slow moving average, and a jump above
 * max(ratio x reference, reference + jumpPx) for `need` consecutive checks means the camera (phone or broadcast) moved.
 */
export type CalWatch = { ref: number | null; streak: number; moved: boolean; last: number | null };
export const CAL_WATCH = { periodMs: 2000, alpha: 0.3, ema: 0.2, ratio: 2.5, jumpPx: 2.5, need: 2, retryMs: 6000 } as const;
export const START_WATCH: CalWatch = { ref: null, streak: 0, moved: false, last: null };

export function watchResidual(w: CalWatch, residual: number | null, o: typeof CAL_WATCH = CAL_WATCH): CalWatch {
  if (residual === null) return { ...w, last: null }; // nothing to check on this frame (few lines visible): no change
  if (w.ref === null) return { ref: residual, streak: 0, moved: false, last: residual };
  const jumped = residual > Math.max(o.ratio * w.ref, w.ref + o.jumpPx);
  const streak = jumped ? w.streak + 1 : 0;
  // the reference only follows calm frames, so a slow drift is not learnt as the new normal while it is being checked
  const ref = jumped ? w.ref : w.ref + o.ema * (residual - w.ref);
  return { ref, streak, moved: streak >= o.need, last: residual };
}
