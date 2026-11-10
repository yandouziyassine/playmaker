// app/test/view3d.test.ts: the 3D view's pure maths (no WebGL).
import { describe, expect, it } from "vitest";
import type { Moment } from "../src/api.ts";
import {
  COLORS, EYE_HEIGHT, FOV_MAX, FRAME_BACK, LOOK_HOME, REST_TILT, badgeColor, badgeItems, frameTips, halfHFov, isTap,
  pickTargets, rayCylinder, rayPick, arrowSpecs, atlasCell, carrierAt, cmToWorld, dragLook, eyesArrow, eyesPose,
  goalDirection, selectedReceiver, toWorld, zoomFov, type V3,
} from "../src/view3d/geom.ts";

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const mo = {
  id: "m", carrier: 0, fps: 10,
  players: [{ side: 0, shirt: 10, name: "a" }, { side: 0, shirt: 9, name: "b" }, { side: 1, shirt: 4, name: "c" }],
  lead_up: [[[0, 0], [1000, 500], [2000, 0]], [[1000, -500], [3000, 1000], [2500, 0]]],
  ball: [[0, 0], [1000, -500]],
  options: [
    { k: 0, kind: "pass", player: 1, to: [0, 0] },
    { k: 1, kind: "carry", angle: 0, to: [1600, -500] },
    { k: 2, kind: "shot", to: [5250, 0] },
  ],
} as unknown as Moment;

describe("coordinates", () => {
  it("maps attack-normalised cm to three.js world metres (x, height, -y)", () => {
    expect(cmToWorld([5250, 0])).toEqual([52.5, 0, -0]);
    expect(cmToWorld([-1000, 3400], 1.7)).toEqual([-10, 1.7, -34]);
    expect(toWorld([3, -2], 0.5)).toEqual([3, 0.5, 2]);
  });

  it("keeps the attacking player's left (+y) on the left of the screen when he looks at the goal", () => {
    const pose = eyesPose([0, 0]);
    const fwd = sub(pose.target, pose.position), right = cross(fwd, [0, 1, 0]);
    expect(dot(sub(cmToWorld([2000, 1000]), pose.position), right)).toBeLessThan(0); // +y: left
    expect(dot(sub(cmToWorld([2000, -1000]), pose.position), right)).toBeGreaterThan(0);
  });
});

describe("player's eyes", () => {
  it("finds the carrier in a frame (null when untracked)", () => {
    expect(carrierAt(mo, mo.lead_up[1]!)).toEqual([10, -5]);
    expect(carrierAt(mo, [null, [0, 0]])).toBeNull();
  });

  it("stands at head height on the carrier and looks at the goal, tilted slightly down", () => {
    const pose = eyesPose([10, -5]);
    expect(pose.position).toEqual([10, EYE_HEIGHT, 5]);
    const d = sub(pose.target, pose.position);
    const g = goalDirection([10, -5]);
    expect(g[0]).toBeGreaterThan(0.99);                 // the goal is ahead (+x)...
    expect(d[0] / Math.hypot(d[0], d[2])).toBeCloseTo(g[0], 6);
    expect(-d[2] / Math.hypot(d[0], d[2])).toBeCloseTo(g[1], 6); // ...and a little to his left (+y)
    const tilt = Math.atan2(-d[1], Math.hypot(d[0], d[2]));
    expect(tilt).toBeCloseTo(REST_TILT, 6);             // looking down a little: the horizon sits above the middle
    expect(tilt).toBeLessThan(0.2);
  });

  it("looks straight down the pitch from on the goal line centre", () => {
    expect(goalDirection([52.5, 0])).toEqual([1, 0]);
  });

  it("turns left with a positive yaw and keeps the camera in place", () => {
    const a = eyesPose([0, 0], { yaw: Math.PI / 2, pitch: 0 });
    expect(a.position).toEqual(eyesPose([0, 0]).position);
    expect(a.target[0]).toBeCloseTo(0, 6);
    expect(a.target[2]).toBeLessThan(0); // world -z = pitch +y = his left
  });

  it("drags the look within limits and zooms the field of view", () => {
    const l = dragLook(LOOK_HOME, 0, 10_000, 70, 500);
    expect(l.pitch).toBeCloseTo((45 * Math.PI) / 180);
    expect(dragLook(LOOK_HOME, 100, 0, 70, 500).yaw).toBeGreaterThan(0);
    expect(zoomFov(70, 100_000)).toBe(90);
    expect(zoomFov(70, -100_000)).toBe(30);
  });
});

