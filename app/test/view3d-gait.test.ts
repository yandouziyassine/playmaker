// app/test/view3d-gait.test.ts: the 3D footballer figures' pure maths (no WebGL): the gait from the speed, the stride
// phase, the pose angles, the instance matrices of the body parts, kit and skin colours.
import { describe, expect, it } from "vitest";
import {
  BODY, HIP_H, IDLE_MS, LIMBS, LIMB_ORDER, SKIN_TONES, SPRINT_MS, WALK_MS, accelLean, advancePhase, apply, figureMatrices, gaitOf,
  gaitParams, hipHeight, identity, interp, kitColors, luminance, mul, poseAt, rootMatrix, rotationY, rotationZ, scaling, skinTone,
  strideLength, translation,
} from "../src/view3d/gait.ts";

const close = (a: ArrayLike<number>, b: ArrayLike<number>, d = 5) => [...Array.from(a)].forEach((v, i) => expect(v).toBeCloseTo(b[i]!, d));

describe("the gait from the speed", () => {
  it("names the gait: idle under 0.3 m/s, walk under 2, run under 6, sprint above", () => {
    expect([0, 0.29, 0.3, 1.9, 2, 5.9, 6, 9].map(gaitOf)).toEqual(["idle", "idle", "walk", "walk", "run", "run", "sprint", "sprint"]);
  });
  it("interpolates through knots and clamps at both ends", () => {
    const k = [[0, 0], [2, 1], [4, 5]] as const;
    expect(interp(-1, k)).toBe(0);
    expect(interp(1, k)).toBeCloseTo(0.5);
    expect(interp(3, k)).toBeCloseTo(3);
    expect(interp(10, k)).toBe(5);
  });
  it("grows every amplitude with the speed: standing still, walking, running, sprinting", () => {
    const [still, walk, run, sprint] = [0, 1.2, 4, 7.5].map((v) => gaitParams(v));
    expect(still!.legAmp).toBe(0);
    expect(still!.armAmp).toBe(0);
    expect(still!.bounce).toBe(0);
    for (const key of ["legAmp", "armAmp", "knee", "elbow", "lean", "stride"] as const) {
      expect(walk![key]).toBeGreaterThan(still![key]);
      expect(run![key]).toBeGreaterThan(walk![key]);
      expect(sprint![key]).toBeGreaterThan(run![key]);
    }
    expect(run!.elbow).toBeGreaterThan(1);          // arms bent when running
    expect(sprint!.legAmp).toBeLessThan(1);         // never a split
  });
  it("is continuous across the walk / run / sprint thresholds", () => {
    for (const v of [IDLE_MS, WALK_MS, SPRINT_MS]) {
      const a = gaitParams(v - 1e-6), b = gaitParams(v + 1e-6);
      expect(Math.abs(a.legAmp - b.legAmp)).toBeLessThan(1e-4);
      expect(Math.abs(a.knee - b.knee)).toBeLessThan(1e-4);
    }
  });
  it("stands still with reduced motion, whatever the speed", () => {
    const g = gaitParams(7, true);
    expect(g.gait).toBe("idle");
    expect([g.legAmp, g.armAmp, g.lean, g.bounce]).toEqual([0, 0, 0, 0]);
  });
  it("lengthens the stride with the speed, so the cadence rises less than the speed", () => {
    expect(strideLength(1.2)).toBeCloseTo(1.44);
    expect(strideLength(0)).toBe(1.2);
    expect(strideLength(20)).toBe(4.3);
    const cadence = (v: number) => v / strideLength(v);
    expect(cadence(7)).toBeGreaterThan(cadence(3));
    expect(cadence(7) / cadence(3)).toBeLessThan(7 / 3);
  });
});

describe("the stride phase", () => {
  it("advances by 2 pi per stride length run, wrapped to [0, 2 pi)", () => {
    const L = strideLength(4);
    expect(advancePhase(0, L / 4, 4)).toBeCloseTo(Math.PI / 2);
    expect(advancePhase(0, L, 4)).toBeCloseTo(0);
    expect(advancePhase(6, L / 2, 4)).toBeCloseTo(6 + Math.PI - 2 * Math.PI);
  });
  it("freezes when standing, when nothing was run, and with reduced motion", () => {
    expect(advancePhase(1, 1, 0.1)).toBe(1);
    expect(advancePhase(1, 0, 5)).toBe(1);
    expect(advancePhase(1, 1, 5, true)).toBe(1);
  });
  it("leans forward when accelerating, a little back when braking, capped", () => {
    expect(accelLean(0)).toBe(0);
    expect(accelLean(2)).toBeCloseTo(0.07);
    expect(accelLean(50)).toBe(0.14);
    expect(accelLean(-50)).toBe(-0.06);
  });
});

