// The coach's analysis in 3D, pure part (no three.js, no DOM): what the coach layer (coachLayer.ts) draws and where.
// The numbers come from the coach itself: completion chance p, value if completed / lost and net xG from the caller
// (free play: app/src/coach/advice.ts at the paused frame; the daily reveal: the answer file's p and score, the gain and
// loss parsed from the coach's own value phrase). The "why" geometry uses the coach's definitions: a defender "cuts
// the lane" when he is within LANE_WIDTH (2 m) of the pass line, the ends excluded (coach/features.ts passFeatures),
// a lost pass is lost at laneLossPoint, and the space-control surface is the coach's closed-form pitch control
// (coach/pitchControl.ts) evaluated on a grid.
//
// Coordinates: the 3D view's pitch metres (x along the pitch, +y on the left of a player facing +x), the same frame as
// geom.ts. Pitch control and lane geometry only depend on distances, so they hold in any rotation of that frame.
import { LANE_WIDTH, laneLossPoint, segmentDist, type State } from "../coach/features.ts";
import { DEFAULT_PC, control, type PitchControlParams } from "../coach/pitchControl.ts";
import { HALF_LENGTH, HALF_WIDTH, GOAL_H, toWorld, type Moment3D, type Pose, type V3, type Vec } from "./geom.ts";

/** One of the coach's options as the analysis shows it. */
export interface AnalysisOption {
  /** The option key in Moment3D.options (its target, its tap area). */
  k: number;
  /** Short tag over the tab ("1", "AI coach", "The pro", "You"), drawn in `color`. */
  tag: string;
  /** Short option name under the tag ("Pass No. 9", "Carry", "Shot"). */
  tab: string;
  /** The card's title ("Pass to #9 B. Nine"). */
  title: string;
  /** The arc's colour when this option is the one looked at. */
  color: string;
  /** The arc's colour otherwise (drawn thin and translucent); defaults to `color`. */
  faint?: string;
  /** Completion chance: the pass arrives / the team keeps the ball / the shot is a goal. */
  p?: number;
  /** Net expected goals of the option (the coach's score). */
  score?: number;
  /** Change in xG if the pass arrives (carry: if kept), and if the ball is lost there (both relative to now). */
  gain?: number;
  loss?: number;
  /** The coach's reasons, already in the page's language; sign +1 helps, -1 hurts, 0 a value phrase. */
  reasons: { text: string; sign: number }[];
}

export interface Analysis3D {
  /** Identity of this analysis (a moment, a paused frame): the option looked at is kept while the key stays. */
  key: string;
  options: AnalysisOption[];
  /** Index (in `options`) looked at first. */
  focus?: number;
  /** Velocities in m/s per player index, in the view's frame (pitch control); else from the lead-up frames. */
  vel?: (Vec | null)[];
  /** The coach's pitch-control parameters (models.json); default the library's. */
  pc?: PitchControlParams;
  /** A button on the card that plays the option looked at (free play). */
  choose?: { label: string; fn: (k: number) => void };
  /** Told when the option looked at changes (index in `options`). */
  onFocus?: (i: number) => void;
}

// ---- positions ----

type Cm = [number, number] | null;
const m = (p: [number, number]): Vec => [p[0] / 100, p[1] / 100];
/** The frame the analysis is about: the release frame (the lead-up's last). */
export const releaseFrame = (mo: Moment3D): Cm[] => mo.lead_up[mo.lead_up.length - 1] ?? [];

/** Pitch metres of each player at the release frame, split by side relative to the carrier. */
export interface Sides { carrier: Vec | null; att: { i: number; at: Vec }[]; def: { i: number; at: Vec }[] }
export function sides(mo: Moment3D): Sides {
  const fr = releaseFrame(mo), side = mo.players[mo.carrier]?.side ?? 0;
  const out: Sides = { carrier: fr[mo.carrier] ? m(fr[mo.carrier]!) : null, att: [], def: [] };
  fr.forEach((p, i) => {
    const pl = mo.players[i];
    if (!p || !pl) return;
    (pl.side === side ? out.att : out.def).push({ i, at: m(p) });
  });
  return out;
}

/** Velocities (m/s) from the lead-up: the move over the last ~0.16 s (the coach's lag: 4 frames at 25 fps), zero for a
 *  player missing at either end or a moment with a single frame. */
