import { describe, expect, it } from "vitest";
import {
  abHist, addVote, classifyFeat, DEFAULT_GRASS, fitTeamModel, grassModel, isGrassIn, labelClip, labToRgb, rgbToLab, spatialPrior,
  torsoFeature, trackLabel, type ClipDet, type ColourFeat, type Lab, type RGB, type TeamModel, type TrackVotes,
} from "../src/lab/teams.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** w x h RGBA image filled with `bg`, with optional rectangles painted on it. */
function image(w: number, h: number, bg: RGB, rects: { x: number; y: number; w: number; h: number; c: RGB }[] = [], noise = 0, seed = 1) {
  const r = rng(seed), data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const rc = rects.find((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
    const c = rc ? rc.c : bg, i = 4 * (y * w + x);
    for (let k = 0; k < 3; k++) data[i + k] = c[k]! + (r() - 0.5) * 2 * noise;
    data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

/** A feature straight from a Lab colour (single-colour crop), weight w. */
function feat(lab: Lab, w = 1): ColourFeat {
  return { lab, hist: abHist([lab]), kept: 1, w, allGrass: false };
}
const jitter = (c: Lab, r: () => number, s: number): Lab => [c[0] + (r() - 0.5) * s, c[1] + (r() - 0.5) * s, c[2] + (r() - 0.5) * s];

const GRASS: RGB = [52, 128, 48], RED: RGB = [159, 25, 34], WHITE: RGB = [240, 240, 240], BLACK: RGB = [21, 21, 21];

describe("grass masking", () => {
  it("estimates the grass range from the pitch area and masks the grass around the shirt", () => {
    const img = image(200, 120, GRASS, [], 10);
    const m = grassModel(img);
    expect(m.hueLo).toBeLessThan(115); // the grass hue (~118 deg) is inside the range
    expect(m.hueHi).toBeGreaterThan(120);
    expect(isGrassIn(m, ...GRASS)).toBe(true);
    expect(isGrassIn(m, ...RED)).toBe(false);
    expect(isGrassIn(m, ...WHITE)).toBe(false);
  });
  it("falls back to the default range without enough green", () => {
    expect(grassModel(image(60, 40, WHITE))).toEqual(DEFAULT_GRASS);
  });
  it("gives the shirt colour (median Lab) even when grass fills half the crop", () => {
    // a 20 x 50 player box; the shirt covers only the left half of the shirt crop, grass the rest
    const box = { x: 40, y: 20, w: 20, h: 50 };
    const img = image(120, 100, GRASS, [{ x: 40, y: 20, w: 10, h: 50, c: RED }], 6);
    const f = torsoFeature(img, box, grassModel(image(200, 120, GRASS, [], 6)))!;
    const red = rgbToLab(RED);
    expect(Math.hypot(f.lab[0] - red[0], f.lab[1] - red[1], f.lab[2] - red[2])).toBeLessThan(6);
    expect(f.kept).toBeGreaterThan(0.3);
    expect(f.kept).toBeLessThan(0.7);
    expect(f.hist.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(f.allGrass).toBe(false);
  });
  it("keeps every pixel of an all-green crop (green kit) with a low weight", () => {
    const img = image(80, 80, GRASS, [], 4);
    const f = torsoFeature(img, { x: 20, y: 10, w: 20, h: 50 })!;
    expect(f.allGrass).toBe(true);
    expect(f.w).toBeLessThan(0.35);
  });
  it("weights small boxes less", () => {
    const img = image(200, 200, GRASS, [{ x: 0, y: 0, w: 200, h: 200, c: WHITE }]);
    const big = torsoFeature(img, { x: 10, y: 10, w: 30, h: 80 })!, small = torsoFeature(img, { x: 10, y: 10, w: 6, h: 14 })!;
    expect(big.w).toBeGreaterThan(small.w);
  });
});

describe("team model", () => {
  const r = rng(7);
  const red = rgbToLab(RED), white = rgbToLab(WHITE);
  const samples = [
    ...Array.from({ length: 10 }, () => feat(jitter(red, r, 6))),
    ...Array.from({ length: 10 }, () => feat(jitter(white, r, 6))),
    feat(rgbToLab(BLACK)), feat(rgbToLab([47, 179, 106])), feat(rgbToLab([232, 177, 28])), // referee, keepers
  ];
  it("fits the two kits and sets the referee and keepers aside", () => {
    const m = fitTeamModel(samples)!;
    expect(m).not.toBeNull();
    const near = (c: Lab, q: Lab) => Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2]);
    const [a, b] = m.centres;
    expect(Math.min(near(a, red) + near(b, white), near(a, white) + near(b, red))).toBeLessThan(8);
    for (const o of samples.slice(20)) expect(classifyFeat(o, m).team).toBe("other");
    for (const s of samples.slice(0, 20)) expect(classifyFeat(s, m).team).not.toBe("other");
    expect(m.other).not.toBeNull();
  });
  it("is not pulled by heavy outliers when the referee comes first", () => {
    const m = fitTeamModel([feat(rgbToLab(BLACK), 1), feat(rgbToLab(BLACK), 1), ...samples.slice(0, 20)])!;
    const teams = samples.slice(0, 20).map((s) => classifyFeat(s, m).team);
    expect(new Set(teams.slice(0, 10)).size).toBe(1);
    expect(new Set(teams.slice(10)).size).toBe(1);
    expect(teams[0]).not.toBe(teams[10]);
  });
  it("needs enough samples", () => {
    expect(fitTeamModel(samples.slice(0, 5))).toBeNull();
  });
  it("reports a near-tie with a small margin", () => {
    const m = fitTeamModel(samples)!;
    const mid: Lab = [(red[0] + white[0]) / 2, (red[1] + white[1]) / 2, (red[2] + white[2]) / 2];
    const sure = classifyFeat(feat(red), m), tie = classifyFeat({ lab: mid, hist: abHist([mid]) }, m);
    expect(sure.margin).toBeGreaterThan(0.5);
    expect(tie.margin).toBeLessThan(sure.margin);
  });
  it("converts a centroid back to sRGB", () => {
    const back = labToRgb(rgbToLab(RED));
    back.forEach((v, i) => expect(Math.abs(v - RED[i]!)).toBeLessThan(1.5));
  });
});

describe("track voting", () => {
  const m: TeamModel = { centres: [rgbToLab(RED), rgbToLab(WHITE)], hists: [abHist([rgbToLab(RED)]), abHist([rgbToLab(WHITE)])], spread: [4, 4], cut: [20, 20], separation: 90, other: null };
  it("a weighted majority: a few low-quality wrong frames do not flip the track", () => {
    let v: TrackVotes = [0, 0, 0];
    for (let k = 0; k < 6; k++) v = addVote(v, classifyFeat(feat(rgbToLab(RED)), m), 1);
    for (let k = 0; k < 4; k++) v = addVote(v, classifyFeat(feat(rgbToLab(WHITE)), m), 0.2);
    expect(trackLabel(v)).toBe(0);
  });
  it("other only when it outweighs both teams", () => {
    expect(trackLabel([1, 0.5, 1.2])).toBe("other");
    expect(trackLabel([1, 0.5, 0.9])).toBe(0);
    expect(trackLabel([0.2, 1, 0.9])).toBe(1);
  });
  it("the spatial prior only breaks near-ties", () => {
    const tie = { team: 0 as const, best: 0 as const, margin: 0.02, d: [10, 10.4] as [number, number] };
    const sure = { team: 0 as const, best: 0 as const, margin: 0.6, d: [3, 12] as [number, number] };
    const vt = addVote([0, 0, 0], tie, 1, -1), vs = addVote([0, 0, 0], sure, 1, -1);
    expect(trackLabel(vt)).toBe(1); // nearer the B players: the prior wins the tie
    expect(trackLabel(vs)).toBe(0); // a clear colour is never overridden
    expect(spatialPrior(10, -20, 20)).toBeLessThan(0);
    expect(spatialPrior(-15, -20, 20)).toBeGreaterThan(0);
    expect(spatialPrior(0, 1, 3)).toBe(0); // means too close: no prior
  });
  it("labelClip: fixed model, vote per track, referee track is other", () => {
    const r = rng(3), dets: ClipDet[] = [];
    for (let fr = 0; fr < 8; fr++) {
      for (let id = 1; id <= 6; id++) dets.push({ id, seg: 0, frame: fr, feat: feat(jitter(rgbToLab(RED), r, 6)), x: -20 + id, good: true });
      for (let id = 7; id <= 12; id++) dets.push({ id, seg: 0, frame: fr, feat: feat(jitter(rgbToLab(WHITE), r, 6)), x: 15 + id, good: true });
      dets.push({ id: 13, seg: 0, frame: fr, feat: feat(jitter(rgbToLab(BLACK), r, 4)), x: 0, good: true });
    }
    // track 3 has two bad frames (a white crop: occlusion by an opponent)
    dets.push({ id: 3, seg: 0, frame: 8, feat: feat(rgbToLab(WHITE), 0.3), x: -17, good: false });
    dets.push({ id: 3, seg: 0, frame: 9, feat: feat(rgbToLab(WHITE), 0.3), x: -17, good: false });
    const res = labelClip(dets);
    const a = res.byTrack.get(1)!, b = res.byTrack.get(7)!;
    expect(a).not.toBe(b);
    for (let id = 1; id <= 6; id++) expect(res.byTrack.get(id)).toBe(a);
    for (let id = 7; id <= 12; id++) expect(res.byTrack.get(id)).toBe(b);
    expect(res.byTrack.get(13)).toBe("other");
    expect(res.refits).toBe(0);
  });
  it("labelClip refits after a cut only when the colours clearly moved, keeping A/B", () => {
    const r = rng(5), dets: ClipDet[] = [];
    const shift = (c: Lab): Lab => [c[0] - 25, c[1] * 0.6, c[2] * 0.6 - 15]; // a darker, bluer shot
    for (let fr = 0; fr < 6; fr++) for (let id = 1; id <= 12; id++) {
      const base = rgbToLab(id <= 6 ? RED : WHITE);
      dets.push({ id, seg: 0, frame: fr, feat: feat(jitter(base, r, 5)), x: id <= 6 ? -10 : 10, good: true });
      dets.push({ id: 100 + id, seg: 1, frame: 10 + fr, feat: feat(jitter(shift(base), r, 5)), x: id <= 6 ? -10 : 10, good: false });
    }
    const res = labelClip(dets);
    expect(res.refits).toBe(1);
    expect(res.byTrack.get(101)).toBe(res.byTrack.get(1));
    expect(res.byTrack.get(107)).toBe(res.byTrack.get(7));
  });
});