describe("the pose angles", () => {
  const g = gaitParams(4);
  it("swings the legs in antiphase and each arm against its leg", () => {
    for (const ph of [0.3, 1.2, 2.5, 4, 5.5]) {
      const a = poseAt(ph, g);
      expect(a.hipR).toBeCloseTo(-a.hipL);
      expect(a.shoulderL).toBeCloseTo(-a.hipL * (g.armAmp / g.legAmp));
      expect(a.shoulderR).toBeCloseTo(-a.shoulderL);
    }
    expect(poseAt(Math.PI / 2, g).hipL).toBeCloseTo(g.legAmp); // full forward swing of the left leg
  });
  it("bends the knee of the leg swinging forward and keeps the planted one nearly straight", () => {
    const a = poseAt(0, g); // left leg swinging forward through the middle
    expect(a.kneeL).toBeCloseTo(g.knee + 0.06);
    expect(a.kneeR).toBeCloseTo(0.06);
    const b = poseAt(Math.PI, g);
    expect(b.kneeR).toBeCloseTo(g.knee + 0.06);
  });
  it("adds the acceleration lean and bounces at mid-stride only", () => {
    expect(poseAt(0, g, 0.1).lean).toBeCloseTo(g.lean + 0.1);
    expect(poseAt(0, g).bob).toBeCloseTo(0);
    expect(poseAt(Math.PI / 2, g).bob).toBeCloseTo(g.bounce);
  });
  it("stands straight and still when idle", () => {
    const a = poseAt(1.3, gaitParams(0));
    expect([a.hipL, a.hipR, a.shoulderL, a.shoulderR, a.lean, a.bob]).toEqual([0, -0, -0, 0, 0, 0]);
    expect(hipHeight(a)).toBeCloseTo(BODY.thigh * 1 + BODY.shin * Math.cos(0.06) + BODY.sole, 6);
  });
});

describe("matrices", () => {
  it("compose like three.js: column-major, a * b applies b first", () => {
    const m = mul(translation(1, 2, 3), scaling(2, 2, 2));
    expect(apply(m, 1, 0, 0)).toEqual([3, 2, 3]);
    close(mul(identity(), rotationZ(0.4)), rotationZ(0.4));
    close(apply(rotationY(Math.PI / 2), 1, 0, 0), [0, 0, -1]);     // the heading turns +x towards world -z (pitch +y)
    close(apply(rotationZ(0.3), 0, -1, 0), [Math.sin(0.3), -Math.cos(0.3), 0]); // a positive limb angle swings forward
  });
  it("places the root on the grass at (x, z), turned to the heading, scaled (0 hides the figure)", () => {
    close(apply(rootMatrix(5, -3, 0), 1, 0, 0), [6, 0, -3]);
    close(apply(rootMatrix(5, -3, Math.PI), 1, 0, 0), [4, 0, -3]);
    expect([...rootMatrix(5, -3, 1, 0)].slice(0, 11).every((v) => Math.abs(v) < 1e-9)).toBe(true);
  });
});

