import { describe, expect, it } from "vitest";
import { parsePick } from "../src/validate.ts";

const ok = { player: "3f1c2a9e-5b7d-4c1e-9a2b-0d4e6f8a1b2c", moment: "J03WOH-0-1200", option: 3 };

describe("parsePick", () => {
  it("accepts an old body without a guess (guess null)", () => expect(parsePick(JSON.stringify(ok))).toEqual({ ...ok, guess: null }));
  it("accepts a body with the pro guess", () => expect(parsePick(JSON.stringify({ ...ok, guess: 5 }))).toEqual({ ...ok, guess: 5 }));
  it("rejects a bad guess", () => {
    for (const guess of [-1, 64, 1.5, "2", null, true]) expect(parsePick(JSON.stringify({ ...ok, guess }))).toBeNull();
    expect(parsePick(JSON.stringify({ ...ok, guess: 1, extra: 1 }))).toBeNull();
  });
  it("rejects bad uuid, id, option, size and junk", () => {
    expect(parsePick(JSON.stringify({ ...ok, player: "x" }))).toBeNull();
    expect(parsePick(JSON.stringify({ ...ok, moment: "../etc" }))).toBeNull();
    expect(parsePick(JSON.stringify({ ...ok, option: -1 }))).toBeNull();
    expect(parsePick(JSON.stringify({ ...ok, option: 2.5 }))).toBeNull();
    expect(parsePick("x".repeat(1025))).toBeNull();
    expect(parsePick("{")).toBeNull();
    expect(parsePick(JSON.stringify({ ...ok, extra: 1 }))).toBeNull();
  });
});
