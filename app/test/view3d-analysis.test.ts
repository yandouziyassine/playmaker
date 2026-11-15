// app/test/view3d-analysis.test.ts: the 3D coach analysis' pure part (view3d/analysis.ts): lane blockers and loss point
// as the coach defines them, defender reach, the space-control texture, the arcs, the breakdown, the analysis camera
// framing, camera blends and the screen-space label layout. Plus the reveal's analysis built from a pick result.
import { describe, expect, it } from "vitest";
import type { Moment, PickResult } from "../src/api.ts";
import { passFeatures, type State } from "../src/coach/features.ts";
import { DEFAULT_PC, control } from "../src/coach/pitchControl.ts";
import {
  ANALYSIS_CAM, analysisPose, arcPath, arcWidth, blendPose, breakdown, controlTexture, easeInOut, laneBlockers, layoutLabels,
  leadUpVelocities, lossPoint, mentionsLane, optionEnd, project, reach, sides, type Box,
} from "../src/view3d/analysis.ts";
import { toWorld, type Moment3D, type Vec } from "../src/view3d/geom.ts";
import { revealAnalysis } from "../src/round.ts";

const mo = {
  id: "m", carrier: 0, fps: 10, attack: 1,
  players: [{ side: 0, shirt: 10, name: "A" }, { side: 0, shirt: 9, name: "B" }, { side: 1, shirt: 4, name: "C" }, { side: 1, shirt: 5, name: "D" }],
  lead_up: [
    [[0, 0], [2000, 0], [1000, 500], [3000, 2000]],
    [[0, 0], [2000, 0], [1000, 300], [3000, 2000]],
    [[100, 0], [2000, 0], [1000, 100], [3000, 2000]],
  ],
  ball: [[0, 0], [0, 0], [100, 0]],
  options: [
    { k: 0, kind: "pass", player: 1, to: [0, 0] },
    { k: 1, kind: "carry", angle: 0, to: [700, 0] },
    { k: 2, kind: "shot", to: [5250, 0] },
  ],
  league: "", home: "H", away: "A", attacking: "home", minute: 1, credit: "",
} as unknown as Moment3D;

const boxesOverlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("positions", () => {
  it("splits the release frame by side relative to the carrier, in metres", () => {
    const s = sides(mo);
    expect(s.carrier).toEqual([1, 0]);
    expect(s.att.map((a) => a.i)).toEqual([0, 1]);
    expect(s.def.map((d) => d.i)).toEqual([2, 3]);
    expect(s.def[0]!.at).toEqual([10, 1]);
  });
  it("option ends: the receiver at release, the carry point, the goal mouth of the attacked end", () => {
    expect(optionEnd(mo, 0)).toEqual([20, 0]);
    expect(optionEnd(mo, 1)).toEqual([7, 0]);
    expect(optionEnd(mo, 2)).toEqual([52.5, 0]);
    expect(optionEnd({ ...mo, attack: -1 }, 2)).toEqual([-52.5, 0]);
    expect(optionEnd(mo, 9)).toBeNull();
  });
  it("lead-up velocities over ~0.16 s (2 frames at 10 fps), in m/s", () => {
    const v = leadUpVelocities(mo);
    expect(v[2]![0]).toBeCloseTo(0, 6);
    expect(v[2]![1]).toBeCloseTo(-20, 6); // 400 cm in 0.2 s
    expect(v[0]![0]).toBeCloseTo(5, 6);
    expect(leadUpVelocities({ ...mo, lead_up: [mo.lead_up[0]!] })[2]).toEqual([0, 0]);
  });
});