export function leadUpVelocities(mo: Moment3D): (Vec | null)[] {
  const n = mo.lead_up.length, fps = mo.fps || 10, back = Math.min(n - 1, Math.max(1, Math.round(0.16 * fps)));
  const a = mo.lead_up[n - 1] ?? [], b = mo.lead_up[n - 1 - back] ?? [];
  return a.map((p, i) => {
    const q = b[i];
    if (!p || !q || back < 1) return [0, 0];
    const k = fps / back / 100;
    return [(p[0] - q[0]) * k, (p[1] - q[1]) * k];
  });
}

/** Where option k ends: the receiver at the release frame (pass), the carry point, the goal mouth (shot). */
export function optionEnd(mo: Moment3D, k: number): Vec | null {
  const o = mo.options.find((q) => q.k === k);
  if (!o) return null;
  if (o.kind === "shot") return [(mo.attack ?? 1) * HALF_LENGTH, 0];
  const mate = o.kind === "pass" && o.player !== undefined ? releaseFrame(mo)[o.player] : null;
  return m(mate ?? o.to);
}

// ---- the "why" geometry ----

/** Defenders that cut the pass line from `a` to `b` (the coach's lane_defenders: within LANE_WIDTH of the segment,
 *  the first and last 5 % excluded), as player indexes. */
export function laneBlockers(a: Vec, b: Vec, def: { i: number; at: Vec }[]): number[] {
  const out: number[] = [];
  for (const d of def) {
    const { d: dist, t } = segmentDist(d.at, a, b);
    if (dist < LANE_WIDTH && t > 0.05 && t < 0.95) out.push(d.i);
  }
  return out;
}

/** Where the coach expects a failed pass from a to b to be lost (coach/features.ts laneLossPoint), or null when no
 *  defender is within `reach` m of the line (the coach then uses the midpoint: nothing worth marking). */
export function lossPoint(a: Vec, b: Vec, def: Vec[], reach = 10): Vec | null {
  let near = Infinity;
  for (const p of def) near = Math.min(near, segmentDist(p, a, b).d);
  if (near > reach) return null;
  return laneLossPoint({ def } as unknown as State, a, b, reach);
}

/** Where a defender can be within `t` s under the coach's motion model: he drifts with his velocity for the reaction
 *  time, then runs straight at vmax. Centre (m) and radius (m, 0 before the reaction time is over). */
export function reach(pos: Vec, vel: Vec | null, t: number, pc: PitchControlParams = DEFAULT_PC): { at: Vec; r: number } {
  const v = vel ?? [0, 0];
  return { at: [pos[0] + v[0] * pc.reaction, pos[1] + v[1] * pc.reaction], r: Math.max(0, pc.vmax * (t - pc.reaction)) };
}
export const REACH_S = 1.5;

/** The space-control surface: an RGBA texture `nx` x `ny` over the 105 x 68 m pitch (row 0 at y = -34, column 0 at
 *  x = -52.5). Cells the attack controls (p > 0.5) glow in `rgb` with alpha rising to `maxAlpha` (0-255), the contested
 *  boundary fades to nothing; defended space stays clear. Writes into `out` (length nx * ny * 4). */
export function controlTexture(out: Uint8Array, nx: number, ny: number, att: Vec[], attV: Vec[], def: Vec[], defV: Vec[],
  pc: PitchControlParams = DEFAULT_PC, rgb: [number, number, number] = [76, 201, 240], maxAlpha = 72): Uint8Array {
  for (let j = 0; j < ny; j++) {
    const y = -HALF_WIDTH + ((j + 0.5) * 2 * HALF_WIDTH) / ny;
    for (let i = 0; i < nx; i++) {
      const x = -HALF_LENGTH + ((i + 0.5) * 2 * HALF_LENGTH) / nx;
      const c = control([x, y], att, attV, def, defV, pc);
      const s = Math.max(0, Math.min(1, (c - 0.5) * 2)), a = s * s * (3 - 2 * s); // smoothstep: soft edges
      const o = (j * nx + i) * 4;
      out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = Math.round(a * maxAlpha);
    }
  }
  return out;
}

// ---- the option arcs ----

/** Peak height (m) of a pass arc of `len` m: a gentle loft that reads in 3D (the coach does not model the flight). */
export const arcPeak = (len: number) => Math.min(2.5, 0.06 * len);
/** Ribbon width (m) of an option: the one looked at grows with its completion chance (thin = risky). */
export function arcWidth(p: number | undefined, focused: boolean, near = false): number {
  const k = near ? 0.6 : 1;
  if (!focused) return 0.28 * k;
  const q = Math.max(0, Math.min(1, p ?? 0.5));
  return (0.4 + 0.7 * q) * k;
}

