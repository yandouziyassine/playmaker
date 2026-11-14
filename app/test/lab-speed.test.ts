import { describe, expect, it } from "vitest";
import { addTime, newProf, profSummary, resetProf, timed, labProf } from "../src/lab/prof.ts";
import { nextIdle, poolSize } from "../src/lab/tilepool.ts";

describe("stage profiler", () => {
  it("accumulates time and calls per stage", () => {
    const p = newProf();
    addTime(p, "a", 10); addTime(p, "a", 5, 2); addTime(p, "b", 1);
    expect(p).toEqual({ a: { ms: 15, n: 3 }, b: { ms: 1, n: 1 } });
  });
  it("summarises per frame, slowest first", () => {
    const p = newProf();
    addTime(p, "fast", 4, 4); addTime(p, "slow", 100, 2);
    const s = profSummary(p, 2);
    expect(s.map((r) => r.stage)).toEqual(["slow", "fast"]);
    expect(s[0]).toMatchObject({ msPerFrame: 50, perFrame: 1, msPerCall: 50 });
    expect(s[1]).toMatchObject({ msPerFrame: 2, perFrame: 2, msPerCall: 1 });
    expect(profSummary(newProf(), 0)).toEqual([]);
  });
  it("times a call into the running instance and passes its value through (also when it throws)", () => {
    resetProf();
    expect(timed("x", () => 42)).toBe(42);
    expect(() => timed("x", () => { throw new Error("boom"); })).toThrow("boom");
    expect(labProf.x!.n).toBe(2);
    expect((globalThis as { __clipProf?: unknown }).__clipProf).toBe(labProf);
  });
});

describe("tile pool", () => {
  it("leaves two cores free, at most six workers, none on a dual core", () => {
    expect(poolSize(8)).toBe(6);
    expect(poolSize(16)).toBe(6);
    expect(poolSize(4)).toBe(2);
    expect(poolSize(2)).toBe(0);
    expect(poolSize(undefined)).toBe(0);
    expect(poolSize(12, 4)).toBe(4);
  });
  it("hands the next job to the first idle worker", () => {
    expect(nextIdle([true, false, false])).toBe(1);
    expect(nextIdle([true, true])).toBe(-1);
    expect(nextIdle([])).toBe(-1);
  });
});
