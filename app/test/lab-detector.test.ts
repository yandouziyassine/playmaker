import { describe, expect, it } from "vitest";
import { containment, iou, nms, peopleTiles, planTiles, tiles } from "../src/lab/detector.ts";
import { DEFAULT_SETTINGS, LEGACY_SETTINGS, MODELS, passesFor, sanitise } from "../src/lab/settings.ts";
import { feet, FEET } from "../src/lab/players.ts";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("planTiles", () => {
  it("covers the picture with square tiles that end on the edges and overlap at least as asked", () => {
    const ts = planTiles(1280, 720, 384, 0.25);
    expect(ts).toHaveLength(5 * 3);
    for (const t of ts) { expect(t.w).toBe(384); expect(t.h).toBe(384); expect(t.x).toBeGreaterThanOrEqual(0); expect(t.x + t.w).toBeLessThanOrEqual(1280); expect(t.y + t.h).toBeLessThanOrEqual(720); }
    expect(Math.max(...ts.map((t) => t.x + t.w))).toBe(1280);
    expect(Math.max(...ts.map((t) => t.y + t.h))).toBe(720);
    const xs = [...new Set(ts.map((t) => t.x))].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeLessThanOrEqual(384 * 0.75 + 1);
  });
  it("uses one tile when the picture is smaller than the tile, and clamps the tile to the picture", () => {
    expect(planTiles(300, 200, 384)).toEqual([box(0, 0, 300, 200)]);
    expect(planTiles(1000, 300, 384)).toHaveLength(4); // ceil((1000 - 96) / 288)
    expect(planTiles(1000, 300, 384)[0]).toEqual(box(0, 0, 384, 300));
  });
  it("settings pick the legacy 3 x 2 grid when tile = 0", () => {
    expect(peopleTiles(1280, 720, LEGACY_SETTINGS)).toEqual(tiles(1280, 720, 3, 2));
    expect(peopleTiles(1280, 720, DEFAULT_SETTINGS)).toHaveLength(15);
    expect(passesFor(1280, 720, LEGACY_SETTINGS)).toBe(7);
    expect(passesFor(1280, 720, DEFAULT_SETTINGS)).toBe(16);
  });
});

describe("nms", () => {
  it("keeps the best of overlapping boxes and drops a box contained in a better one", () => {
    const ps = [{ box: box(0, 0, 40, 100), score: 0.6 }, { box: box(2, 2, 40, 100), score: 0.9 }, { box: box(10, 40, 20, 40), score: 0.5 }, { box: box(200, 0, 40, 100), score: 0.4 }];
    const out = nms(ps);
    expect(out.map((p) => p.score)).toEqual([0.9, 0.4]);
    expect(iou(ps[0]!.box, ps[1]!.box)).toBeGreaterThan(0.45);
    expect(containment(ps[2]!.box, ps[1]!.box)).toBe(1);
  });
  it("keeps two neighbours that only touch", () => {
    const ps = [{ box: box(0, 0, 30, 80), score: 0.8 }, { box: box(25, 0, 30, 80), score: 0.7 }];
    expect(nms(ps)).toHaveLength(2);
  });
});

describe("settings", () => {
  it("sanitises bad values and knows both models", () => {
    expect(sanitise({ model: "nope" as never, tile: -5, overlap: 2, tileMinScore: 0 })).toEqual({ model: "lite0", tile: 384, overlap: 0.6, tileMinScore: 0.05 });
    expect(sanitise({ model: "lite2", tile: 448.4, overlap: 0.25, tileMinScore: 0.3 }).tile).toBe(448);
    expect(MODELS.lite2.input).toBeGreaterThan(MODELS.lite0.input);
  });
});

describe("feet", () => {
  it("raises the ground point of an upright box by the measured shrink, not of a lying one", () => {
    expect(feet(box(10, 10, 20, 100))).toEqual({ x: 20, y: 110 - 100 * FEET.shrink });
    expect(feet(box(10, 10, 150, 100))).toEqual({ x: 85, y: 110 });
    expect(feet(box(0, 0, 0, 0))).toEqual({ x: 0, y: 0 });
  });
});
