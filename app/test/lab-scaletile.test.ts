import { describe, expect, it } from "vitest";
import { dropCut, gateBySize, heightProfile, nearSeed, planScaleTiles, refineRegions, SCALE_DEFAULTS, sideFor, type ScaleOpts } from "../src/lab/scaletile.ts";
import { sanitise } from "../src/lab/settings.ts";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const person = (x: number, feetY: number, h: number, score = 0.8) => ({ box: box(x, feetY - h, h * 0.4, h), score });
const opts = (o: Partial<ScaleOpts> = {}): ScaleOpts => ({ ...SCALE_DEFAULTS, input: 320, base: 384, maxTiles: 64, ...o });
/** A broadcast-like perspective: 12 px players at the top row, 72 px at the bottom of a 720 px picture. */
const persp = (y: number) => 12 + (60 * y) / 720;

describe("heightProfile", () => {
  it("fits the perspective: small players high up, large near the bottom", () => {
    const ps = [100, 250, 400, 550, 700].flatMap((y) => [person(100, y, persp(y)), person(600, y, persp(y))]);
    const hAt = heightProfile(ps, 720)!;
    expect(hAt(100)).toBeLessThan(hAt(600));
    expect(hAt(400)).toBeGreaterThan(persp(400) * 0.8);
    expect(hAt(400)).toBeLessThan(persp(400) * 1.2);
  });
  it("needs a few boxes, never slopes the wrong way and clamps", () => {
    expect(heightProfile([person(0, 300, 30), person(50, 300, 30)], 720)).toBeNull();
    const inverted = heightProfile([person(0, 100, 80), person(9, 100, 80), person(20, 700, 20), person(30, 700, 20)], 720)!;
    expect(inverted(100)).toBe(inverted(700)); // b clamped to 0: a flat profile
    const flat = heightProfile([person(0, 300, 30), person(50, 300, 30), person(90, 310, 30)], 720)!;
    expect(flat(0)).toBe(30);
    expect(flat(5000)).toBe(30);
  });
});

describe("planScaleTiles", () => {
  it("plans smaller tiles far away (top) and none where the base tiles already magnify enough", () => {
    const { tiles, k } = planScaleTiles(1280, 720, persp, opts());
    expect(k).toBe(1);
    expect(tiles.length).toBeGreaterThan(0);
    const top = tiles.filter((t) => t.y < 100), low = tiles.filter((t) => t.y > 300);
    expect(top.length).toBeGreaterThan(0);
    for (const t of top) expect(Math.abs(t.w - sideFor(persp(t.y + t.h / 2), opts()))).toBeLessThanOrEqual(12);
    if (low.length) expect(Math.min(...low.map((t) => t.w))).toBeGreaterThan(Math.max(...top.map((t) => t.w)));
    // the base 384 px tile shows a player of h px at h * 320 / 384: rows with h >= 0.8 * 48 * 384 / 320 = 46 px get no extra tile
    for (const t of tiles) expect(persp(t.y + t.h / 2)).toBeLessThan(46.1);
    for (const t of tiles) { expect(t.w).toBe(t.h); expect(t.x).toBeGreaterThanOrEqual(0); expect(t.x + t.w).toBeLessThanOrEqual(1280); expect(t.y + t.h).toBeLessThanOrEqual(720); expect(t.w).toBeGreaterThanOrEqual(128); }
  });
  it("rows cover the width and overlap", () => {
    const { tiles } = planScaleTiles(1280, 720, () => 20, opts());
    const firstRow = tiles.filter((t) => t.y === 0).sort((a, b) => a.x - b.x);
    expect(firstRow[0]!.x).toBe(0);
    expect(firstRow.at(-1)!.x + firstRow.at(-1)!.w).toBe(1280);
    for (let i = 1; i < firstRow.length; i++) expect(firstRow[i]!.x - firstRow[i - 1]!.x).toBeLessThanOrEqual(firstRow[i]!.w * 0.75 + 1);
  });
  it("respects the cap by growing the tiles, and skips rejected tiles", () => {
    const full = planScaleTiles(1280, 720, () => 16, opts());
    const capped = planScaleTiles(1280, 720, () => 16, opts({ maxTiles: 10 }));
    expect(full.tiles.length).toBeGreaterThan(10);
    expect(capped.tiles.length).toBeLessThanOrEqual(10);
    expect(capped.k).toBeGreaterThan(1);
    expect(capped.tiles[0]!.w).toBeGreaterThan(full.tiles[0]!.w);
    expect(capped.tiles.every((t) => t.w < 384)).toBe(true);
    // a cap that no useful growth meets: the tiles of the smallest expected players (top rows) are kept
    const tight = planScaleTiles(1280, 720, persp, opts({ maxTiles: 3 }));
    expect(tight.tiles).toHaveLength(3);
    expect(Math.max(...tight.tiles.map((t) => t.y))).toBe(0);
    expect(planScaleTiles(1280, 720, () => 16, opts({ maxTiles: 0 })).tiles).toEqual([]);
    // only the lower half is grass
    const grassOnly = planScaleTiles(1280, 720, () => 16, opts(), (t) => t.y >= 360);
    expect(grassOnly.tiles.every((t) => t.y >= 360)).toBe(true);
    expect(planScaleTiles(1280, 720, () => 200, opts()).tiles).toEqual([]); // large players: nothing to add
  });
});