describe("the why geometry is the coach's", () => {
  it("lane blockers match the coach's lane_defenders count", () => {
    const a: Vec = [0, 0], b: Vec = [20, 0];
    const def = [{ i: 5, at: [10, 1.5] as Vec }, { i: 6, at: [10, 2.5] as Vec }, { i: 7, at: [0.5, 0.5] as Vec }, { i: 8, at: [15, -1] as Vec }];
    expect(laneBlockers(a, b, def)).toEqual([5, 8]); // 2.5 m away: outside; at the passer's end: excluded
    const s = { att: [a, b], attV: [[0, 0], [0, 0]], def: def.map((d) => d.at), defV: def.map(() => [0, 0]), attIdx: [0, 1], defIdx: [5, 6, 7, 8], ball: a, direction: 1 } as State;
    expect(passFeatures(s, 0, 1).lane_defenders).toBe(2);
  });
  it("the loss point is the nearest defender's projection on the lane, none when nobody is within reach", () => {
    expect(lossPoint([0, 0], [20, 0], [[12, 1]])).toEqual([12, 0]);
    expect(lossPoint([0, 0], [20, 0], [[1, 1]])).toEqual([2, 0]); // t clipped to 0.1
    expect(lossPoint([0, 0], [20, 0], [[10, 15]])).toBeNull();
  });
  it("reach: drift with the velocity for the reaction time, then vmax", () => {
    const r = reach([10, 0], [2, 0], 1.5);
    expect(r.at[0]).toBeCloseTo(10 + 2 * DEFAULT_PC.reaction, 9);
    expect(r.r).toBeCloseTo(DEFAULT_PC.vmax * (1.5 - DEFAULT_PC.reaction), 9);
    expect(reach([0, 0], null, 0.3).r).toBe(0);
  });
  it("the space-control texture glows only where the attack controls the point, alpha rising with control", () => {
    const nx = 21, ny = 13, out = new Uint8Array(nx * ny * 4);
    const att: Vec[] = [[-30, 0]], def: Vec[] = [[30, 0]], z: Vec[] = [[0, 0]];
    controlTexture(out, nx, ny, att, z, def, z);
    const alpha = (i: number, j: number) => out[(j * nx + i) * 4 + 3]!;
    const mid = Math.floor(ny / 2);
    expect(alpha(2, mid)).toBeGreaterThan(50);   // near the attacker
    expect(alpha(nx - 3, mid)).toBe(0);           // near the defender
    expect(alpha(2, mid)).toBeGreaterThanOrEqual(alpha(6, mid));
    // the cell centre and the coach's control agree on the side
    const x = -52.5 + (2.5 * 105) / nx, y = -34 + ((mid + 0.5) * 68) / ny;
    expect(control([x, y], att, z, def, z)).toBeGreaterThan(0.5);
  });
});

describe("arcs", () => {
  it("a pass is lofted (peak in the middle), a carry stays on the grass, a shot rises to the goal", () => {
    const pass = arcPath([0, 0], [30, 0], "pass", 10, 0);
    expect(pass[5]![1]).toBeGreaterThan(pass[0]![1] + 1);
    expect(pass[10]![1]).toBeCloseTo(0.04, 6);
    expect(pass[10]).toEqual(toWorld([30, 0], pass[10]![1]));
    const carry = arcPath([0, 0], [6, 0], "carry", 6);
    expect(Math.max(...carry.map((p) => p[1]))).toBeCloseTo(0.04, 6);
    const shot = arcPath([30, 0], [52.5, 0], "shot", 10, 0);
    expect(shot[10]![1]).toBeGreaterThan(1);
  });
  it("width grows with the completion chance for the option looked at; the others are thin", () => {
    expect(arcWidth(0.9, true)).toBeGreaterThan(arcWidth(0.3, true));
    expect(arcWidth(0.9, false)).toBe(arcWidth(0.1, false));
    expect(arcWidth(0.9, true, true)).toBeLessThan(arcWidth(0.9, true));
  });
});

describe("breakdown", () => {
  it("net = p * gain + (1 - p) * loss when the score is not given, the score otherwise", () => {
    expect(breakdown({ p: 0.8, gain: 0.05, loss: -0.02 }).net).toBeCloseTo(0.8 * 0.05 + 0.2 * -0.02, 12);
    expect(breakdown({ p: 0.8, gain: 0.05, loss: -0.02, score: 0.1 }).net).toBe(0.1);
    expect(breakdown({}).net).toBeNull();
  });
  it("detects reasons that already talk about the lane (English and French)", () => {
    expect(mentionsLane([{ text: "no defender in the lane" }])).toBe(true);
    expect(mentionsLane([{ text: "1 défenseur sur la trajectoire" }])).toBe(true);
    expect(mentionsLane([{ text: "short pass (6 m)" }])).toBe(false);
  });
});

describe("the analysis camera", () => {
  const inside = (pts: Vec[], attack: 1 | -1, aspect: number) => {
    const pose = analysisPose(pts, attack, aspect);
    return pts.map((p) => project(toWorld(p, 0.9), pose.position, pose.target, pose.fov, aspect)!);
  };
  it.each([[1, 0.66], [-1, 0.66], [1, 1.6]] as const)("frames every point inside the margins (attack %i, aspect %f)", (attack, aspect) => {
    const pts: Vec[] = [[-10, -20], [25, 15], [5, 30], [-30, 5]].map(([x, y]) => [x! * attack, y! * attack] as Vec);
    for (const q of inside(pts, attack, aspect)) {
      expect(Math.abs(q[0])).toBeLessThanOrEqual(ANALYSIS_CAM.margin.x + 1e-6);
      expect(q[1]).toBeLessThanOrEqual(ANALYSIS_CAM.margin.top + 1e-6);
      expect(q[1]).toBeGreaterThanOrEqual(ANALYSIS_CAM.margin.bottom - 1e-6);
    }
  });
  it("looks from behind the attack, so the attack runs up the screen", () => {
    for (const attack of [1, -1] as const) {
      const [a, b] = inside([[0, 0], [20 * attack, 0]], attack, 0.66);
      expect(b![1]).toBeGreaterThan(a![1]);
      const pose = analysisPose([[0, 0]], attack, 0.66);
      expect(Math.sign(pose.target[0] - pose.position[0])).toBe(attack);
    }
  });
  it("comes closer for a tight group than for a spread one", () => {
    const d = (pts: Vec[]) => { const p = analysisPose(pts, 1, 0.66); return Math.hypot(p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]); };
    expect(d([[0, 0], [8, 3]])).toBeLessThan(d([[-30, -25], [40, 25]]));
  });
  it("project: centre of view at 0, behind the camera null", () => {
    expect(project([10, 0, 0], [0, 0, 0], [10, 0, 0], 50, 1)).toEqual([0, 0]);
    expect(project([-10, 0, 0], [0, 0, 0], [10, 0, 0], 50, 1)).toBeNull();
  });
  it("camera moves blend position, aim and fov with an eased progress", () => {
    const a = { position: [0, 10, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 40 };
    const b = { position: [10, 20, 0] as [number, number, number], target: [5, 0, 0] as [number, number, number], fov: 60 };
    expect(blendPose(a, b, 0)).toEqual(a);
    expect(blendPose(a, b, 1)).toEqual(b);
    expect(blendPose(a, b, 0.5).fov).toBeCloseTo(50, 9);
    expect(easeInOut(0.25)).toBeLessThan(0.25);
    expect(easeInOut(2)).toBe(1);
  });
});

