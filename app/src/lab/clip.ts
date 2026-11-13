// Video clip mode, pure logic (no DOM): the frame schedule, the camera-cut check, the tactical numbers per team
// (width, depth, defensive line height, distance between lines, possession share), heatmap bins and the honest
// diagnostics. The browser loop that fills ClipFrame records is cliprun.ts. Unit-tested in app/test/lab-clip.test.ts.
import type { Pt } from "./homography.ts";
import { PITCH } from "./landmarks.ts";
import type { FitRating } from "./lines.ts";
import { isGrass, type Box, type ImageLike, type TeamLabel } from "./teams.ts";

/**
 * fps: analysis rate; maxSec: longest clip analysed; maxW x maxH: processing size (720p); seekOffset: seek a little after
 * each frame boundary so a seek never lands on the previous frame; refineEvery: seeded line refinement every N frames (1: a
 * broadcast camera pans all the time); maxGap: tracks survive a pause in tracking (poor calibration) up to this many seconds;
 * cutDist: colour-histogram jump (0..1) between two analysed frames that means a cut; minGrass: below this share of grass
 * the frame is not a pitch view (close-up, crowd, replay graphics) and is skipped; possessionM: the ball "belongs" to the
 * nearest player within this distance; minPlayers: outfield players needed for a team's shape on a frame; fullScanEvery:
 * adaptive tiling of the tiled mode, the full tiled scan every N frames and only the tiles around predicted players in between.
 */
export const CLIP = {
  fps: 5, maxSec: 60, maxW: 1280, maxH: 720, seekOffset: 0.01, refineEvery: 1, maxGap: 1, cutDist: 0.3, minGrass: 0.2,
  possessionM: 2, minPlayers: 4, keeperGap: 10, keeperZone: 25, defenders: 4, forwards: 2, minLines: 7, minTrackFrames: 3,
  fullScanEvery: 1,
} as const;
export type ClipOpts = typeof CLIP;

// ---------- frame schedule ----------

/** Times (s) of the analysed frames: every 1/fps from the start, over the first maxSec seconds of the clip. */
export function frameTimes(duration: number, fps: number = CLIP.fps, maxSec: number = CLIP.maxSec, offset: number = CLIP.seekOffset): number[] {
  if (!(duration > 0) || !(fps > 0)) return [];
  const end = Math.min(duration, maxSec), out: number[] = [];
  for (let i = 0; ; i++) {
    const t = i / fps + offset;
    if (t >= end) break;
    out.push(+t.toFixed(4));
  }
  return out;
}

/** Processing size: the frame scaled down (never up) to fit maxW x maxH, aspect kept. */
export function processingSize(w: number, h: number, maxW: number = CLIP.maxW, maxH: number = CLIP.maxH): { w: number; h: number; k: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0, k: 0 };
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k };
}

/** Index of the analysed frame shown at video time t (the last one at or before t, else the first). */
export function frameAt(times: number[], t: number): number {
  let lo = 0, hi = times.length - 1, best = 0;
  if (hi < 0) return -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (times[m]! <= t + 1e-6) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best;
}

// ---------- camera cuts ----------

/** Colour signature of a frame: a normalised bins^3 RGB histogram and the share of grass pixels (sampled every `step` px). */
export type Signature = { hist: number[]; grass: number };

export function signature(img: ImageLike, step = 4, bins = 4): Signature {
  const hist = new Array<number>(bins ** 3).fill(0);
  let n = 0, g = 0;
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
    const k = 4 * (y * img.width + x);
    const r = img.data[k]!, gr = img.data[k + 1]!, b = img.data[k + 2]!;
    hist[Math.floor((r * bins) / 256) * bins * bins + Math.floor((gr * bins) / 256) * bins + Math.floor((b * bins) / 256)]!++;
    if (isGrass(r, gr, b)) g++;
    n++;
  }
  return { hist: hist.map((v) => (n ? v / n : 0)), grass: n ? g / n : 0 };
}

/** Half the L1 distance between two normalised histograms: 0 = identical, 1 = nothing in common. */
export function histDistance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) s += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return s / 2;
}

export type FrameKind = "same" | "cut" | "noPitch";
/**
 * noPitch: too little grass to be a match view (skipped); cut: the colour content jumped since the previous analysed frame
 * (a different camera / view: tracks restart and the calibration is searched again); same: a continuous shot (panning
 * and zooming keep the histogram close: mostly grass).
 */
export function classifyFrame(prev: Signature | null, cur: Signature, o: Pick<ClipOpts, "cutDist" | "minGrass"> = CLIP): FrameKind {
  if (cur.grass < o.minGrass) return "noPitch";
  if (prev && histDistance(prev.hist, cur.hist) > o.cutDist) return "cut";
  return "same";
}

