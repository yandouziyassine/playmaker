// app/test/view3d-motion.test.ts: the 3D view's motion and camera maths (no WebGL): interpolation between tracking
// frames, facing and its smoothing, the run bob, the three camera modes, and hit areas that grow with distance.
import { describe, expect, it } from "vitest";
import type { Moment } from "../src/api.ts";
import {
  BOB_AMP, CARRY_R, COLORS, ELEV_MAX, GOAL_H, HALF_LENGTH, HALF_WIDTH, HIT_PX, LOOK_HOME, NO_FRAMING, ORBIT_HOME, PICK_R, PICK_TOP, RUN_MS, STADIUM,
  TACTICAL, arrowSpecs, cameraPose, damp, dragOrbit, eyesPose, followFocus, goalDirection, goalOf, hitRadius, isCameraMode, lerpFrame, lerpPoint,
  metresPerPx, motion, orbitPosition, pickTargets, rayCylinder, rayPick, runBob, stadiumPose, tacticalPose, turnTowards, wrapAngle, zoomOrbit, type V3, type Vec,
  EYES_ARROW, FAR_ARROW, TAPER_MIN, eyesArrow, ribbonHalfWidth,
} from "../src/view3d/geom.ts";

describe("the arrow ribbon seen from the player's eyes", () => {
  const xs = (a: Float32Array) => [...a].filter((_, i) => i % 2 === 0), ys = (a: Float32Array) => [...a].filter((_, i) => i % 2 === 1);
  it("starts 2 m ahead of the carrier, or half way for a short pass, and keeps the head at the target", () => {
    const long = eyesArrow([0, 0], [30, 0]), short = eyesArrow([0, 0], [3, 0]);
    expect(Math.min(...xs(long))).toBeCloseTo(EYES_ARROW.lead, 6);
    expect(Math.min(...xs(short))).toBeCloseTo(1.5, 6);
    expect([long[12], long[13]]).toEqual([30, 0]);   // the head's tip
    expect([short[12], short[13]]).toEqual([3, 0]);
  });
  it("tapers: narrow at the start (near the eye), full 0.35 m width after 6 m, the head unchanged", () => {
    const a = eyesArrow([0, 0], [30, 0]), s = EYES_ARROW.lead;
    expect(ribbonHalfWidth(s, s, EYES_ARROW)).toBeCloseTo((EYES_ARROW.width / 2) * TAPER_MIN, 9);
    expect(ribbonHalfWidth(s + 3, s, EYES_ARROW)).toBeGreaterThan(ribbonHalfWidth(s, s, EYES_ARROW));
    expect(ribbonHalfWidth(s + 3, s, EYES_ARROW)).toBeLessThan(EYES_ARROW.width / 2);
    expect(ribbonHalfWidth(s + 6, s, EYES_ARROW)).toBeCloseTo(EYES_ARROW.width / 2, 9);
    expect(ribbonHalfWidth(s + 20, s, EYES_ARROW)).toBeCloseTo(EYES_ARROW.width / 2, 9);
    // the shaft's near end (vertices 0, 1) is narrower than its far end (vertices 2, 5)
    expect(Math.abs(a[1]! - a[3]!)).toBeCloseTo(EYES_ARROW.width * TAPER_MIN, 6);
    expect(Math.abs(a[5]! - a[11]!)).toBeCloseTo(EYES_ARROW.width, 6);
    expect(Math.max(...ys(a).map(Math.abs))).toBeCloseTo(EYES_ARROW.width * 2, 6); // the head's wings
  });
  it("dashes taper piece by piece and the far style keeps a constant width", () => {
    const d = eyesArrow([0, 0], [30, 0], true), first = Math.abs(d[1]! - d[3]!), later = Math.abs(d[12 * 8 + 1]! - d[12 * 8 + 3]!);
    expect(first).toBeLessThan(later);
    const far = eyesArrow([0, 0], [30, 0], false, FAR_ARROW);
    expect(Math.min(...xs(far))).toBeCloseTo(FAR_ARROW.lead, 6);
    expect(Math.abs(far[1]! - far[3]!)).toBeCloseTo(FAR_ARROW.width, 6);
    expect(Math.abs(far[5]! - far[11]!)).toBeCloseTo(FAR_ARROW.width, 6);
  });
});

