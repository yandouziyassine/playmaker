// Pure maths for the 3D "player's eyes" view (no three.js, no DOM), so it is unit-tested in Node.
// Adapted from the portfolio site's football3d (shapes.ts, camera.ts, controls.ts; same author, MIT).
//
// Moments are in attack-normalised centimetres: the attacking side plays towards +x, the goal it attacks is centred
// on (5250, 0) cm, and +y is on the attacking player's LEFT. three.js world units are metres with y up:
//   pitch (x_cm, y_cm) at height h  ->  world (x_cm / 100, h, -y_cm / 100).
// Looking along +x with +y up, three.js puts world -z on the left of the screen, so the player's left stays on the left.
import type { Moment } from "../api.ts";
import type { Overlay } from "../pitch.ts";

export type Vec = [number, number];
export type V3 = [number, number, number];
type Cm = [number, number] | null;

export const HALF_LENGTH = 52.5, HALF_WIDTH = 34, GOAL_HALF_WIDTH = 3.66, GOAL_H = 2.44;
export const GOAL: Vec = [HALF_LENGTH, 0];     // the goal the attacking side shoots at, in metres
export const EYE_HEIGHT = 1.7;                  // m
export const LOOK_AHEAD = 20;                   // m: the resting aim point
export const LOOK_DROP = 0.9;                   // m: the aim point 20 m ahead is 0.8 m above the grass (slight downward tilt)
export const EYES_FOV = 70;                     // degrees
const DEG = Math.PI / 180;
export const PITCH_MIN = -60 * DEG, PITCH_MAX = 45 * DEG, FOV_MIN = 30, FOV_MAX = 90, WHEEL_K = 0.001;
export const LINE_W = 0.12;                     // pitch markings are 12 cm wide

export const COLORS = { attack: "#ef476f", defend: "#f1faee", ai: "#4cc9f0", pro: "#ffd166", mine: "#ffffff", ball: "#ffe066" };

/** Centimetres to metres. */
export const cmToM = (p: [number, number]): Vec => [p[0] / 100, p[1] / 100];
/** Pitch metres at height h to three.js world coordinates. */
export const toWorld = (p: Vec, h = 0): V3 => [p[0], h, -p[1]];
/** Attack-normalised centimetres at height h (metres) to three.js world coordinates. */
export const cmToWorld = (p: [number, number], h = 0): V3 => toWorld(cmToM(p), h);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export function wrapAngle(a: number): number {
  return Math.abs(a) < Math.PI ? a : a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}
function unit(v: Vec): Vec | null {
  const n = Math.hypot(v[0], v[1]);
  return n < 1e-9 ? null : [v[0] / n, v[1] / n];
}

export interface Look { yaw: number; pitch: number }  // the visitor's free look: yaw to the left, pitch up (radians)
export const LOOK_HOME: Look = { yaw: 0, pitch: 0 };
export interface Pose { position: V3; target: V3; fov: number }

/** Where the carrier stands in this frame (metres), or null when he is not tracked. */
export function carrierAt(mo: Moment, frame: Cm[]): Vec | null {
  const p = frame[mo.carrier];
  return p ? cmToM(p) : null;
}

/** The carrier faces the attacking goal's centre (unit vector); straight down the pitch when he stands on it. */
export const goalDirection = (pos: Vec): Vec => unit([GOAL[0] - pos[0], GOAL[1] - pos[1]]) ?? [1, 0];

/** The player's eyes: head height at `pos`, looking towards the goal 20 m ahead and slightly down; `look` turns the aim
 *  (the camera stays at his head). */
export function eyesPose(pos: Vec, look: Look = LOOK_HOME, fov = EYES_FOV): Pose {
  const dir = goalDirection(pos);
  const c = Math.cos(look.yaw), s = Math.sin(look.yaw);
  const d: Vec = [dir[0] * c - dir[1] * s, dir[0] * s + dir[1] * c]; // yaw > 0 turns to the left (+y)
  const rest = Math.atan2(LOOK_DROP, LOOK_AHEAD);                    // the resting tilt below the horizon
  const rise = LOOK_AHEAD * Math.tan(look.pitch - rest);
  return {
    position: toWorld(pos, EYE_HEIGHT),
    target: toWorld([pos[0] + LOOK_AHEAD * d[0], pos[1] + LOOK_AHEAD * d[1]], EYE_HEIGHT + rise),
    fov,
  };
}

/** One drag step: a screen height covers one vertical field of view, so the scene follows the finger
 *  (drag right = look left, drag down = look up). */
export function dragLook(o: Look, dx: number, dy: number, fov: number, heightPx: number): Look {
  const k = (fov * DEG) / Math.max(1, heightPx);
  return { yaw: wrapAngle(o.yaw + dx * k), pitch: clamp(o.pitch + dy * k, PITCH_MIN, PITCH_MAX) };
}
/** Wheel (deltaY, positive = down) to a new field of view: down widens it. */
export const zoomFov = (fov: number, wheel: number) => clamp(fov * Math.exp(wheel * WHEEL_K), FOV_MIN, FOV_MAX);

// ---- arrows (same meaning and colours as the 2D pitch) ----

/** The 2D overlay plus the ball trail in centimetres (the 2D trail is in screen pixels and is ignored here). */
export interface Overlay3D extends Overlay { balls?: Cm[] }

export interface ArrowSpec { from: Vec; to: Vec; color: string; dashed: boolean }

/** The arrow tip of option k: the teammate at the release frame for a pass, else the option's point. */
export function optionTip(mo: Moment, k: number): Vec | null {
  const opt = mo.options.find((q) => q.k === k);
  if (!opt) return null;
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const mate = opt.kind === "pass" && opt.player !== undefined ? release[opt.player] : null;
  return cmToM(mate ?? opt.to);
}