// ---------- clip records ----------

export type ClipPlayer = { id: number; team: TeamLabel; p: Pt; v: Pt | null; box: Box | null };
/** ok: calibrated and tracked; poorCal: no usable calibration (tracking paused); noPitch: not a pitch view (skipped). */
export type ClipStatus = "ok" | "poorCal" | "noPitch";
export type ClipFrame = {
  t: number; status: ClipStatus; cut: boolean; rating: FitRating | null; fit: number | null;
  players: ClipPlayer[]; ball: Pt | null; ballBox: Box | null; ballScore: number; cal: { ids: string[]; pts: Pt[] } | null; ms: number;
};

// ---------- tactical numbers ----------

/** The goal a team defends: -1 = the left goal (x = -52.5), 1 = the right one. */
export type Side = 1 | -1;

/** Distance from the team's own goal line (m). */
export const fromOwnGoal = (p: Pt, own: Side) => (own === -1 ? p.x + PITCH.halfL : PITCH.halfL - p.x);

/**
 * Outfield players: drops a lone deepest player (a keeper whose kit was taken for the team's): at least keeperGap metres
 * behind the next one and within keeperZone metres of his goal.
 */
export function outfield(ps: Pt[], own: Side, o: Pick<ClipOpts, "keeperGap" | "keeperZone"> = CLIP): Pt[] {
  if (ps.length < 2) return ps;
  const s = [...ps].sort((a, b) => fromOwnGoal(a, own) - fromOwnGoal(b, own));
  const d0 = fromOwnGoal(s[0]!, own), d1 = fromOwnGoal(s[1]!, own);
  return d1 - d0 >= o.keeperGap && d0 <= o.keeperZone ? s.slice(1) : s;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * One team's shape on one frame (visible outfield players only, metres): width = across the pitch (y extent of the convex
 * hull), depth = along it (x extent); lineHeight = mean distance of the deepest defenders (up to 4, at most half the
 * players) from their own goal; gapDM / gapMA = distance between the defence (4 deepest) and the midfield, and between the
 * midfield and the attack (2 most advanced), only with at least minLines players. Null with fewer than minPlayers.
 */
export type Shape = { n: number; width: number; depth: number; lineHeight: number; gapDM: number | null; gapMA: number | null };
export function teamShape(ps: Pt[], own: Side, o: ClipOpts = CLIP): Shape | null {
  const f = outfield(ps, own, o);
  if (f.length < o.minPlayers) return null;
  const d = f.map((p) => fromOwnGoal(p, own)).sort((a, b) => a - b), ys = f.map((p) => p.y);
  const nDef = Math.min(o.defenders, Math.floor(f.length / 2));
  const shape: Shape = { n: f.length, width: Math.max(...ys) - Math.min(...ys), depth: d[d.length - 1]! - d[0]!, lineHeight: mean(d.slice(0, nDef)), gapDM: null, gapMA: null };
  if (f.length >= o.minLines) {
    const def = d.slice(0, o.defenders), att = d.slice(d.length - o.forwards), mid = d.slice(o.defenders, d.length - o.forwards);
    shape.gapDM = mean(mid) - mean(def); shape.gapMA = mean(att) - mean(mid);
  }
  return shape;
}

/** Team whose player is nearest the ball within maxDist (m); null when nobody is close enough ("other" never owns it). */
export function possessionOf(ball: Pt | null, players: { p: Pt; team: TeamLabel }[], maxDist: number = CLIP.possessionM): 0 | 1 | null {
  if (!ball) return null;
  let best: 0 | 1 | null = null, bd = maxDist;
  for (const q of players) {
    if (q.team === "other") continue;
    const d = Math.hypot(q.p.x - ball.x, q.p.y - ball.y);
    if (d <= bd) { bd = d; best = q.team; }
  }
  return best;
}

/**
 * Which goal each team defends, guessed from the clip: on average a team stands nearer its own goal than the other team
 * does. Returns the sides of teams A and B and the share of frames that agree with the guess (1 = every frame).
 */
export function guessSides(frames: ClipFrame[]): { sides: [Side, Side]; agree: number; n: number } {
  let votes = 0, n = 0;
  for (const f of frames) {
    if (f.status !== "ok") continue;
    const xs = [0, 1].map((t) => f.players.filter((q) => q.team === t).map((q) => q.p.x));
    if (xs.some((x) => x.length < 3)) continue;
    votes += Math.sign(mean(xs[0]!) - mean(xs[1]!)); n++;
  }
  const a: Side = votes > 0 ? 1 : -1; // A stands to the right of B: A defends the right goal
  return { sides: [a, (-a) as Side], agree: n ? (n + Math.abs(votes)) / (2 * n) : 0, n };
}