const norm = (v: V3): V3 => { const n = Math.hypot(...v); return [v[0] / n, v[1] / n, v[2] / n]; };
const rayTo = (o: V3, p: V3) => norm([p[0] - o[0], p[1] - o[1], p[2] - o[2]]);

describe("interpolation between tracking frames", () => {
  it("blends two frames linearly and clamps u", () => {
    const a = [[0, 0], [1000, 1000]] as [number, number][], b = [[1000, 0], [1000, 3000]] as [number, number][];
    expect(lerpFrame(a, b, 0.25)).toEqual([[250, 0], [1000, 1500]]);
    expect(lerpFrame(a, b, -1)).toEqual(a);
    expect(lerpFrame(a, b, 2)).toEqual(b);
  });
  it("shows a player missing at one end at the nearer end, and nothing when missing at both", () => {
    expect(lerpFrame([[0, 0], null], [null, null], 0.2)).toEqual([[0, 0], null]);
    expect(lerpFrame([[0, 0], null], [null, [5, 5]], 0.8)).toEqual([null, [5, 5]]);
    expect(lerpFrame([[0, 0]], [[0, 0], [1, 1]], 0.9)).toEqual([[0, 0], [1, 1]]); // frames of different lengths
    expect(lerpPoint(null, null, 0.5)).toBeNull();
  });
  it("damps towards a target independently of the frame rate", () => {
    const one = damp(0, 10, 0.5, 0.5);
    let many = 0;
    for (let i = 0; i < 50; i++) many = damp(many, 10, 0.01, 0.5);
    expect(one).toBeCloseTo(10 * (1 - Math.exp(-1)), 6);
    expect(many).toBeCloseTo(one, 4);
    expect(damp(3, 10, 0, 0.5)).toBe(3);
    expect(damp(3, 10, 0.1, 0)).toBe(10);
  });
});

describe("facing and the run bob", () => {
  it("reads speed and heading from a move; standing keeps the old heading", () => {
    const mv = motion([0, 0], [1, 1], 0.1); // 14 m/s diagonal (pitch metres)
    expect(mv.speed).toBeCloseTo(Math.SQRT2 * 10, 6);
    expect(mv.heading).toBeCloseTo(Math.PI / 4, 6);
    expect(motion([0, 0], [0.01, 0], 0.1).heading).toBeNull(); // 0.1 m/s: standing
    expect(motion(null, [0, 0], 0.1)).toEqual({ speed: 0, heading: null });
    expect(motion([0, 0], [1, 0], 0)).toEqual({ speed: 0, heading: null });
  });
  it("turns the short way round, smoothly, and settles on the target", () => {
    const a = turnTowards(0, Math.PI / 2, 0.05);
    expect(a).toBeGreaterThan(0); expect(a).toBeLessThan(Math.PI / 2);
    expect(turnTowards(0, Math.PI / 2, 10)).toBeCloseTo(Math.PI / 2, 4);
    const near = turnTowards(Math.PI - 0.1, -Math.PI + 0.1, 0.05); // 0.2 rad apart across the wrap: turn through pi, not back
    expect(Math.abs(wrapAngle(near - (Math.PI - 0.1)))).toBeLessThan(0.2);
    expect(near > Math.PI - 0.1 || near < -Math.PI + 0.1).toBe(true);
    expect(turnTowards(1, 1, 0.1)).toBeCloseTo(1, 9);
  });
  it("bobs only when running, fades in with speed, and never with reduced motion", () => {
    expect(runBob(1.0, 0.4)).toBe(0);
    expect(runBob(RUN_MS, 0.4)).toBe(0);
    expect(runBob(4, 0.8)).toBeCloseTo(BOB_AMP, 6);      // peak of the stride at full speed
    expect(runBob(4, 1.6)).toBeCloseTo(0, 6);            // back on the ground after one stride
    expect(runBob(2.25, 0.8)).toBeCloseTo(BOB_AMP / 2, 6);
    expect(runBob(8, 0.8, true)).toBe(0);
  });
});

