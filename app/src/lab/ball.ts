// Ball: "sports ball" detections (COCO class of EfficientDet-Lite0), filtering, a one-target tracker for the live camera,
// and the automatic ball carrier / attacking direction heuristics. Pure functions, no DOM: unit-tested in app/test/lab-ball.test.ts.
import { applyH, wOf, type Mat3, type Pt } from "./homography.ts";
import { onPitch } from "./landmarks.ts";
import type { Person, RawDetection } from "./players.ts";
import type { Box, TeamLabel } from "./teams.ts";

export type Ball = { box: Box; score: number };

/** The ball is tiny and blurred: a much lower score than for people (which stay at MIN_SCORE = 0.3). */
export const BALL_MIN_SCORE = 0.18;
export const BALL_CLASS = "sports ball";

/** Keeps "sports ball" detections with score >= minScore. */
export function keepBalls(dets: RawDetection[], minScore = BALL_MIN_SCORE): Ball[] {
  const out: Ball[] = [];
  for (const d of dets) {
    const c = d.categories.find((c) => c.categoryName === BALL_CLASS);
    if (!c || c.score < minScore || !d.boundingBox) continue;
    const b = d.boundingBox;
    out.push({ box: { x: b.originX, y: b.originY, w: b.width, h: b.height }, score: c.score });
  }
  return out;
}

/** Ground point of the ball: bottom-centre of its box (wrong when the ball is in the air: the map shows it as approximate). */
export function ballGround(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h };
}

export const BALL_FILTER = { maxAspect: 2, maxSideFrac: 0.08, headFrac: 0.22, margin: 2 } as const;

/** Why a candidate box is rejected (null = kept). Exported for the tests. */
export function rejectBall(b: Ball, persons: Person[], i2p: Mat3 | null, imgW: number, o: typeof BALL_FILTER = BALL_FILTER): string | null {
  const { w, h } = b.box;
  if (w <= 0 || h <= 0) return "empty";
  if (Math.max(w / h, h / w) > o.maxAspect) return "not round";
  if (Math.max(w, h) > o.maxSideFrac * imgW) return "too big";
  // a head is the most common false ball: centre in the top part of a person box
  const cx = b.box.x + w / 2, cy = b.box.y + h / 2;
  if (persons.some((p) => cx >= p.box.x && cx <= p.box.x + p.box.w && cy >= p.box.y && cy <= p.box.y + o.headFrac * p.box.h)) return "head";
  if (i2p) {
    // calibrated: the ground point must land on the pitch (a ball above the reprojected pitch is in the crowd)
    const g = ballGround(b.box);
    if (wOf(i2p, g) <= 0) return "crowd";
    const q = applyH(i2p, g);
    if (!q || !onPitch(q, o.margin)) return "crowd";
  }
  return null;
}

/** Best-scoring plausible ball, or null. */
export function pickBall(balls: Ball[], persons: Person[], i2p: Mat3 | null, imgW: number): Ball | null {
  let best: Ball | null = null;
  for (const b of balls) if (!rejectBall(b, persons, i2p, imgW) && (!best || b.score > best.score)) best = b;
  return best;
}

// ---------- live: one-target alpha-beta tracker in image pixels (centre + radius) ----------

export type BallTrack = { c: Pt; v: Pt; r: number; score: number; hits: number; misses: number };
/**
 * gateFrac: association gate as a fraction of the image width (plus 0.5 s of the track's speed); alpha/beta: position and
 * velocity gains (more responsive than for players, the ball changes speed abruptly); the track survives maxMisses frames.
 */
export const BALL_TRACK = { gateFrac: 0.1, alpha: 0.6, beta: 0.3, maxMisses: 4, maxDt: 1 } as const;

