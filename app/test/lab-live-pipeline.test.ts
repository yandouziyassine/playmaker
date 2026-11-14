// Live mode on the clip pipeline (live.ts): prediction at irregular frame times, the fixed team model and its refit after
// a camera cut, the pool-aware throttle.
import { describe, expect, it } from "vitest";
import {
  alignModel, ema, imageMotion, LIVE_MOTION, liveTeamsStep, motionSearch, nextPan, nextThrottle, panShift, POOL_THROTTLE, predictAt, remapTracks, shiftH,
  START_PAN, START_TEAMS, START_THROTTLE, teamFitDue, THROTTLE, upkeepDue, type LiveTeams,
} from "../src/lab/live.ts";
import { invert3, type Mat3 } from "../src/lab/homography.ts";
import { kStep, newTracker, trackPos, type KTracker } from "../src/lab/ktrack.ts";
import { abHist, fitTeamModel, rgbToLab, type ColourFeat, type Lab, type RGB, type TeamModel } from "../src/lab/teams.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const feat = (lab: Lab): ColourFeat => ({ lab, hist: abHist([lab]), kept: 1, w: 1, allGrass: false });
const RED = rgbToLab([159, 25, 34] as RGB), WHITE = rgbToLab([240, 240, 240] as RGB);
function kits(n: number, r: () => number): ColourFeat[] {
  const j = (c: Lab): Lab => [c[0] + (r() - 0.5) * 6, c[1] + (r() - 0.5) * 6, c[2] + (r() - 0.5) * 6];
  return Array.from({ length: n }, (_, i) => feat(j(i % 2 ? RED : WHITE)));
}

describe("variable frame intervals", () => {
  it("tracks players with one identity each when frames arrive at irregular times", () => {
    const r = rng(3);
    let tr: KTracker = newTracker(), t = 0;
    const ids = new Set<number>();
    for (let k = 0; k < 40; k++) {
      t += 0.08 + 0.5 * r(); // 2 .. 12 fps, as a live detector whose speed varies
      const dets = [{ x: -20 + 5 * t, y: 3 }, { x: 10, y: -10 + 2 * t }].map((p) => ({ p: { x: p.x + (r() - 0.5) * 0.4, y: p.y + (r() - 0.5) * 0.4 }, team: 0 as const, lab: null }));
      const res = kStep(tr, dets, t);
      tr = res.tracker;
      res.byDet.forEach((x) => ids.add(x.id));
    }
    expect(ids.size).toBe(2);
    const fast = tr.tracks.find((x) => Math.abs(trackPos(x).y - 3) < 1)!;
    expect(fast.k.x[2]).toBeGreaterThan(4); // 5 m/s along x
    expect(fast.k.x[2]).toBeLessThan(6);
  });

  it("predicts a missed player to the frame time (velocity x elapsed, capped at maxDt; none before minHits)", () => {
    let tr = newTracker();
    for (let k = 0; k <= 5; k++) tr = kStep(tr, [{ p: { x: 4 * k * 0.2, y: 0 }, team: 0, lab: null }], k * 0.2).tracker;
    const t0 = tr.tracks[0]!;
    const p = trackPos(t0);
    expect(predictAt(t0, t0.lastT).x).toBeCloseTo(p.x, 6);
    expect(predictAt(t0, t0.lastT + 0.35).x - p.x).toBeCloseTo(0.35 * t0.k.x[2]!, 3);
    expect(predictAt(t0, t0.lastT + 5).x - p.x).toBeCloseTo(1 * t0.k.x[2]!, 3); // maxDt = 1 s
    expect(predictAt(t0, t0.lastT - 1).x).toBeCloseTo(p.x, 6); // never backwards
    const fresh = kStep(newTracker(), [{ p: { x: 1, y: 1 }, team: 0, lab: null }], 0).byDet[0]!;
    expect(predictAt(fresh, 0.5)).toEqual({ x: 1, y: 1 });
  });
});

describe("live team model", () => {
  it("fits once calibrated, after minFrames frames, then stays fixed", () => {
    const r = rng(5);
    let s: LiveTeams = liveTeamsStep(START_TEAMS, { cut: false, calibrated: false, feats: kits(16, r) });
    expect(s.model).toBeNull();
    expect(s.pool).toHaveLength(0); // uncalibrated frames are not pooled
    s = liveTeamsStep(s, { cut: false, calibrated: true, feats: kits(16, r) });
    expect(s.model).toBeNull(); // 1 of 2 frames
    s = liveTeamsStep(s, { cut: false, calibrated: true, feats: kits(16, r) });
    expect(s.model).not.toBeNull();
    const m = s.model;
    let fits = 0;
    const counting = (f: ColourFeat[]) => { fits++; return fitTeamModel(f); };
    for (let k = 0; k < 5; k++) s = liveTeamsStep(s, { cut: false, calibrated: true, feats: kits(16, r) }, undefined, counting);
    expect(fits).toBe(0);
    expect(s.model).toBe(m);
    expect(s.refits).toBe(0);
  });

  it("refits after a detected camera cut, keeping the old model until then and team A as A", () => {
    const r = rng(7);
    let s: LiveTeams = START_TEAMS;
    for (let k = 0; k < 2; k++) s = liveTeamsStep(s, { cut: false, calibrated: true, feats: kits(16, r) });
    const m = s.model!;
    expect(teamFitDue(s, false)).toBe(false);
    expect(teamFitDue(s, true)).toBe(true);
    // the cut frame (close-up, not calibrated): marked stale, old model kept
    s = liveTeamsStep(s, { cut: true, calibrated: false, feats: kits(3, r) });
    expect(s.stale).toBe(true);
    expect(s.model).toBe(m);
    // a refit that would come out with the teams exchanged is aligned back
    const swapped = (f: ColourFeat[]): TeamModel | null => { const x = fitTeamModel(f); return x && { ...x, centres: [x.centres[1], x.centres[0]], hists: [x.hists[1], x.hists[0]], spread: [x.spread[1], x.spread[0]], cut: [x.cut[1], x.cut[0]] }; };
    for (let k = 0; k < 2; k++) s = liveTeamsStep(s, { cut: false, calibrated: true, feats: kits(16, r) }, undefined, swapped);
    expect(s.stale).toBe(false);
    expect(s.refits).toBe(1);
    expect(s.model).not.toBe(m);
    const d = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(d(s.model!.centres[0], m.centres[0])).toBeLessThan(5);
  });

  it("aligns a refit to the previous model only when swapping matches better", () => {
    const r = rng(9);
    const m = fitTeamModel(kits(20, r))!;
    expect(alignModel(m, null)).toBe(m);
    expect(alignModel(m, m)).toBe(m);
    const sw: TeamModel = { ...m, centres: [m.centres[1], m.centres[0]], hists: [m.hists[1], m.hists[0]], spread: [m.spread[1], m.spread[0]], cut: [m.cut[1], m.cut[0]] };
    expect(alignModel(sw, m).centres).toEqual(m.centres);
  });
});