describe("camera modes", () => {
  const up = (pose: { position: V3; target: V3 }) => pose.position[1] - pose.target[1];
  it("names the three modes", () => {
    expect(isCameraMode("eyes") && isCameraMode("stadium") && isCameraMode("tactical")).toBe(true);
    expect(isCameraMode("drone")).toBe(false);
    expect(isCameraMode(null)).toBe(false);
  });
  it("stadium: on the near touchline, elevated, panning with the ball and looking at it", () => {
    const a = stadiumPose([0, 0]), b = stadiumPose([30, 10]);
    expect(a.position[1]).toBeCloseTo(STADIUM.height, 6);
    expect(a.position[2]).toBeGreaterThan(HALF_WIDTH);           // behind the -y touchline (world +z)
    expect(a.fov).toBe(STADIUM.fov);
    expect(b.position[0] - a.position[0]).toBeCloseTo(30 * STADIUM.follow, 6);
    expect(b.target[0]).toBe(30); expect(b.target[2]).toBeCloseTo(-5, 6); // half way towards the ball across the pitch
    expect(stadiumPose([500, 0]).target[0]).toBe(HALF_LENGTH);     // clamped to the pitch
  });
  it("tactical: high and tilted, most of the pitch in view", () => {
    const a = tacticalPose([0, 0]);
    expect(a.position[1]).toBeCloseTo(TACTICAL.height, 6);
    expect(a.target).toEqual([0, 0, -0]);
    const tilt = Math.atan2(up(a), Math.hypot(a.position[0] - a.target[0], a.position[2] - a.target[2]));
    expect(tilt).toBeGreaterThan(Math.PI / 4); expect(tilt).toBeLessThan(Math.PI / 2); // tilted, not straight down
    expect(tacticalPose([40, 0]).target[0]).toBe(20);              // follows half way, keeps the whole pitch readable
  });
  it("eyes: the carrier, looking at the goal he attacks (either end in free play)", () => {
    const home = cameraPose("eyes", [10, 0], [0, 0], LOOK_HOME, 70, NO_FRAMING, ORBIT_HOME, goalOf(1));
    const away = cameraPose("eyes", [10, 0], [0, 0], LOOK_HOME, 70, NO_FRAMING, ORBIT_HOME, goalOf(-1));
    expect(home.target[0]).toBeGreaterThan(10);
    expect(away.target[0]).toBeLessThan(10);
    expect(goalDirection([10, 5], goalOf(-1))[0]).toBeLessThan(0);
    expect(goalDirection([-52.5, 0], goalOf(-1))).toEqual([-1, 0]);
    expect(eyesPose([10, 0], LOOK_HOME, 70, NO_FRAMING, goalOf(-1)).position).toEqual(eyesPose([10, 0]).position);
    expect(cameraPose("stadium", [10, 0], [20, 5], LOOK_HOME, 70, NO_FRAMING, ORBIT_HOME)).toEqual(stadiumPose([20, 5]));
    expect(cameraPose("tactical", [10, 0], [20, 5], LOOK_HOME, 70, NO_FRAMING, ORBIT_HOME)).toEqual(tacticalPose([20, 5]));
  });
  it("the aim point follows the ball with a lag, and cuts on a jump", () => {
    const f = followFocus([0, 0], [10, 0], 0.1);
    expect(f[0]).toBeGreaterThan(0); expect(f[0]).toBeLessThan(10);
    expect(followFocus([0, 0], [40, 0], 0.1)).toEqual([40, 0]);
  });
  it("orbits round the target: azimuth turns, elevation stays above the grass, zoom scales the distance", () => {
    const base = stadiumPose([0, 0]);
    const o = dragOrbit(ORBIT_HOME, 100, 0, 200); // a drag of half the screen height: a quarter turn
    expect(o.azimuth).toBeCloseTo(-Math.PI / 2, 6);
    const moved = orbitPosition(base.position, base.target, o);
    const r0 = Math.hypot(base.position[0] - base.target[0], base.position[1] - base.target[1], base.position[2] - base.target[2]);
    const r1 = Math.hypot(moved[0] - base.target[0], moved[1] - base.target[1], moved[2] - base.target[2]);
    expect(r1).toBeCloseTo(r0, 6);
    expect(moved[1]).toBeCloseTo(base.position[1], 6);
    const low = orbitPosition(base.position, base.target, dragOrbit(ORBIT_HOME, 0, -10_000, 200));
    expect(low[1]).toBeGreaterThan(base.target[1] + 1); // never under the pitch
    expect(dragOrbit(ORBIT_HOME, 0, 10_000, 200).elevation).toBeCloseTo(ELEV_MAX, 6);
    expect(zoomOrbit(ORBIT_HOME, 100_000).zoom).toBe(1.8);
    expect(zoomOrbit(ORBIT_HOME, -100_000).zoom).toBe(0.4);
    const far = orbitPosition(base.position, base.target, { ...ORBIT_HOME, zoom: 1.5 });
    expect(Math.hypot(far[0] - base.target[0], far[1] - base.target[1], far[2] - base.target[2])).toBeCloseTo(1.5 * r0, 6);
  });
});

