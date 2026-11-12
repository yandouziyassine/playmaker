import { describe, expect, it } from "vitest";
import { bucketOf, isTarget, matchBoxes, quantile, scoreFrame, summarise, type GtFrame, type GtPlayer } from "../src/lab/bench.ts";
import { applyH, computeHomography } from "../src/lab/homography.ts";
import { feet } from "../src/lab/players.ts";

// a pitch -> image homography (metres to pixels) and a frame of 4 people seen through it
const H = computeHomography(
  [{ x: 0, y: 34 }, { x: 52.5, y: 34 }, { x: 52.5, y: -34 }, { x: 0, y: -34 }],
  [{ x: 300, y: 150 }, { x: 1100, y: 160 }, { x: 1250, y: 700 }, { x: 100, y: 680 }],
)!;
const person = (id: number, team: number, role: GtPlayer["role"], x: number, y: number, hPx: number, extra: Partial<GtPlayer> = {}): GtPlayer => {
  const f = applyH(H, { x, y })!;
  return { id, team, role, pos: [x, y], feet: [f.x, f.y], box: [f.x - hPx * 0.15, f.y - hPx, hPx * 0.3, hPx], hPx, inFrame: 1, occluded: 0, ...extra };
};
const gt: GtFrame = {
  id: "t", view: "wide", H, ball: { pos: [20, 0], box: [600, 400, 8, 8] },
  players: [person(1, 0, "player", 10, 0, 30), person(2, 0, "player", 20, 10, 60), person(3, 1, "player", 30, -10, 100), person(4, 1, "keeper", 50, 0, 50), person(5, 1, "player", 40, 5, 30, { occluded: 0.9 })],
};
const detAt = (p: GtPlayer, score = 0.9, dx = 0, dy = 0) => ({ box: { x: p.box[0]! + dx, y: p.box[1]! + dy, w: p.box[2]!, h: p.box[3]! }, score });

describe("matching", () => {
  it("buckets by height and ignores mostly hidden or out-of-frame truth", () => {
    expect([bucketOf(39), bucketOf(40), bucketOf(89), bucketOf(90)]).toEqual(["small", "medium", "medium", "large"]);
    expect(isTarget(gt.players[0]!)).toBe(true);
    expect(isTarget(gt.players[4]!)).toBe(false);
    expect(isTarget({ ...gt.players[0]!, inFrame: 0.3 })).toBe(false);
  });
  it("matches greedily at IoU 0.5, one detection per truth", () => {
    const d = [detAt(gt.players[0]!), detAt(gt.players[0]!, 0.5, 2, 0), detAt(gt.players[2]!, 0.8, 200, 0)];
    const m = matchBoxes(gt.players.map((p) => p.box), d);
    expect([...m.entries()]).toEqual([[0, 0]]);
  });
});

describe("scoreFrame / summarise", () => {
  it("counts recall per bucket, false positives, feet error through the truth homography, ball and team purity", () => {
    const dets = [detAt(gt.players[0]!), detAt(gt.players[1]!), detAt(gt.players[3]!), detAt(gt.players[4]!), { box: { x: 5, y: 5, w: 20, h: 50 }, score: 0.7 }];
    const s = scoreFrame(gt, { persons: dets, balls: [{ box: { x: 601, y: 401, w: 8, h: 8 }, score: 0.4 }], ms: 100, passes: 7 }, [1, 1, "other", 0, 0]);
    expect(s.buckets).toEqual({ small: { targets: 1, found: 1 }, medium: { targets: 2, found: 2 }, large: { targets: 1, found: 0 } });
    expect(s.falsePositives).toBe(1); // the crowd box; the hidden player's detection is matched (ignored truth), not a false positive
    expect(s.ballFound).toBe(true);
    expect(s.feetErr).toHaveLength(3); // targets only
    // the feet point is the box bottom raised by the shrink: the error is the metre distance of that bias
    const q = applyH(H, feet(dets[0]!.box))!;
    expect(s.feetErr[0]).toBeGreaterThan(0);
    expect(Math.abs(s.feetDy[0]!)).toBeLessThan(0.05);
    expect(q).toBeTruthy();
    // teams: both home players labelled 1 and the (hidden, still matched) guest labelled 0: the mapping is free, so all 3 are
    // consistent; the keeper flagged "other"
    expect(s.teamMatched).toBe(3); expect(s.teamCorrect).toBe(3);
    expect(s.othersTotal).toBe(1); expect(s.othersFlagged).toBe(1);
    const sum = summarise([s, s]);
    expect(sum.recall.all).toBeCloseTo(3 / 4, 6);
    expect(sum.recall.large).toBe(0);
    expect(sum.precision).toBeCloseTo(4 / 5, 6);
    expect(sum.ballRecall).toBe(1);
    expect(sum.teamPurity).toBe(1);
    expect(sum.byView.wide!.recall).toBeCloseTo(3 / 4, 6);
    expect(sum.passes).toBe(7);
  });
  it("quantile is robust to empty input", () => {
    expect(quantile([], 0.5)).toBeNaN();
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});
