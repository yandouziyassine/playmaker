// The AI coach on one picture: State building from the Lab's mapped points, and a synthetic 11 v 11 frozen frame.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coachFromModels, type ModelsJson } from "../src/coach/models.ts";
import { advise, carryDirection, optionTitle, signedXg, stateFromPicture, successLabel, toPicture, type PitchPt, type Team } from "../src/coach/picture.ts";

const models: ModelsJson = JSON.parse(readFileSync(new URL("../public/coach/models.json", import.meta.url), "utf8"));
const coach = coachFromModels(models);

describe("stateFromPicture", () => {
  // index: 0 carrier (team 0), 1 mate (team 0), 2 opponent (team 1), 3 referee ("other"), 4 off the map, 5 opponent
  const pos: (PitchPt | null)[] = [{ x: 10, y: -5 }, { x: 20, y: 8 }, { x: 15, y: 0 }, { x: 12, y: 3 }, null, { x: -30, y: 20 }];
  const teams: Team[] = [0, 0, 1, "other", 1, 1];

  it("carrier's team attacks, the other team defends, 'other' and unmapped players are ignored", () => {
    const ps = stateFromPicture(pos, teams, 0, 1)!;
    expect(ps.state.attIdx).toEqual([0, 1]);
    expect(ps.state.defIdx).toEqual([2, 5]);
    expect(ps.carrierRow).toBe(0);
    expect(ps.state.att).toEqual([[10, -5], [20, 8]]);
    expect(ps.state.ball).toEqual([10, -5]);
    expect(ps.state.direction).toBe(1);
  });

  it("velocities are zeros (a single picture)", () => {
    const ps = stateFromPicture(pos, teams, 0, 1)!;
    expect(ps.state.attV).toEqual([[0, 0], [0, 0]]);
    expect(ps.state.defV).toEqual([[0, 0], [0, 0]]);
  });

  it("attacking the left goal rotates by 180° (attack towards +x, the carrier's left stays +y)", () => {
    const ps = stateFromPicture(pos, teams, 0, -1)!;
    expect(ps.state.att).toEqual([[-10, 5], [-20, -8]]);
    expect(ps.state.def).toEqual([[-15, -0], [30, -20]]);
    expect(ps.state.direction).toBe(-1);
    // and back to picture metres
    expect(toPicture(ps.state.att[1]!, -1)).toEqual({ x: 20, y: 8 });
  });

  it("team 1 can carry: then team 0 defends", () => {
    const ps = stateFromPicture(pos, teams, 5, 1)!;
    expect(ps.state.attIdx).toEqual([2, 5]);
    expect(ps.state.defIdx).toEqual([0, 1]);
    expect(ps.carrierRow).toBe(1);
  });

  it("clamps positions to the pitch (feet mapped a little outside the lines)", () => {
    const ps = stateFromPicture([{ x: 54, y: -35.5 }, { x: 0, y: 0 }], [0, 1], 0, 1)!;
    expect(ps.state.att[0]).toEqual([52.5, -34]);
  });

  it("returns null for an unusable carrier", () => {
    expect(stateFromPicture(pos, teams, 3, 1)).toBeNull(); // referee
    expect(stateFromPicture(pos, teams, 4, 1)).toBeNull(); // not on the map
    expect(stateFromPicture(pos, teams, 9, 1)).toBeNull(); // no such player
  });
});

describe("advise on a synthetic 11 v 11", () => {
  // 4-4-2 attacking the right goal against a 4-4-2 block, carrier = a central midfielder
  const attack: [number, number][] = [[-45, 0], [-15, -25], [-20, -8], [-20, 8], [-15, 25], [5, -22], [0, -6], [2, 7], [6, 22], [25, -5], [27, 6]];
  const defend: [number, number][] = [[50, 0], [35, -20], [33, -6], [33, 6], [35, 20], [18, -18], [15, -5], [15, 6], [18, 17], [3, -2], [5, 10]];
  const pos: PitchPt[] = [...attack, ...defend].map(([x, y]) => ({ x, y }));
  const teams: Team[] = [...attack.map(() => 0 as const), ...defend.map(() => 1 as const)];
  const carrier = 6;

  it("ranks every pass and carry, best first, with an explanation each", () => {
    const a = advise(stateFromPicture(pos, teams, carrier, 1)!, coach, models)!;
    const n = 10 + models.advice.carry_angles_deg.length; // 10 teammates + carries; no shot from 46 m
    expect(a.ranked.length).toBe(n);
    const scores = a.ranked.map((r) => r.option.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    for (const r of a.ranked) {
      expect(r.option.p).toBeGreaterThanOrEqual(0); expect(r.option.p).toBeLessThanOrEqual(1);
      expect(Number.isFinite(r.option.score)).toBe(true);
      expect(r.why.phrases.length).toBeGreaterThan(0);
      expect(r.why.phrases.length).toBe(r.why.signs.length);
    }
    const passTargets = a.ranked.filter((r) => r.option.kind === "pass").map((r) => r.option.target).sort((x, y) => x! - y!);
    expect(passTargets).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 9, 10]);
  });

  it("a pass arrow ends on the receiver in picture metres, for both directions", () => {
    for (const dir of [1, -1] as const) {
      // mirror the whole picture when attacking left so the football is the same
      const p = dir === 1 ? pos : pos.map((q) => ({ x: -q.x, y: -q.y }));
      const a = advise(stateFromPicture(p, teams, carrier, dir)!, coach, models)!;
      const pass = a.ranked.find((r) => r.option.kind === "pass")!;
      const t = p[pass.option.target!]!;
      expect(pass.to.x).toBeCloseTo(t.x, 9); expect(pass.to.y).toBeCloseTo(t.y, 9);
      if (dir === -1) {
        const right = advise(stateFromPicture(pos, teams, carrier, 1)!, coach, models)!;
        expect(a.ranked.map((r) => r.option.score)).toEqual(right.ranked.map((r) => r.option.score));
      }
    }
  });

  it("offers the shot near the goal", () => {
    const near = pos.map((q, i) => (i === 10 ? { x: 40, y: 2 } : q));
    const a = advise(stateFromPicture(near, teams, 10, 1)!, coach, models)!;
    expect(a.ranked.some((r) => r.option.kind === "shot")).toBe(true);
  });

  it("needs at least one defender on the map", () => {
    expect(advise(stateFromPicture(pos.slice(0, 11), teams.slice(0, 11), carrier, 1)!, coach, models)).toBeNull();
  });
});

describe("labels", () => {
  it("formats options like the site", () => {
    expect(optionTitle({ kind: "pass", target: 6, to: [0, 0], p: 0.72, value: 0, score: 0.0123 })).toBe("Pass to #7");
    expect(optionTitle({ kind: "carry", angle: -30, to: [0, 0], p: 0.9, value: 0, score: 0 })).toBe("Carry 30° right");
    expect(successLabel({ kind: "shot", to: [0, 0], p: 0.081, value: 1, score: 0 })).toBe("8 % goal chance");
    expect(signedXg(-0.0006)).toBe("-0.001 xG");
    expect(signedXg(0.0125)).toBe("+0.013 xG");
    expect(carryDirection(0)).toBe("straight ahead");
  });
});