describe("hit areas scale with distance", () => {
  const mo = {
    id: "m", carrier: 0, fps: 10,
    players: [{ side: 0, shirt: 10, name: "a" }, { side: 0, shirt: 9, name: "b" }],
    lead_up: [[[0, 0], [3000, 1000]]], ball: [[0, 0]],
    options: [{ k: 0, kind: "pass", player: 1, to: [0, 0] }, { k: 1, kind: "carry", angle: 0, to: [1600, -500] }, { k: 2, kind: "shot", to: [5250, 0] }],
  } as unknown as Moment;

  it("keeps the model's radius up close and grows it to 44 px further away", () => {
    const screen = { fov: 42, heightPx: 600 };
    expect(hitRadius(PICK_R, 5, screen)).toBe(PICK_R);
    const far = hitRadius(PICK_R, 80, screen);
    expect(far).toBeGreaterThan(PICK_R);
    expect(far).toBeCloseTo((HIT_PX / 2) * metresPerPx(80, 42, 600), 9);
    expect(far / metresPerPx(80, 42, 600)).toBeCloseTo(HIT_PX / 2, 9); // 22 px on screen
    expect(hitRadius(CARRY_R, 80)).toBe(CARRY_R);                         // no screen: the model's radius
  });

  it("picks a teammate from the stadium camera with a tap a few pixels off him", () => {
    const pose = stadiumPose([15, 0]), o = pose.position, screen = { fov: pose.fov, heightPx: 600 };
    const targets = pickTargets(mo), mate: V3 = [30, 1, -10];
    const dist = Math.hypot(mate[0] - o[0], mate[1] - o[1], mate[2] - o[2]);
    const off = 15 * metresPerPx(dist, pose.fov, 600), ray = rayTo(o, [mate[0] + off, 1, mate[2]]); // 15 px to the side of him
    expect(off).toBeGreaterThan(PICK_R);                                                      // metres off: the body cylinder misses...
    expect(rayCylinder(o, ray, [30, 10], PICK_R, PICK_TOP)).toBeNull();
    expect(rayCylinder(o, ray, [30, 10], hitRadius(PICK_R, dist, screen), PICK_TOP)).not.toBeNull(); // ...the grown one hits
    expect(rayPick(o, ray, targets, screen)).toBe(0);
  });

  it("picks the carry point and the goal mouth from the tactical camera", () => {
    const pose = tacticalPose([10, 0]), o = pose.position, screen = { fov: pose.fov, heightPx: 600 };
    const targets = pickTargets(mo);
    expect(rayPick(o, rayTo(o, [16.8, 0, 5.6]), targets, screen)).toBe(1);
    expect(rayPick(o, rayTo(o, [52.5, GOAL_H / 2, 0]), targets, screen)).toBe(2);
    expect(rayPick(o, rayTo(o, [52.5, GOAL_H + 1.5, 0]), targets, screen)).toBe(2); // just over the bar: the grown mouth
  });

  it("free play: the goal at the other end is the shot target when the carrier attacks -x", () => {
    const away = { ...mo, attack: -1 as const };
    expect(pickTargets(away).find((t) => t.kind === "shot")!.at).toEqual([-HALF_LENGTH, 0]);
    const o: V3 = [0, 1.7, 0];
    expect(rayPick(o, [-1, 0, 0], pickTargets(away))).toBe(2);
    expect(rayPick(o, [1, 0, 0], pickTargets(away))).toBeNull();
  });

  it("draws the coach's ranked options as arrows, the first on top", () => {
    const specs = arrowSpecs(mo, { coach: [{ k: 0, color: "#4cc9f0" }, { k: 1, color: "#ffd166" }] });
    expect(specs.map((s) => [s.color, s.dashed])).toEqual([["#ffd166", false], ["#4cc9f0", false]]);
    expect(specs[1]!.to).toEqual([30, 10] as Vec);
    expect(arrowSpecs(mo, {})).toEqual([]);
    expect(COLORS.ai).toBe("#4cc9f0");
  });
});
