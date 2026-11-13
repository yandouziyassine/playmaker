// Free play: the ball's height files (z<i>.bin, int16 cm per frame, -32768 unknown), synthetic first, then the shipped
// files (app/public/replay, CC BY 4.0) against match.json's frame counts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ABSENT, BALL_REST_M, ballHeightAt, decodeBallZ, type MatchMeta } from "../src/replay/data.ts";

const zbuf = (cm: number[]) => new Int16Array(cm).buffer;

describe("the ball height decoder", () => {
  it("reads one little-endian int16 per frame and checks the length", () => {
    const z = decodeBallZ(zbuf([0, 150, ABSENT, -3]), 4);
    expect([...z]).toEqual([0, 150, ABSENT, -3]);
    expect(() => decodeBallZ(zbuf([1, 2, 3]), 4)).toThrow(/6 bytes, expected 8/);
  });

  it("interpolates between frames like the positions, in metres", () => {
    const z = decodeBallZ(zbuf([100, 300, 500]), 3);
    expect(ballHeightAt(z, 0)).toBeCloseTo(1, 9);
    expect(ballHeightAt(z, 0.5)).toBeCloseTo(2, 9);
    expect(ballHeightAt(z, 1.25)).toBeCloseTo(3.5, 9);
    expect(ballHeightAt(z, 2)).toBeCloseTo(5, 9);
    expect(ballHeightAt(z, 99)).toBeCloseTo(5, 9);   // clamped to the half
    expect(ballHeightAt(z, -4)).toBeCloseTo(1, 9);
  });

  it("an unknown frame takes its neighbour; no data, both unknown or below the grass: the ball rests on it", () => {
    const z = decodeBallZ(zbuf([ABSENT, 400, ABSENT, ABSENT, 2]), 5);
    expect(ballHeightAt(z, 0.5)).toBeCloseTo(4, 9);
    expect(ballHeightAt(z, 1.5)).toBeCloseTo(4, 9);
    expect(ballHeightAt(z, 2.5)).toBe(BALL_REST_M);
    expect(ballHeightAt(z, 4)).toBe(BALL_REST_M);      // 2 cm: below the resting centre
    expect(ballHeightAt(null, 3)).toBe(BALL_REST_M);
    expect(ballHeightAt(undefined, 3)).toBe(BALL_REST_M);
  });
});

describe("the shipped height files", () => {
  const meta = JSON.parse(readFileSync("app/public/replay/match.json", "utf8")) as MatchMeta;
  const load = (i: number) => { const b = readFileSync(`app/public/replay/z${i}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  it("have one value per frame of each half, in a plausible range, with long balls in the air", () => {
    for (const i of [0, 1]) {
      const z = decodeBallZ(load(i), meta.halves[i]!.frames);
      const known = [...z].filter((v) => v !== ABSENT);
      expect(known.length).toBeGreaterThan(z.length * 0.9);
      expect(Math.min(...known)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...known)).toBeLessThan(3000);        // under 30 m
      expect(known.filter((v) => v > 300).length).toBeGreaterThan(500); // above 3 m: crosses, clearances, goal kicks
    }
  });
});