/** Points along an option's path (world coordinates): a lofted arc for a pass, flat on the grass for a carry, rising
 *  to the goal for a shot. `n` segments (n + 1 points). The path starts `lead` m out of the carrier. */
export function arcPath(from: Vec, to: Vec, kind: "pass" | "carry" | "shot", n = 20, lead = 0.8): V3[] {
  const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy) || 1;
  const s0 = Math.min(lead, len / 3) / len;
  const peak = kind === "carry" ? 0 : arcPeak(len), endH = kind === "shot" ? GOAL_H * 0.55 : 0;
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = s0 + ((1 - s0) * i) / n;
    const h = 4 * peak * t * (1 - t) + endH * t + 0.04;
    out.push(toWorld([from[0] + dx * t, from[1] + dy * t], h));
  }
  return out;
}

// ---- the breakdown ----

export interface Breakdown { p: number | null; gain: number | null; loss: number | null; net: number | null }
/** The card's numbers: completion, gain if completed, loss if lost, and net = p * gain + (1 - p) * loss when the
 *  coach's own score is not given (it is the same quantity: advice.ts score = p V(target) - (1 - p) V_opp - V(now)). */
export function breakdown(o: Pick<AnalysisOption, "p" | "gain" | "loss" | "score">): Breakdown {
  const p = o.p ?? null, gain = o.gain ?? null, loss = o.loss ?? null;
  const net = o.score ?? (p !== null && gain !== null && loss !== null ? p * gain + (1 - p) * loss : null);
  return { p, gain, loss, net };
}

/** Does a reason already talk about the pass lane? (then the lane chip from the geometry is not added) */
export const mentionsLane = (reasons: { text: string }[]) => reasons.some((r) => /lane|trajectoire|ligne de passe/i.test(r.text));

// ---- the analysis camera ----

export const ANALYSIS_CAM = { elevation: 55 * Math.PI / 180, fov: 48, minDist: 22, maxDist: 140, margin: { x: 0.82, top: 0.62, bottom: -0.8 } };

/** Normalised device coordinates of world point `p` for a camera at `c` looking at `t` (y up), or null behind it. */
export function project(p: V3, c: V3, t: V3, fovDeg: number, aspect: number): Vec | null {
  let fx = t[0] - c[0], fy = t[1] - c[1], fz = t[2] - c[2];
  const fn = Math.hypot(fx, fy, fz) || 1; fx /= fn; fy /= fn; fz /= fn;
  // right = f x up (0, 1, 0), up' = right x f
  let rx = -fz, rz = fx;
  const rn = Math.hypot(rx, rz) || 1; rx /= rn; rz /= rn;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const vx = p[0] - c[0], vy = p[1] - c[1], vz = p[2] - c[2];
  const z = vx * fx + vy * fy + vz * fz;
  if (z <= 1e-6) return null;
  const x = vx * rx + vz * rz, y = vx * ux + vy * uy + vz * uz;
  const ty = Math.tan((fovDeg * Math.PI) / 360);
  return [x / (z * ty * aspect), y / (z * ty)];
}

/** The analysis camera: from behind the carrier's attack (the attack runs up the screen, as on the 2D pitch), tilted
 *  down, as close as possible while every point (carrier, option targets) stays inside the margins. Centred on the
 *  points' screen extent, not their middle on the grass. */