export function stepBall(t: BallTrack | null, meas: Ball | null, dtRaw: number, imgW: number, o: typeof BALL_TRACK = BALL_TRACK): BallTrack | null {
  const dt = Math.max(0.01, Math.min(o.maxDt, dtRaw));
  const z = meas ? { c: { x: meas.box.x + meas.box.w / 2, y: meas.box.y + meas.box.h / 2 }, r: (meas.box.w + meas.box.h) / 4 } : null;
  const fresh = (): BallTrack | null => (z ? { c: z.c, v: { x: 0, y: 0 }, r: z.r, score: meas!.score, hits: 1, misses: 0 } : null);
  if (!t) return fresh();
  const pred = { x: t.c.x + t.v.x * dt, y: t.c.y + t.v.y * dt };
  const gate = o.gateFrac * imgW + 0.5 * Math.hypot(t.v.x, t.v.y);
  if (!z || Math.hypot(z.c.x - pred.x, z.c.y - pred.y) > gate) {
    // a far detection replaces a track that is already losing the ball; otherwise coast on the prediction
    if (z && t.misses >= 1) return fresh();
    return t.misses + 1 > o.maxMisses ? null : { ...t, c: pred, misses: t.misses + 1 };
  }
  const c = { x: pred.x + o.alpha * (z.c.x - pred.x), y: pred.y + o.alpha * (z.c.y - pred.y) };
  const v = t.hits === 1
    ? { x: (z.c.x - t.c.x) / dt, y: (z.c.y - t.c.y) / dt }
    : { x: t.v.x + (o.beta * (z.c.x - pred.x)) / dt, y: t.v.y + (o.beta * (z.c.y - pred.y)) / dt };
  return { c, v, r: t.r + 0.5 * (z.r - t.r), score: meas!.score, hits: t.hits + 1, misses: 0 };
}

export function trackBox(t: BallTrack): Box {
  return { x: t.c.x - t.r, y: t.c.y - t.r, w: 2 * t.r, h: 2 * t.r };
}

// ---------- automatic carrier and attacking direction ----------

export const CARRIER_MAX_DIST = 3; // metres

/** Nearest mapped player of team A or B within maxDist metres of the ball (pitch coordinates), or null. */
export function pickCarrier(ball: Pt, pos: (Pt | null)[], labels: TeamLabel[], maxDist = CARRIER_MAX_DIST): { index: number; dist: number } | null {
  let best: { index: number; dist: number } | null = null;
  pos.forEach((p, i) => {
    const l = labels[i];
    if (!p || l === undefined || l === "other") return;
    const d = Math.hypot(p.x - ball.x, p.y - ball.y);
    if (d <= maxDist && (!best || d < best.dist)) best = { index: i, dist: d };
  });
  return best;
}

/**
 * Heuristic attacking direction of `team` (+1 = towards the right goal, +x). Which way a team faces is unknown from one
 * picture, so: its own goal is on the side where its deepest player is. "Deepest" is measured against the other team
 * (how much farther our last player is than theirs on that side), because a TV picture often shows one half only and
 * then both teams' deepest players are on the same side; with no opponent on the map, the plain deepest player decides.
 * The team attacks the other way. Returns null when the team has nobody on the map.
 */
export function attackDirection(pos: (Pt | null)[], labels: TeamLabel[], team: 0 | 1): { dir: 1 | -1; ownSide: 1 | -1 } | null {
  const xs = (t: 0 | 1) => pos.flatMap((p, i) => (p && labels[i] === t ? [p.x] : []));
  const mine = xs(team), theirs = xs(team === 0 ? 1 : 0);
  if (!mine.length) return null;
  const depth = (v: number[], s: 1 | -1) => Math.max(...v.map((x) => s * x));
  let ownSide: 1 | -1;
  if (!theirs.length) ownSide = depth(mine, 1) >= depth(mine, -1) ? 1 : -1;
  else {
    const margin = (s: 1 | -1) => depth(mine, s) - depth(theirs, s);
    ownSide = margin(1) >= margin(-1) ? 1 : -1;
  }
  return { dir: ownSide === 1 ? -1 : 1, ownSide };
}