describe("gates", () => {
  it("keeps boxes of the expected size at their row", () => {
    const ps = [person(0, 400, 30), person(0, 400, 10), person(0, 400, 90)];
    expect(gateBySize(ps, () => 30).map((p) => p.box.h)).toEqual([30]);
  });
  it("drops boxes cut by an inner tile edge, not by the picture edge", () => {
    const t = box(100, 0, 200, 200);
    const ps = [{ box: box(101, 50, 10, 30), score: 1 }, { box: box(150, 0, 10, 30), score: 1 }, { box: box(150, 160, 10, 39.5), score: 1 }, { box: box(150, 80, 10, 30), score: 1 }];
    expect(dropCut(ps, t, 1280, 720).map((p) => p.box.y)).toEqual([0, 80]);
  });
});

describe("refineRegions", () => {
  const o = { input: 320, target: 56, minSide: 112, maxSide: 320, max: 3 };
  it("zooms on uncovered low-confidence candidates, best first, sized from the expected height", () => {
    const weak = [person(400, 300, 20, 0.2), person(800, 300, 20, 0.22), person(100, 300, 20, 0.19)];
    const r = refineRegions(weak, [], [], null, 1280, 720, o);
    expect(r).toHaveLength(3);
    expect(r[0]!.x + r[0]!.w / 2).toBeCloseTo(800 + 4, 0);
    expect(r[0]!.w).toBe(Math.max(112, Math.round((320 * 20) / 56)));
  });
  it("skips candidates already found, merges neighbours, caps, puts predictions first and clamps to the picture", () => {
    const found = person(400, 300, 20, 0.9);
    const weak = [person(401, 301, 20, 0.2), person(800, 300, 20, 0.21), person(805, 302, 20, 0.2), person(1270, 715, 30, 0.2)];
    const r = refineRegions(weak, [found.box], [box(50, 50, 8, 20)], null, 1280, 720, { ...o, max: 5 });
    expect(r).toHaveLength(3); // prediction, the 800 candidate (805 merged), the corner one (400 is covered)
    expect(r[0]!.x).toBe(0);
    for (const b of r) { expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0); expect(b.x + b.w).toBeLessThanOrEqual(1280); expect(b.y + b.h).toBeLessThanOrEqual(720); }
    expect(refineRegions(weak, [], [], null, 1280, 720, { ...o, max: 1 })).toHaveLength(1);
    expect(refineRegions(weak, [], [], null, 1280, 720, { ...o, max: 0 })).toEqual([]);
    expect(r[1]!.seed).toEqual(weak[1]!.box);
  });
  it("skips large candidates (no zoom gain) but keeps large predictions, and keeps only detections near the seed", () => {
    const big = person(400, 600, 120, 0.2);
    expect(refineRegions([big], [], [], null, 1280, 720, o)).toEqual([]);
    expect(refineRegions([], [], [big.box], null, 1280, 720, o)).toHaveLength(1);
    const seed = box(100, 100, 8, 20);
    expect(nearSeed([{ box: box(99, 101, 9, 21) }, { box: box(160, 100, 8, 20) }], seed)).toHaveLength(1);
  });
});

describe("settings", () => {
  it("keeps the small-player caps only when positive", () => {
    const base = { model: "lite0" as const, tile: 384, overlap: 0.25, tileMinScore: 0.25 };
    expect(sanitise({ ...base, scaleTiles: 16.2, refine: 8 })).toEqual({ ...base, scaleTiles: 16, refine: 8 });
    expect(sanitise({ ...base, scaleTiles: 0, refine: -1 })).toEqual(base);
    expect(sanitise({ ...base, scaleTiles: 999 }).scaleTiles).toBe(64);
  });
});