export function analysisPose(points: Vec[], attack: 1 | -1, aspect: number, k = ANALYSIS_CAM): Pose {
  const pts = points.length ? points : [[0, 0] as Vec];
  const world = pts.map((p) => toWorld(p, 0.9));
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  let target: Vec = [cx / pts.length, cy / pts.length];
  const back: V3 = [-attack * Math.cos(k.elevation), Math.sin(k.elevation), 0];
  const at = (tg: Vec, d: number): { c: V3; t: V3 } => {
    const t = toWorld(tg, 0);
    return { c: [t[0] + back[0] * d, t[1] + back[1] * d, t[2]], t };
  };
  const extent = (tg: Vec, d: number) => {
    const { c, t } = at(tg, d);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, ok = true;
    for (const p of world) {
      const q = project(p, c, t, k.fov, aspect);
      if (!q) { ok = false; break; }
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    return { ok, x0, x1, y0, y1 };
  };
  const fits = (tg: Vec, d: number) => {
    const e = extent(tg, d);
    return e.ok && e.x0 >= -k.margin.x && e.x1 <= k.margin.x && e.y0 >= k.margin.bottom && e.y1 <= k.margin.top;
  };
  let d = k.maxDist;
  for (let pass = 0; pass < 3; pass++) {
    // the distance: the closest that fits (binary search), then re-centre the extent and search again
    let lo = k.minDist, hi = k.maxDist;
    if (fits(target, lo)) hi = lo;
    else for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (fits(target, mid)) hi = mid; else lo = mid; }
    d = hi;
    const e = extent(target, d);
    if (!e.ok) break;
    const midX = (e.x0 + e.x1) / 2, midY = (e.y0 + e.y1) / 2, wantY = (k.margin.top + k.margin.bottom) / 2;
    // screen offsets back to the grass, roughly: x across the pitch, y along it (attack direction)
    const ty = Math.tan((k.fov * Math.PI) / 360), dist = d;
    const sx = midX * ty * aspect * dist, sy = (midY - wantY) * ty * dist / Math.sin(k.elevation);
    target = [target[0] + attack * sy, target[1] - attack * sx];
  }
  if (!fits(target, d)) { // the re-centring moved too far: back off until it fits again
    while (d < k.maxDist && !fits(target, d)) d *= 1.05;
  }
  const { c, t } = at(target, Math.min(d, k.maxDist));
  return { position: c, target: t, fov: k.fov };
}

// ---- smooth camera moves ----

/** Ease in-out (cubic) over [0, 1]. */
export const easeInOut = (s: number) => { const x = Math.max(0, Math.min(1, s)); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
/** A camera move from `a` to `b` at progress s in [0, 1] (eased): position, aim point and fov blend together. */
export function blendPose(a: Pose, b: Pose, s: number): Pose {
  const e = easeInOut(s), l = (x: number, y: number) => x + (y - x) * e;
  return {
    position: [l(a.position[0], b.position[0]), l(a.position[1], b.position[1]), l(a.position[2], b.position[2])],
    target: [l(a.target[0], b.target[0]), l(a.target[1], b.target[1]), l(a.target[2], b.target[2])],
    fov: l(a.fov, b.fov),
  };
}
export const GLIDE_MS = 900;

// ---- screen-space labels ----

export interface Box { x: number; y: number; w: number; h: number }
export interface LabelItem { x: number; y: number; w: number; h: number }
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
/** Candidate offsets around an anchor (the label's top-left relative to the anchor): above, above-right, above-left,
 *  right, left, below, then further out. */
const SPOTS: [number, number][] = [[-0.5, -1], [0, -1], [-1, -1], [0.15, -0.5], [-1.15, -0.5], [-0.5, 0.25], [0.15, 0.25], [-1.15, 0.25], [-0.5, -2.1], [-0.5, 1.35]];
const GAP = 8;

/** Places labels near their anchors (screen px) in order (the most important first): each takes the first spot that
 *  stays inside the view and clears the labels already placed and the `obstacles` (the view's buttons); when none
 *  is clear, the spot with the least overlap. Every anchor point itself is also kept clear of other labels, so a label
 *  never hides another option's target. Returns one box per item. */
export function layoutLabels(items: LabelItem[], view: { w: number; h: number }, obstacles: Box[] = [], pad = 4): Box[] {
  const placed: Box[] = [], anchors: Box[] = items.map((it) => ({ x: it.x - 6, y: it.y - 6, w: 12, h: 12 }));
  return items.map((it, idx) => {
    let best: Box | null = null, bestCost = Infinity;
    for (const [ox, oy] of SPOTS) {
      const gx = ox > 0 ? GAP : ox <= -1 ? -GAP : 0, gy = oy > 0 ? GAP : oy <= -1 ? -GAP : 0;
      // each spot clamped into the view first: a label never leaves it, crowded edges just try the next spot
      const b: Box = { x: it.x + ox * it.w + gx, y: it.y + oy * it.h + gy, w: it.w, h: it.h };
      b.x = Math.min(Math.max(pad, b.x), Math.max(pad, view.w - pad - b.w));
      b.y = Math.min(Math.max(pad, b.y), Math.max(pad, view.h - pad - b.h));
      let cost = 0;
      for (const o of obstacles) cost += overlap(b, o) * 10;
      for (const p of placed) cost += overlap(b, p) * 10;
      anchors.forEach((a, j) => { if (j !== idx) cost += overlap(b, a) * 4; });
      if (cost < bestCost) { best = b; bestCost = cost; }
      if (cost === 0) break;
    }
    const b = best!;
    placed.push(b);
    return b;
  });
}
