import { describe, expect, it } from "vitest";
import { countTeam, focusTiles, fullScanDue, hungarian, kInit, kMahalanobis2, kPredict, kStep, kUpdate, majority, newTracker, suspend, trackPos, uncovered, type KDet, type KTracker } from "../src/lab/ktrack.ts";
import type { Lab } from "../src/lab/teams.ts";

const total = (c: number[][], a: number[]) => a.reduce((s, j, i) => s + (j >= 0 ? c[i]![j]! : 0), 0);

describe("hungarian", () => {
  it("solves a known 3 x 3 matrix", () => {
    const c = [[4, 1, 3], [2, 0, 5], [3, 2, 2]];
    const a = hungarian(c);
    expect(a).toEqual([1, 0, 2]);
    expect(total(c, a)).toBe(5);
  });
  it("beats the greedy choice", () => {
    // greedy takes (0,0)=1 then (1,1)=10: 11; optimal (0,1)+(1,0) = 2 + 2 = 4
    const c = [[1, 2], [2, 10]];
    expect(hungarian(c)).toEqual([1, 0]);
  });
  it("handles rectangular matrices both ways", () => {
    const wide = [[5, 1, 9], [1, 5, 9]];
    expect(hungarian(wide)).toEqual([1, 0]);
    const tall = [[5, 1], [1, 5], [0, 0]];
    const a = hungarian(tall);
    expect(a.filter((j) => j >= 0)).toHaveLength(2);
    expect(total(tall, a)).toBe(1); // (0,1)=1 + (2,0)=0 (or (1,0) 1 + (2,1) 0)
  });
  it("matches brute force on random 5 x 5 matrices", () => {
    let s = 3;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const perms = (n: number): number[][] => (n === 0 ? [[]] : perms(n - 1).flatMap((p) => Array.from({ length: n }, (_, k) => [...p.slice(0, k), n - 1, ...p.slice(k)])));
    for (let r = 0; r < 20; r++) {
      const c = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => Math.round(rnd() * 100)));
      const best = Math.min(...perms(5).map((p) => total(c, p)));
      expect(total(c, hungarian(c))).toBe(best);
    }
  });
});

describe("constant-velocity Kalman filter", () => {
  it("predicts with the velocity and grows the uncertainty", () => {
    const s = { x: [0, 0, 2, -1], P: kInit({ x: 0, y: 0 }).P };
    const p = kPredict(s, 0.5);
    expect(p.x[0]).toBeCloseTo(1); expect(p.x[1]).toBeCloseTo(-0.5);
    expect(p.P[0]!).toBeGreaterThan(s.P[0]!);
  });
  it("learns a constant velocity from position measurements", () => {
    let s = kInit({ x: 0, y: 0 });
    for (let k = 1; k <= 15; k++) s = kUpdate(kPredict(s, 0.2), { x: 3 * 0.2 * k, y: 1 });
    expect(s.x[2]).toBeCloseTo(3, 0);
    expect(s.x[0]).toBeCloseTo(9, 0);
    expect(s.x[1]).toBeCloseTo(1, 1);
  });
  it("an update pulls the state towards the measurement and shrinks the covariance", () => {
    const p = kPredict(kInit({ x: 0, y: 0 }), 1);
    const u = kUpdate(p, { x: 2, y: 0 });
    expect(u.x[0]!).toBeGreaterThan(0); expect(u.x[0]!).toBeLessThan(2);
    expect(u.P[0]!).toBeLessThan(p.P[0]!);
    expect(kMahalanobis2(p, { x: 0, y: 0 })).toBe(0);
  });
});

describe("team majority vote", () => {
  it("keeps the label seen most often over the track's life", () => {
    let c: [number, number, number] = [0, 0, 0];
    for (const l of [1, 1, 0, 1, "other", 0, 1] as const) c = countTeam(c, l);
    expect(c).toEqual([2, 4, 1]);
    expect(majority(c)).toBe(1);
    expect(majority([0, 0, 3])).toBe("other");
  });
});

