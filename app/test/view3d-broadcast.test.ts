// app/test/view3d-broadcast.test.ts: the reveal's broadcast camera (damping, look-ahead, reduced motion), the eyes
// turning towards the ball, the arrows fading over the replay, the ball's shadow, and the name labels' distance rule.
import { describe, expect, it } from "vitest";
import {
  BROADCAST, LABEL_MAX_M, STADIUM, arrowFade, ballShadow, broadcastFollow, eyesFollowYaw, goalOf, labelVisible, surname, type Follow, type Vec,
} from "../src/view3d/geom.ts";

const run = (st: Follow, ball: (t: number) => Vec, vel: Vec, seconds: number, dt = 1 / 60, reduced = false): Follow => {
  for (let t = 0; t < seconds; t += dt) st = broadcastFollow(st, ball(t), vel, dt, reduced);
  return st;
};

describe("the broadcast follow", () => {
  it("damps towards a still ball: 63 % of the gap after tau, frame-rate independent", () => {
    const st: Follow = { focus: [0, 0], vel: [0, 0] };
    const a = run(st, () => [10, 0], [0, 0], BROADCAST.tau, 1 / 60), b = run(st, () => [10, 0], [0, 0], BROADCAST.tau, 1 / 144);
    expect(a.focus[0]).toBeCloseTo(10 * (1 - Math.exp(-1)), 1);
    expect(b.focus[0]).toBeCloseTo(a.focus[0], 1);
    expect(run(st, () => [10, 0], [0, 0], 5).focus[0]).toBeCloseTo(10, 2);
  });

  it("leads a moving ball along its velocity, capped at maxLead", () => {
    const v: Vec = [8, 0], ball = (t: number): Vec => [v[0] * t, 0];
    const st = run({ focus: [0, 0], vel: [0, 0] }, ball, v, 3);
    expect(st.vel[0]).toBeCloseTo(8, 2);                         // the smoothed velocity has caught up
    expect(st.focus[0]).toBeGreaterThan(ball(3)[0]);             // the aim runs ahead of the ball
    const fast = run({ focus: [0, 0], vel: [0, 0] }, () => [0, 0], [40, 0], 6);
    expect(fast.focus[0]).toBeCloseTo(BROADCAST.maxLead, 1);     // 40 m/s x 0.7 s = 28 m, capped at 10 m
    expect(fast.focus[1]).toBeCloseTo(0, 6);
  });

  it("smooths the velocity, so one jerky frame barely moves the aim", () => {
    const st = broadcastFollow({ focus: [0, 0], vel: [0, 0] }, [0, 0], [30, 0], 1 / 60);
    expect(st.vel[0]).toBeLessThan(2);
  });

  it("cuts on a jump larger than the stadium snap", () => {
    const st = broadcastFollow({ focus: [0, 0], vel: [0, 0] }, [STADIUM.snap + 5, 0], [0, 0], 1 / 60);
    expect(st.focus).toEqual([STADIUM.snap + 5, 0]);
  });

  it("with reduced motion (or no time step) the camera does not move", () => {
    const st: Follow = { focus: [3, 4], vel: [1, 1] };
    expect(run(st, () => [30, -10], [10, 0], 2, 1 / 60, true)).toBe(st);
    expect(broadcastFollow(st, [30, -10], [10, 0], 0)).toBe(st);
  });
});

describe("the eyes during the replay", () => {
  const goal = goalOf(1);
  it("turn towards the ball, damped, relative to the goal direction", () => {
    let yaw = 0;
    for (let i = 0; i < 300; i++) yaw = eyesFollowYaw(yaw, [0, 0], [0, 20], 1 / 60, false, goal); // ball 90 degrees to the left
    expect(yaw).toBeCloseTo(Math.PI / 2, 3);
    const one = eyesFollowYaw(0, [0, 0], [0, 20], 1 / 60, false, goal);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(0.2);                               // not a snap
  });
  it("hold still with reduced motion, or when the ball is at his feet", () => {
    expect(eyesFollowYaw(0.3, [0, 0], [0, 20], 1 / 60, true, goal)).toBe(0.3);
    expect(eyesFollowYaw(0.3, [0, 0], [1, 1], 1 / 60, false, goal)).toBe(0.3);
  });
});

describe("the arrows over the replay", () => {
  it("stay at the start, fade out as it runs, are gone near the end; full outside the replay", () => {
    expect(arrowFade(undefined)).toBe(1);
    expect(arrowFade(0)).toBe(1);
    expect(arrowFade(0.15)).toBe(1);
    expect(arrowFade(0.5)).toBeCloseTo(0.5, 6);
    expect(arrowFade(0.85)).toBe(0);
    expect(arrowFade(1)).toBe(0);
    for (let p = 0; p < 1; p += 0.05) expect(arrowFade(p + 0.05)).toBeLessThanOrEqual(arrowFade(p));
  });
});

describe("the ball's shadow", () => {
  it("is a plain blob on the grass and grows wider and fainter as the ball rises", () => {
    expect(ballShadow(0.11).scale).toBeCloseTo(1.011, 2);
    expect(ballShadow(6).scale).toBeGreaterThan(ballShadow(1).scale);
    expect(ballShadow(6).opacity).toBeLessThan(ballShadow(1).opacity);
    expect(ballShadow(40)).toEqual(ballShadow(12));               // capped
    expect(ballShadow(40).opacity).toBeGreaterThan(0.3);          // still visible under a high ball
  });
});

describe("name labels", () => {
  it("are hidden farther than 45 m in the eyes and stadium views, all shown in tactical", () => {
    expect(LABEL_MAX_M).toBe(45);
    for (const mode of ["eyes", "stadium"] as const) {
      expect(labelVisible(mode, 10)).toBe(true);
      expect(labelVisible(mode, 45)).toBe(true);
      expect(labelVisible(mode, 45.5)).toBe(false);
    }
    expect(labelVisible("tactical", 90)).toBe(true);
  });
  it("show the surname from the match sheet", () => {
    expect(surname("D. Ginczek")).toBe("Ginczek");
    expect(surname("Matthias Zimmermann")).toBe("Zimmermann");
    expect(surname("Kevin De Bruyne")).toBe("De Bruyne");
    expect(surname("Ronaldinho")).toBe("Ronaldinho");
    expect(surname("  ")).toBe("");
  });
});