describe("arrows", () => {
  it("draws the 2D arrows from the carrier at the release frame, with the 2D colours", () => {
    const a = arrowSpecs(mo, { selected: 0 });
    expect(a).toEqual([{ from: [10, -5], to: [30, 10], color: COLORS.mine, dashed: true }]); // pass: the teammate
    const r = arrowSpecs(mo, { ai: 2, pro: 1, mine: 0 });
    expect(r.map((x) => x.color)).toEqual([COLORS.pro, COLORS.ai, COLORS.mine]);
    expect(r[0]!.to).toEqual([16, -5]);
    expect(r[1]!.to).toEqual([52.5, 0]);
    expect(arrowSpecs(mo, { ai: 2, pro: 2, mine: 2 }).map((x) => x.color)).toEqual([COLORS.pro, COLORS.ai]); // mine hidden
  });

  it("rings the receiver of a selected pass only", () => {
    expect(selectedReceiver(mo, { selected: 0 })).toBe(1);
    expect(selectedReceiver(mo, { selected: 1 })).toBeNull();
    expect(selectedReceiver(mo, {})).toBeNull();
  });

  it("starts the eyes arrow ahead of the player, ends at the tip, and dashes the selection", () => {
    const solid = eyesArrow([0, 0], [20, 0]);
    expect(solid.length).toBe(18);
    expect(Math.min(...solid.filter((_, i) => i % 2 === 0))).toBeCloseTo(2.5);
    expect([solid[12], solid[13]]).toEqual([20, 0]);
    const dashed = eyesArrow([0, 0], [20, 0], true);
    expect(dashed.length).toBeGreaterThan(18 * 3);
    expect((dashed.length - 6) % 12).toBe(0);
  });

  it("finds shirt numbers in the atlas", () => {
    expect(atlasCell(0)).toEqual([0, 9]);
    expect(atlasCell(23)).toEqual([3, 7]);
    expect(atlasCell(150)).toEqual([9, 0]);
  });
});