export type Avg = { mean: number | null; n: number };
const avg = (xs: (number | null)[]): Avg => { const v = xs.filter((x): x is number => x !== null); return { mean: v.length ? mean(v) : null, n: v.length }; };
export type TeamNumbers = { width: Avg; depth: Avg; lineHeight: Avg; gapDM: Avg; gapMA: Avg };

/** Clip averages per team, over the tracked (ok) frames where the team's shape could be measured. */
export function teamNumbers(frames: ClipFrame[], sides: [Side, Side], o: ClipOpts = CLIP): [TeamNumbers, TeamNumbers] {
  return ([0, 1] as const).map((t) => {
    const shapes = frames.filter((f) => f.status === "ok").map((f) => teamShape(f.players.filter((q) => q.team === t).map((q) => q.p), sides[t], o)).filter((s): s is Shape => !!s);
    return { width: avg(shapes.map((s) => s.width)), depth: avg(shapes.map((s) => s.depth)), lineHeight: avg(shapes.map((s) => s.lineHeight)), gapDM: avg(shapes.map((s) => s.gapDM)), gapMA: avg(shapes.map((s) => s.gapMA)) };
  }) as [TeamNumbers, TeamNumbers];
}

/** Possession share over the frames where the ball is within possessionM of a team player; `open` = ball seen, nobody close. */
export function possessionShare(frames: ClipFrame[], o: ClipOpts = CLIP): { a: number | null; b: number | null; n: number; open: number } {
  const c = [0, 0];
  let open = 0;
  for (const f of frames) {
    if (f.status !== "ok" || !f.ball) continue;
    const who = possessionOf(f.ball, f.players, o.possessionM);
    if (who === null) open++; else c[who]!++;
  }
  const n = c[0]! + c[1]!;
  return { a: n ? c[0]! / n : null, b: n ? c[1]! / n : null, n, open };
}

// ---------- heatmap ----------

/**
 * Counts of positions per cell of a cols x rows grid over the pitch (index row * cols + col; row 0 = the near touchline,
 * col 0 = the left goal). Points a little off the pitch go to the edge cell.
 */
export function heatBins(points: Pt[], cols: number, rows: number): number[] {
  const out = new Array<number>(cols * rows).fill(0);
  for (const p of points) {
    const c = Math.min(cols - 1, Math.max(0, Math.floor(((p.x + PITCH.halfL) / PITCH.length) * cols)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor(((p.y + PITCH.halfW) / PITCH.width) * rows)));
    out[r * cols + c]!++;
  }
  return out;
}

/** The tracked positions of one team over the clip (players seen on that frame, not predicted ones). */
export function teamPoints(frames: ClipFrame[], team: 0 | 1): Pt[] {
  return frames.flatMap((f) => (f.status === "ok" ? f.players.filter((q) => q.team === team && q.box).map((q) => q.p) : []));
}

// ---------- diagnostics ----------

export type Diagnostics = {
  frames: number; goodCal: number; poorCal: number; noPitch: number; cuts: number;
  tracks: number; avgTrackSec: number | null; msPerFrame: number | null;
};

/**
 * goodCal: share of analysed frames with a usable calibration (rating good or check); tracks: identities seen on at least
 * minTrackFrames frames; avgTrackSec: their mean length (first to last frame seen, s).
 */
export function diagnostics(frames: ClipFrame[], fps: number = CLIP.fps, o: ClipOpts = CLIP): Diagnostics {
  const span = new Map<number, { first: number; last: number; n: number }>();
  for (const f of frames) for (const q of f.players) {
    if (!q.box) continue;
    const s = span.get(q.id);
    if (s) { s.last = f.t; s.n++; } else span.set(q.id, { first: f.t, last: f.t, n: 1 });
  }
  const kept = [...span.values()].filter((s) => s.n >= o.minTrackFrames);
  const timed = frames.filter((f) => f.status !== "noPitch");
  return {
    frames: frames.length,
    goodCal: frames.length ? frames.filter((f) => f.status === "ok").length / frames.length : 0,
    poorCal: frames.filter((f) => f.status === "poorCal").length,
    noPitch: frames.filter((f) => f.status === "noPitch").length,
    cuts: frames.filter((f) => f.cut).length,
    tracks: kept.length,
    avgTrackSec: kept.length ? mean(kept.map((s) => s.last - s.first + 1 / fps)) : null,
    msPerFrame: timed.length ? mean(timed.map((f) => f.ms)) : null,
  };
}
