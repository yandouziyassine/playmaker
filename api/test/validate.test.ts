import { describe, expect, it } from "vitest";
import { parsePick } from "../src/validate.ts";

const ok = { player: "3f1c2a9e-5b7d-4c1e-9a2b-0d4e6f8a1b2c", moment: "J03WOH-0-1200", option: 3 };

describe("parsePick", () => {
  it("accepts a valid body", () => expect(parsePick(JSON.stringify(ok))).toEqual(ok));
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