const red: Lab = [40, 60, 40], white: Lab = [95, 0, 0];
const det = (x: number, y: number, team: 0 | 1, lab: Lab): KDet => ({ p: { x, y }, team, lab });

describe("kStep tracker", () => {
  it("keeps identities of two crossing players (velocity + colour)", () => {
    let tr: KTracker = newTracker();
    const ids: number[][] = [];
    for (let k = 0; k <= 10; k++) {
      const t = k * 0.2;
      // A runs right, B runs left, same y: they cross at t = 1
      const r = kStep(tr, [det(-5 + 5 * t, 0, 0, red), det(5 - 5 * t, 0.3, 1, white)], t);
      tr = r.tracker; ids.push(r.byDet.map((x) => x.id));
    }
    expect(new Set(ids.map((x) => x[0])).size).toBe(1);
    expect(new Set(ids.map((x) => x[1])).size).toBe(1);
    expect(ids[0]![0]).not.toBe(ids[0]![1]);
  });
  it("survives short misses and re-identifies after a cut", () => {
    let tr: KTracker = newTracker();
    for (let k = 0; k < 5; k++) tr = kStep(tr, [det(k * 0.2, 0, 0, red)], k * 0.2).tracker;
    const id = tr.tracks[0]!.id;
    // two frames missed (0.4 s), then seen again near the prediction
    tr = kStep(tr, [], 1.0).tracker; tr = kStep(tr, [], 1.2).tracker;
    expect(tr.tracks).toHaveLength(1);
    let r = kStep(tr, [det(1.4, 0, 0, red)], 1.4);
    expect(r.byDet[0]!.id).toBe(id);
    // a cut: suspended, then a detection 2 s later 3 m away with the same colour comes back under the same id
    tr = suspend(r.tracker);
    r = kStep(tr, [det(4.2, 0.5, 0, red), det(-20, 5, 1, white)], 3.4);
    expect(r.byDet[0]!.id).toBe(id);
    expect(r.byDet[1]!.id).not.toBe(id);
    expect(trackPos(r.byDet[0]!).x).toBeCloseTo(4.2, 0);
  });
  it("never revives a track with a different colour", () => {
    let tr: KTracker = newTracker();
    for (let k = 0; k < 3; k++) tr = kStep(tr, [det(0, 0, 0, red)], k * 0.2).tracker;
    const id = tr.tracks[0]!.id;
    const r = kStep(suspend(tr), [{ p: { x: 1, y: 0 }, team: "other", lab: white }], 1);
    expect(r.byDet[0]!.id).not.toBe(id);
  });
});

describe("adaptive tiling", () => {
  const plan = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 75, y: 0, w: 100, h: 100 }, { x: 150, y: 0, w: 100, h: 100 }];
  it("picks the tile that holds each point farthest from its edges", () => {
    expect(focusTiles(plan, [{ x: 120, y: 50 }])).toEqual([plan[1]]);
    expect(focusTiles(plan, [{ x: 30, y: 50 }, { x: 230, y: 50 }, { x: 40, y: 40 }])).toEqual([plan[0], plan[2]]);
    expect(focusTiles(plan, [])).toEqual([]);
  });
  it("only looks for players the full-frame pass did not find", () => {
    const boxes = [{ x: 10, y: 10, w: 20, h: 40 }];
    expect(uncovered([{ x: 20, y: 52 }, { x: 200, y: 50 }], boxes)).toEqual([{ x: 200, y: 50 }]);
  });
  it("runs the full scan every N frames or when forced", () => {
    expect(fullScanDue(1, 3, false)).toBe(false);
    expect(fullScanDue(3, 3, false)).toBe(true);
    expect(fullScanDue(1, 3, true)).toBe(true);
    expect(fullScanDue(1, 1, false)).toBe(true);
  });
});