describe("the figure's instance matrices", () => {
  const still = poseAt(0, gaitParams(0));
  const f = figureMatrices(rootMatrix(0, 0, 0), still);
  it("gives one matrix per part and LIMBS limbs in LIMB_ORDER", () => {
    expect(f.limbs).toHaveLength(LIMBS);
    expect(LIMB_ORDER).toHaveLength(LIMBS);
  });
  it("stands a figure about 1.8 m tall with his soles on the grass", () => {
    const headTop = apply(f.head, 0, 1, 0)[1];
    expect(headTop).toBeGreaterThan(1.7);
    expect(headTop).toBeLessThan(1.9);
    const ankle = apply(f.limbs[2]!, 0, -1, 0); // the left shin's far end
    expect(ankle[1]).toBeCloseTo(BODY.sole, 2);
    expect(HIP_H).toBeCloseTo(0.94);
  });
  it("puts the left limbs on the left (-z) and the right ones on the right", () => {
    expect(apply(f.limbs[0]!, 0, 0, 0)[2]).toBeCloseTo(-BODY.hipW);
    expect(apply(f.limbs[1]!, 0, 0, 0)[2]).toBeCloseTo(BODY.hipW);
    expect(apply(f.limbs[6]!, 0, 0, 0)[2]).toBeLessThan(0);
    expect(apply(f.limbs[7]!, 0, 0, 0)[2]).toBeGreaterThan(0);
  });
  it("chains the joints: the shin starts at the thigh's end, the forearm at the upper arm's end", () => {
    const a = poseAt(1, gaitParams(5)), m = figureMatrices(rootMatrix(2, 3, 0.7), a);
    close(apply(m.limbs[0]!, 0, -1, 0), apply(m.limbs[2]!, 0, 0, 0), 4);
    close(apply(m.limbs[1]!, 0, -1, 0), apply(m.limbs[3]!, 0, 0, 0), 4);
    close(apply(m.limbs[6]!, 0, -1, 0), apply(m.limbs[8]!, 0, 0, 0), 4);
    close(apply(m.limbs[2]!, 0, -1, 0), apply(m.limbs[4]!, 0, 0, 0), 4); // the shoe hangs from the ankle
  });
  it("swings the left foot forward of the right at a quarter stride, in the facing direction", () => {
    const a = poseAt(Math.PI / 2, gaitParams(5));
    for (const heading of [0, 1.1, -2.5]) {
      const m = figureMatrices(rootMatrix(0, 0, heading), a);
      const l = apply(m.limbs[2]!, 0, -1, 0), r = apply(m.limbs[3]!, 0, -1, 0);
      const fwd = [Math.cos(heading), -Math.sin(heading)]; // world x, z of the facing
      expect((l[0] - r[0]) * fwd[0]! + (l[2] - r[2]) * fwd[1]!).toBeGreaterThan(0.4);
    }
  });
  it("keeps the lower foot on the grass while running", () => {
    for (const ph of [0.2, 1, 2.2, 3.6, 5]) {
      const a = { ...poseAt(ph, gaitParams(5)), bob: 0 }, m = figureMatrices(rootMatrix(0, 0, 0), a);
      const low = Math.min(apply(m.limbs[2]!, 0, -1, 0)[1], apply(m.limbs[3]!, 0, -1, 0)[1]);
      expect(low).toBeCloseTo(BODY.sole, 4);
    }
  });
  it("leans the head forward when the upper body leans", () => {
    const a = poseAt(0, gaitParams(0), 0.15), m = figureMatrices(rootMatrix(0, 0, 0), a);
    expect(apply(m.head, 0, 0, 0)[0]).toBeGreaterThan(apply(f.head, 0, 0, 0)[0] + 0.05);
  });
  it("scales the parts to the body sizes (limb radius and length)", () => {
    const thigh = f.limbs[0]!;
    expect(Math.hypot(thigh[0]!, thigh[1]!, thigh[2]!)).toBeCloseTo(2 * BODY.thighR, 5);
    expect(Math.hypot(thigh[4]!, thigh[5]!, thigh[6]!)).toBeCloseTo(BODY.thigh, 5);
  });
});

describe("kit and skin colours", () => {
  it("measures luminance", () => {
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(luminance("#000")).toBe(0);
    expect(luminance("#ef476f")).toBeLessThan(0.45);
  });
  it("gives contrasting shorts and matching socks; keepers their side's colour", () => {
    expect(kitColors("#f1faee")).toEqual({ shirt: "#f1faee", shorts: "#1f2a3a", socks: "#f1faee" });
    expect(kitColors("#c8102e").shorts).toBe("#f2f2f2");
    expect(kitColors("#c8102e", true, 1).shirt).not.toBe("#c8102e");
  });
  it("keeps a player's skin tone and uses several tones", () => {
    expect(skinTone(4)).toBe(skinTone(4));
    expect(new Set(Array.from({ length: 22 }, (_, i) => skinTone(i))).size).toBeGreaterThanOrEqual(3);
    expect(SKIN_TONES).toContain(skinTone(17));
  });
});