describe("label layout", () => {
  const view = { w: 380, h: 560 };
  it("labels near the same point never overlap each other", () => {
    const items = [0, 1, 2, 3].map(() => ({ x: 190, y: 280, w: 90, h: 24 }));
    const boxes = layoutLabels(items, view);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(boxesOverlap(boxes[i]!, boxes[j]!)).toBe(false);
  });
  it("stays inside the view and clears the buttons", () => {
    const corner: Box = { x: 0, y: 0, w: 200, h: 60 };
    const [b] = layoutLabels([{ x: 20, y: 20, w: 100, h: 24 }], view, [corner]);
    expect(b!.x).toBeGreaterThanOrEqual(0); expect(b!.y).toBeGreaterThanOrEqual(0);
    expect(boxesOverlap(b!, corner)).toBe(false);
    const [c] = layoutLabels([{ x: 378, y: 558, w: 100, h: 24 }], view);
    expect(c!.x + c!.w).toBeLessThanOrEqual(view.w); expect(c!.y + c!.h).toBeLessThanOrEqual(view.h);
  });
  it("keeps the first label next to its anchor (above it when there is room) and off the other targets", () => {
    const boxes = layoutLabels([{ x: 190, y: 300, w: 80, h: 24 }, { x: 190, y: 268, w: 40, h: 20 }], view);
    expect(boxes[0]!.y + boxes[0]!.h).toBeLessThanOrEqual(300);
    const anchor2: Box = { x: 184, y: 262, w: 12, h: 12 };
    expect(boxesOverlap(boxes[0]!, anchor2)).toBe(false);
  });
});

describe("the reveal's analysis", () => {
  const res = {
    option: 1, points: 40, among_best: false, pro_instinct: false, ai_pick: 0, pro_pick: 0,
    outcome: { kind: "kept", net_xg_15s: 0 }, crowd: null, repeat: false, all_points: { 0: 100, 1: 40, 2: 10 }, after: null, guess: null, guess_right: null,
    reasons: {
      0: [{ text: "no defender in the lane", effect: 1 }, { text: "+0.021 xG if it arrives, -0.010 if lost there", effect: 0 }],
      1: [{ text: "64 % pitch control where the carry ends", effect: 0 }, { text: "+0.004 xG if kept, -0.030 if lost there", effect: 0 }],
    },
    coach: { 0: { p: 0.9, score: 0.018 }, 1: { p: 0.64, score: -0.008 }, 2: { p: 0.05, score: 0.01 } },
  } as unknown as PickResult;
  it("one tab per distinct option (the AI and the pro merged), numbers from the coach", () => {
    const a = revealAnalysis(mo as unknown as Moment, res, 1);
    expect(a.options.map((o) => o.k)).toEqual([0, 1]);
    expect(a.options[0]!.tag).toBe("AI coach · The pro");
    expect(a.options[0]!).toMatchObject({ p: 0.9, score: 0.018, gain: 0.021, loss: -0.01, tab: "Pass No. 9" });
    expect(a.options[1]!).toMatchObject({ tag: "You", tab: "Carry", gain: 0.004, loss: -0.03 });
    expect(a.options[0]!.reasons[0]).toEqual({ text: "no defender in the lane", sign: 1 });
  });
  it("works without the coach numbers (older server): no p / score", () => {
    const a = revealAnalysis(mo as unknown as Moment, { ...res, coach: undefined }, 2);
    expect(a.options[1]!.p).toBeUndefined();
    expect(a.options[1]!.tab).toBe("Shot");
  });
});