describe("picking", () => {
  const norm = (v: V3): V3 => { const n = Math.hypot(...v); return [v[0] / n, v[1] / n, v[2] / n]; };
  const rayTo = (o: V3, p: V3) => norm(sub(p, o));

  it("tells a tap (< 8 px, < 300 ms) from a drag", () => {
    expect(isTap(3, 4, 120)).toBe(true);
    expect(isTap(6, 6, 120)).toBe(false); // 8.5 px
    expect(isTap(0, 0, 300)).toBe(false); // a long press
  });

  it("lists the targets: teammates at release (pass), carry points, the goal mouth", () => {
    expect(pickTargets(mo)).toEqual([
      { k: 0, kind: "pass", at: [30, 10] }, { k: 1, kind: "carry", at: [16, -5] }, { k: 2, kind: "shot", at: [52.5, 0] },
    ]);
  });

  it("hits a generous cylinder around a teammate, up to over his shirt number", () => {
    const o: V3 = [10, 1.7, 5];
    expect(rayCylinder(o, rayTo(o, [30, 1, -10]), [30, 10], 0.9, 2.8)).not.toBeNull();     // his body
    expect(rayCylinder(o, rayTo(o, [30.7, 2.6, -10]), [30, 10], 0.9, 2.8)).not.toBeNull(); // beside, at number height
    expect(rayCylinder(o, rayTo(o, [33, 1, -10]), [30, 10], 0.9, 2.8)).toBeNull();          // 3 m away
    expect(rayCylinder(o, [-1, 0, 0], [30, 10], 0.9, 2.8)).toBeNull();                       // behind the camera
  });

  it("picks the pass, the shot and the carry from camera rays", () => {
    const o: V3 = [10, 1.7, 5], t = pickTargets(mo);
    expect(rayPick(o, rayTo(o, [30.5, 0.4, -10]), t)).toBe(0);
    expect(rayPick(o, rayTo(o, [52.5, 1.2, 2]), t)).toBe(2);   // inside the goal mouth
    expect(rayPick(o, rayTo(o, [16.8, 0, 5.6]), t)).toBe(1);   // on the grass, near the carry point
    expect(rayPick(o, rayTo(o, [10, 8, -40]), t)).toBeNull();  // the sky, far from everything
  });

  it("prefers the nearer of two overlapping targets", () => {
    const o: V3 = [0, 1.7, 0];
    const t = [{ k: 5, kind: "pass" as const, at: [40, 0] as [number, number] }, { k: 6, kind: "pass" as const, at: [20, 0] as [number, number] }];
    expect(rayPick(o, [1, 0, 0], t)).toBe(6);
  });

  it("still picks a small far-away teammate with a near miss", () => {
    const o: V3 = [-40, 1.7, 0], at: [number, number] = [40, 0];
    expect(rayPick(o, rayTo(o, [40, 1.2, -3]), [{ k: 3, kind: "pass", at }])).toBe(3); // ~2 degrees off
  });
});

describe("score badges", () => {
  it("colours the points like 2D (green 100, yellow 50+, grey below)", () => {
    expect([badgeColor(100), badgeColor(50), badgeColor(49)]).toEqual(["#06d6a0", "#ffd166", "#8d99ae"]);
  });

  it("puts one badge over each pass target, the goal and only the best carry", () => {
    const two = { ...mo, options: [...mo.options, { k: 3, kind: "carry", angle: 1, to: [1000, 0] }] } as Moment;
    const b = badgeItems(two, { 0: 100, 1: 20, 2: 60, 3: 40 });
    expect(b.map((x) => [x.k, x.pts, x.color])).toEqual([[0, 100, "#06d6a0"], [2, 60, "#ffd166"], [3, 40, "#8d99ae"]]);
    expect(b[0]!.at).toEqual([30, 10]);
    expect(b[0]!.h).toBeGreaterThan(2.3); // above the shirt number
  });
});

describe("reveal framing", () => {
  it("leaves the view alone when nothing is shown", () => {
    expect(frameTips([0, 0], [], 0.7)).toEqual({ yaw: 0, back: 0, fov: 0 });
  });

  it("turns towards arrows that fit without widening", () => {
    const f = frameTips([0, 0], [[20, 2]], 0.7);
    expect(f.back).toBe(0);
    expect(f.yaw).toBeCloseTo(Math.atan2(2, 20), 6);
  });

  it("widens and steps back when the arrows point sideways", () => {
    const f = frameTips([0, 0], [[0, 15], [20, -3]], 0.7); // one square to his left, one ahead
    expect(f.back).toBe(FRAME_BACK);
    expect(f.fov).toBeGreaterThan(70);
    expect(f.fov).toBeLessThanOrEqual(FOV_MAX);
    expect(f.yaw).toBeGreaterThan(0.5); // turned left, towards the middle of the span
    expect(halfHFov(f.fov, 0.7)).toBeGreaterThan(halfHFov(70, 0.7));
    const pose = eyesPose([0, 0], LOOK_HOME, 70, f);
    expect(pose.fov).toBe(f.fov);
    const behind = sub(pose.position, cmToWorld([0, 0], EYE_HEIGHT));
    expect(Math.hypot(behind[0], behind[2])).toBeCloseTo(FRAME_BACK, 6);
  });
});