/** The arrows of an overlay, drawn in this order (the last on top), all from the carrier at the release frame. */
export function arrowSpecs(mo: Moment, o: Overlay): ArrowSpec[] {
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const from = carrierAt(mo, release);
  if (!from) return [];
  const out: ArrowSpec[] = [];
  const add = (k: number | undefined, color: string, dashed = false) => {
    if (k === undefined) return;
    const to = optionTip(mo, k);
    if (to && Math.hypot(to[0] - from[0], to[1] - from[1]) > 0.2) out.push({ from, to, color, dashed });
  };
  add(o.selected, COLORS.mine, true);
  add(o.pro, COLORS.pro);
  add(o.ai, COLORS.ai);
  if (o.mine !== undefined && o.mine !== o.ai && o.mine !== o.pro) add(o.mine, COLORS.mine);
  return out;
}

/** The player a selected pass goes to (for a ring under him), or null. */
export function selectedReceiver(mo: Moment, o: Overlay): number | null {
  if (o.selected === undefined) return null;
  const opt = mo.options.find((q) => q.k === o.selected);
  return opt?.kind === "pass" && opt.player !== undefined ? opt.player : null;
}

// ---- flat shapes on the grass, [x, y] pitch metres per vertex ----

function arc(c: Vec, r: number, a0: number, a1: number, n: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

/** Every line marking of a 105 x 68 m pitch as polylines. */
export function pitchMarkings(): Vec[][] {
  const L = HALF_LENGTH, W = HALF_WIDTH;
  const out: Vec[][] = [
    [[-L, -W], [L, -W], [L, W], [-L, W], [-L, -W]],
    [[0, -W], [0, W]],
    arc([0, 0], 9.15, 0, 2 * Math.PI, 64),
    arc([0, 0], 0.2, 0, 2 * Math.PI, 12),
  ];
  const a = Math.acos(5.5 / 9.15);
  for (const s of [-1, 1]) {
    const g = s * L;
    out.push([[g, -20.16], [s * (L - 16.5), -20.16], [s * (L - 16.5), 20.16], [g, 20.16]]);
    out.push([[g, -9.16], [s * (L - 5.5), -9.16], [s * (L - 5.5), 9.16], [g, 9.16]]);
    out.push(arc([s * (L - 11), 0], 0.2, 0, 2 * Math.PI, 12));
    out.push(s > 0 ? arc([L - 11, 0], 9.15, Math.PI - a, Math.PI + a, 24) : arc([-L + 11, 0], 9.15, -a, a, 24));
    for (const t of [-1, 1]) {
      const a0 = s > 0 ? Math.PI : 0;
      out.push(arc([g, t * W], 1, a0, a0 + (s * t > 0 ? Math.PI / 2 : -Math.PI / 2), 8));
    }
  }
  return out;
}

/** Polylines as flat ribbons `width` wide: two triangles per segment (12 numbers per segment). */
export function ribbon(lines: Vec[][], width = LINE_W): Float32Array {
  const segs = lines.reduce((n, l) => n + Math.max(0, l.length - 1), 0), out = new Float32Array(segs * 12);
  let k = 0;
  for (const l of lines) for (let i = 0; i + 1 < l.length; i++) {
    const [ax, ay] = l[i]!, [bx, by] = l[i + 1]!, len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (-(by - ay) / len) * (width / 2), ny = ((bx - ax) / len) * (width / 2);
    out.set([ax + nx, ay + ny, ax - nx, ay - ny, bx + nx, by + ny, bx + nx, by + ny, ax - nx, ay - ny, bx - nx, by - ny], k);
    k += 12;
  }
  return out;
}

/** The arrow as seen from the player's eyes: the camera stands where it starts, so it begins `lead` m ahead (at most
 *  half the arrow) and is a thin ribbon with a head; dashed for the visitor's pending selection. */
export const EYES_ARROW = { width: 0.3, head: 1, lead: 2.5, dash: 0.8, gap: 0.6 };
export function eyesArrow(from: Vec, to: Vec, dashed = false): Float32Array {
  const { width, head, lead, dash, gap } = EYES_ARROW;
  const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux, w = width / 2, hw = width * 2;
  const start = Math.min(lead, len / 2), h = Math.min(head, (len - start) / 2);
  const shaftEnd = len - h;
  const pieces: [number, number][] = [];
  if (dashed) for (let a = start; a < shaftEnd; a += dash + gap) pieces.push([a, Math.min(shaftEnd, a + dash)]);
  else pieces.push([start, shaftEnd]);
  const out = new Float32Array(pieces.length * 12 + 6);
  let k = 0;
  const at = (t: number): Vec => [from[0] + ux * t, from[1] + uy * t];
  for (const [a, b] of pieces) {
    const [ax, ay] = at(a), [bx, by] = at(b);
    out.set([ax + nx * w, ay + ny * w, ax - nx * w, ay - ny * w, bx + nx * w, by + ny * w,
      bx + nx * w, by + ny * w, ax - nx * w, ay - ny * w, bx - nx * w, by - ny * w], k);
    k += 12;
  }
  const [bx, by] = at(shaftEnd);
  out.set([to[0], to[1], bx + nx * hw, by + ny * hw, bx - nx * hw, by - ny * hw], k);
  return out;
}

/** Cell [column, row from the bottom] of shirt number n (0-99) in the 10 x 10 number atlas. */
export function atlasCell(n: number): Vec {
  const k = Math.max(0, Math.min(99, Math.round(n)));
  return [k % 10, 9 - Math.floor(k / 10)];
}