describe("live latency helpers", () => {
  it("lets the detector use more of the time when the tiles run in workers", () => {
    let a = START_THROTTLE, b = START_THROTTLE;
    for (let k = 0; k < 30; k++) { a = nextThrottle(a, 400); b = nextThrottle(b, 400, POOL_THROTTLE); }
    expect(a.interval).toBeCloseTo(400 / THROTTLE.duty, 6);
    expect(b.interval).toBeCloseTo(500, 6);
  });
  it("averages latencies", () => {
    expect(ema(null, 80)).toBe(80);
    expect(ema(100, 50, 0.2)).toBeCloseTo(90, 9);
  });
});

describe("camera motion between live frames", () => {
  it("widens the motion search with the time since the last homography and the pan speed (capped)", () => {
    const still = { v: { x: 0, y: 0 }, t: 10 }, fast = { v: { x: 200, y: 0 }, t: 10 };
    expect(motionSearch(still, 10, 0.5)).toBe(LIVE_MOTION.base);
    expect(motionSearch(still, 10.7, 0.5)).toBeGreaterThan(motionSearch(still, 10.2, 0.5));
    expect(motionSearch(fast, 10.7, 0.5)).toBeGreaterThan(motionSearch(still, 10.7, 0.5));
    expect(motionSearch(fast, 100, 0.5)).toBe(LIVE_MOTION.max);
    expect(motionSearch(START_PAN, 3, 0.5)).toBeGreaterThan(LIVE_MOTION.base); // no estimate yet: the widest prediction gap
  });
  it("predicts the pan shift and learns the pan speed from measured displacements", () => {
    let pan = nextPan(START_PAN, null, 1);
    expect(panShift(pan, 1.5)).toEqual({ x: 0, y: 0 });
    for (let k = 1; k <= 12; k++) pan = nextPan(pan, { x: 20, y: -4 }, 1 + 0.2 * k); // 100 px/s right, 20 px/s up
    expect(pan.v.x).toBeCloseTo(100, 1);
    expect(panShift(pan, pan.t! + 0.5).x).toBeCloseTo(50, 0);
    expect(panShift(pan, pan.t! + 10).x).toBeCloseTo(100 * LIVE_MOTION.maxDt, 0);
  });
  it("measures the image motion between two homographies and moves a homography by a shift", () => {
    const H: Mat3 = [10, 0, 640, 0, 10, 360, 0, 0, 1];
    const moved = shiftH(H, { x: 25, y: -5 });
    expect(imageMotion(H, moved, { x: 300, y: 200 })).toEqual({ x: 25, y: -5 });
    expect(shiftH(H, { x: 0, y: 0 })).toBe(H);
  });
  it("remaps tracks through a corrected homography, keeping identities", () => {
    let tr = newTracker();
    for (let k = 0; k < 4; k++) tr = kStep(tr, [{ p: { x: 1 + k * 0.2, y: 2 }, team: 0, lab: null }, { p: { x: -5, y: 0 }, team: 1, lab: null }], k * 0.2).tracker;
    const oldP2i: Mat3 = [10, 0, 640, 0, 10, 360, 0, 0, 1];
    const newI2p = invert3([10, 0, 650, 0, 10, 360, 0, 0, 1])!; // the corrected view: everything 1 m further left on the pitch
    const out = remapTracks(tr, oldP2i, newI2p);
    expect(out.tracks.map((t) => t.id)).toEqual(tr.tracks.map((t) => t.id));
    out.tracks.forEach((t, i) => {
      expect(t.k.x[0]).toBeCloseTo(tr.tracks[i]!.k.x[0]! - 1, 6);
      expect(t.k.x[1]).toBeCloseTo(tr.tracks[i]!.k.x[1]!, 6);
      expect(t.k.x[2]).toBeCloseTo(tr.tracks[i]!.k.x[2]!, 6); // same scale: velocity unchanged
    });
  });
  it("runs the upkeep in the idle gap when it fits, else every other frame", () => {
    expect(upkeepDue(100, null, 0)).toBe(true);
    expect(upkeepDue(100, 50, 0)).toBe(true);
    expect(upkeepDue(20, 50, 0)).toBe(false);
    expect(upkeepDue(20, 50, 1)).toBe(true);
  });
});
