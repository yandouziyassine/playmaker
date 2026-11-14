// Pure maths for the 3D footballer figures (no three.js, no DOM), unit-tested in Node: the gait from the speed (walk,
// run, sprint), the pose angles of one moment of the stride, the kit colours, and the instance matrices of every body
// part. Each part is one InstancedMesh in view.ts (one instance per player, or several for the limbs), so 22 players
// cost a handful of draw calls; this file writes the 4 x 4 matrices straight into the meshes' instance buffers.
//
// The figure's own frame: origin on the grass between the feet, +x forward (where he faces), +y up, +z on his right.
// view.ts turns it by the heading about +y (the same rotation as before: local +x -> pitch direction `heading`).
// A limb hangs from its joint along -y; a positive angle (about +z) swings its far end forward (+x).
// Matrices are column-major Float32Array(16) like three.js's Matrix4.elements.

export type Gait = "idle" | "walk" | "run" | "sprint";
export const IDLE_MS = 0.3, WALK_MS = 2, SPRINT_MS = 6; // m/s: still below 0.3, walking below 2, sprinting from 6

/** Piecewise-linear interpolation through [x, y] knots (sorted by x), clamped at both ends. */
export function interp(x: number, knots: readonly (readonly [number, number])[]): number {
  if (x <= knots[0]![0]) return knots[0]![1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i]!, [x0, y0] = knots[i - 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return knots[knots.length - 1]![1];
}

export const gaitOf = (speed: number): Gait => (speed < IDLE_MS ? "idle" : speed < WALK_MS ? "walk" : speed < SPRINT_MS ? "run" : "sprint");

export interface GaitParams {
  gait: Gait;
  /** Hip swing amplitude (rad), arm swing amplitude (rad). */
  legAmp: number; armAmp: number;
  /** Knee flex at mid-swing (rad), the elbows' bend (rad). */
  knee: number; elbow: number;
  /** Forward lean of the upper body from the speed alone (rad), the extra lift at mid-flight (m). */
  lean: number; bounce: number;
  /** Metres covered by one full stride (two steps): the phase advances 2 pi per stride. */
  stride: number;
}

const LEG = [[0, 0], [IDLE_MS, 0.12], [WALK_MS, 0.42], [SPRINT_MS, 0.78], [9, 0.9]] as const;
const ARM = [[0, 0], [IDLE_MS, 0.1], [WALK_MS, 0.38], [SPRINT_MS, 0.85], [9, 1.0]] as const;
const KNEE = [[0, 0], [IDLE_MS, 0.12], [WALK_MS, 0.55], [SPRINT_MS, 1.35], [9, 1.55]] as const;
const ELBOW = [[0, 0.12], [WALK_MS - 0.4, 0.35], [WALK_MS + 0.6, 1.25], [9, 1.45]] as const; // arms bend when he runs
const LEAN = [[0, 0], [WALK_MS, 0.04], [SPRINT_MS, 0.13], [9, 0.17]] as const;
const BOUNCE = [[0, 0], [WALK_MS, 0.008], [WALK_MS + 1, 0.035], [9, 0.05]] as const;

/** Stride length (m per two steps): ~1.3 m walking, ~2.7 m at 4 m/s, ~4 m sprinting; cadence = speed / stride. */
export const strideLength = (speed: number) => Math.max(1.2, Math.min(4.3, 0.9 + 0.45 * speed));

/** The gait at this speed (m/s); amplitudes rise smoothly from standing to sprinting. With reduced motion: standing. */
export function gaitParams(speed: number, reduced = false): GaitParams {
  const v = reduced ? 0 : Math.max(0, speed);
  return {
    gait: gaitOf(v), legAmp: interp(v, LEG), armAmp: interp(v, ARM), knee: interp(v, KNEE), elbow: interp(v, ELBOW),
    lean: interp(v, LEAN), bounce: interp(v, BOUNCE), stride: strideLength(v),
  };
}

/** The stride phase after running `distance` m more at `speed` m/s (radians, wrapped to [0, 2 pi)); frozen when still
 *  or with reduced motion. Driven by distance, not time, so the feet keep pace with the ground. */
export function advancePhase(phase: number, distance: number, speed: number, reduced = false): number {
  if (reduced || speed < IDLE_MS || distance <= 0) return phase;
  const p = phase + (2 * Math.PI * distance) / strideLength(speed);
  return p - 2 * Math.PI * Math.floor(p / (2 * Math.PI));
}

/** The extra forward lean (rad) when accelerating (m/s^2; braking leans back a little), capped. */
export const accelLean = (accel: number) => Math.max(-0.06, Math.min(0.14, accel * 0.035));

export interface PoseAngles {
  hipL: number; hipR: number; kneeL: number; kneeR: number;
  shoulderL: number; shoulderR: number; elbowL: number; elbowR: number;
  /** Forward lean of the upper body (rad), lift of the whole figure (m). */
  lean: number; bob: number;
}

/** The pose at stride phase `phase`: legs in antiphase, each knee flexing while its leg swings forward, each arm
 *  opposite its leg, elbows bent; `extraLean` adds the acceleration lean. Phase 0: legs together, left leg swinging
 *  forward. */
export function poseAt(phase: number, g: GaitParams, extraLean = 0): PoseAngles {
  const sL = Math.sin(phase), cL = Math.cos(phase);
  const flex = (c: number) => g.knee * Math.max(0, c) + 0.06; // the swinging leg's knee bends, the planted one stays nearly straight
  return {
    hipL: g.legAmp * sL, hipR: -g.legAmp * sL,
    kneeL: flex(cL), kneeR: flex(-cL),
    shoulderL: -g.armAmp * sL, shoulderR: g.armAmp * sL,
    elbowL: g.elbow, elbowR: g.elbow,
    lean: g.lean + extraLean, bob: g.bounce * Math.abs(Math.sin(phase)),
  };
}

// ---- the body: sizes in metres ----

export const BODY = {
  thigh: 0.44, shin: 0.43, sole: 0.07, hipW: 0.09, thighR: 0.085, shinR: 0.064,
  upperArm: 0.29, forearm: 0.27, armR: 0.056, foreR: 0.047, shoulderW: 0.215,
  torsoH: 0.54, torsoW: 0.36, torsoD: 0.2, shortsH: 0.25, shortsW: 0.34, shortsD: 0.2,
  headR: 0.115, neck: 0.06, shoe: 0.22, shoeR: 0.05,
};
/** Height of the hips when standing straight. */
export const HIP_H = BODY.thigh + BODY.shin + BODY.sole;
/** Number of instances per player in the limbs mesh: thighs, shins, shoes, upper arms, forearms (left then right). */
export const LIMBS = 10;
export const LIMB_ORDER = ["thighL", "thighR", "shinL", "shinR", "shoeL", "shoeR", "upperArmL", "upperArmR", "forearmL", "forearmR"] as const;

/** The hip height that keeps the lower foot on the grass for these leg angles: the longer vertical reach of the two. */
export function hipHeight(a: PoseAngles): number {
  const reach = (hip: number, knee: number) => BODY.thigh * Math.cos(hip) + BODY.shin * Math.cos(hip - knee) + BODY.sole;
  return Math.max(reach(a.hipL, a.kneeL), reach(a.hipR, a.kneeR));
}

// ---- 4 x 4 matrices (column-major) ----

export type M4 = Float32Array;
export const identity = (): M4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** out = a * b (out may not alias a or b). */
export function mul(a: ArrayLike<number>, b: ArrayLike<number>, out: M4 = new Float32Array(16)): M4 {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
  }
  return out;
}
export const translation = (x: number, y: number, z: number): M4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
export const scaling = (x: number, y: number, z: number): M4 => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
export function rotationY(a: number): M4 { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); }
export function rotationZ(a: number): M4 { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
/** A point through a matrix. */
export const apply = (m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] => [
  m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
];
const chain = (...ms: ArrayLike<number>[]): M4 => ms.reduce<M4>((acc, x) => mul(acc, x), identity());

/** The figure's root: at world (x, z) on the grass, turned to `heading` (radians, pitch frame), scaled by k (0 hides). */
export const rootMatrix = (x: number, z: number, heading: number, k = 1): M4 => chain(translation(x, 0, z), rotationY(heading), scaling(k, k, k));

/** A limb segment: from `parent`, at joint `j`, turned by `angle` about +z, a unit part scaled to length L and radius r
 *  (the limb geometry spans y in [-1, 0] between its two joints at unit scale, 1 unit wide). */
const segment = (parent: M4, j: [number, number, number], angle: number, L: number, r: number): M4 =>
  chain(parent, translation(...j), rotationZ(angle), scaling(2 * r, L, 2 * r));

export interface FigureMatrices { torso: M4; shorts: M4; head: M4; limbs: M4[] }

/** Every part's instance matrix for a figure at `root` in pose `a`. The torso/shorts geometries span y in [0, 1] /
 *  [-1, 0] and are 1 unit across, the head is a unit sphere on the origin (see view.ts); the limbs follow LIMB_ORDER. */
export function figureMatrices(root: M4, a: PoseAngles): FigureMatrices {
  const B = BODY, hipY = hipHeight(a) + a.bob;
  const pelvis = mul(root, translation(0, hipY, 0));
  const upper = mul(pelvis, rotationZ(-a.lean));           // the upper body leans forward about the hips
  const torsoBase = 0.02, shoulderY = torsoBase + B.torsoH - 0.05;
  const torso = chain(upper, translation(0, torsoBase, 0), scaling(B.torsoD, B.torsoH, B.torsoW));
  const shorts = chain(pelvis, translation(0, 0.1, 0), scaling(B.shortsD, B.shortsH, B.shortsW));
  const head = chain(upper, translation(0.01, torsoBase + B.torsoH + B.neck + B.headR, 0), scaling(B.headR, B.headR, B.headR));
  const limbs: M4[] = [];
  const legs = ([[-1, a.hipL, a.kneeL], [1, a.hipR, a.kneeR]] as const).map(([side, hip, knee]) => {
    const thigh = segment(pelvis, [0, 0, side * B.hipW], hip, B.thigh, B.thighR);
    const kneeAt = mul(pelvis, mul(translation(0, 0, side * B.hipW), mul(rotationZ(hip), translation(0, -B.thigh, 0))));
    const shin = segment(kneeAt, [0, 0, 0], -knee, B.shin, B.shinR);
    const ankleAt = mul(kneeAt, mul(rotationZ(-knee), translation(0, -B.shin, 0)));
    // the shoe points forward, level with the grass whatever the shin's angle
    const shoe = segment(ankleAt, [0, 0, 0], Math.PI / 2 - (hip - knee), B.shoe, B.shoeR);
    return { thigh, shin, shoe };
  });
  const arms = ([[-1, a.shoulderL, a.elbowL], [1, a.shoulderR, a.elbowR]] as const).map(([side, sh, el]) => {
    const j: [number, number, number] = [0, shoulderY, side * B.shoulderW];
    const upperArm = segment(upper, j, sh, B.upperArm, B.armR);
    const elbowAt = mul(upper, mul(translation(...j), mul(rotationZ(sh), translation(0, -B.upperArm, 0))));
    const forearm = segment(elbowAt, [0, 0, 0], el, B.forearm, B.foreR); // the forearm bends forward at the elbow
    return { upperArm, forearm };
  });
  limbs.push(legs[0]!.thigh, legs[1]!.thigh, legs[0]!.shin, legs[1]!.shin, legs[0]!.shoe, legs[1]!.shoe,
    arms[0]!.upperArm, arms[1]!.upperArm, arms[0]!.forearm, arms[1]!.forearm);
  return { torso, shorts, head, limbs };
}

// ---- kit and skin colours ----

/** Relative luminance (0..1) of a #rgb / #rrggbb colour (sRGB, approximate). */
export function luminance(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return 0.5;
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

export const KEEPER_COLORS: [string, string] = ["#ff8c42", "#9b5de5"];
/** A side's kit from its shirt colour: contrasting shorts (dark under a light shirt, white under a dark one), socks
 *  like the shirt; a keeper (when the data marks him) wears his side's keeper colour. */
export function kitColors(shirt: string, keeper = false, side: 0 | 1 = 0): { shirt: string; shorts: string; socks: string } {
  const s = keeper ? KEEPER_COLORS[side] : shirt;
  return { shirt: s, shorts: luminance(s) > 0.45 ? "#1f2a3a" : "#f2f2f2", socks: s };
}

export const SKIN_TONES = ["#f1c9a5", "#e3b48e", "#c99068", "#9a6440", "#6b4128"] as const;
/** A skin tone per player, deterministic (the same player keeps his tone). */
export function skinTone(player: number): string {
  let h = (player + 1) * 2654435761;
  h = (h ^ (h >>> 13)) >>> 0;
  return SKIN_TONES[h % SKIN_TONES.length]!;
}
