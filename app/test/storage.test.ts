import { beforeEach, expect, it } from "vitest";
import { History } from "../src/storage.ts";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
let h: History;
beforeEach(() => { h = new History(mem()); });

it("keeps one player id", () => { expect(h.player()).toMatch(/^[0-9a-f-]{36}$/); expect(h.player()).toBe(h.player()); });

it("streak counts consecutive days played on the day", () => {
  h.finish("2026-12-01", [100, 0, 0, 0, 0]); h.finish("2026-12-02", [100, 100, 0, 0, 0]);
  expect(h.streak("2026-12-02")).toBe(2);
  expect(h.streak("2026-12-03")).toBe(2); // today not played yet: still alive
  expect(h.streak("2026-12-04")).toBe(0);
});

it("archive days do not count for the streak", () => {
  h.finish("2026-12-01", [1, 2, 3, 4, 5], false);
  expect(h.days()["2026-12-01"]).toEqual([1, 2, 3, 4, 5]);
  expect(h.streak("2026-12-01")).toBe(0);
});

it("per-moment records: upsert by id, old days without records still work", () => {
  h.finish("2026-11-30", [100, 0, 0, 0, 0]); // played before records existed
  const r = { id: "a", points: 50, among_best: false, pro_instinct: false, same_as_ai: false, kind: "pass", zone: "build", league: "L", outcome: "kept" } as const;
  h.record("2026-12-01", r);
  h.record("2026-12-01", { ...r, points: 100 });
  h.record("2026-12-01", { ...r, id: "b" });
  expect(h.moments()["2026-12-01"]!.map((x) => [x.id, x.points])).toEqual([["a", 100], ["b", 50]]);
  expect(h.moments()["2026-11-30"]).toBeUndefined();
  expect(h.days()["2026-11-30"]).toEqual([100, 0, 0, 0, 0]);
});

it("corrupt moment storage reads as empty", () => {
  const m = new Map<string, string>([["pm.moments", "[1,2]"]]);
  const c = new History({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) });
  expect(c.moments()).toEqual({});
  m.set("pm.moments", "{oops"); expect(c.moments()).toEqual({});
});

it("flags and a throwing storage", () => {
  const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
  const b = new History(bad);
  const id = b.player(); expect(id).toMatch(/^[0-9a-f-]{36}$/); expect(b.player()).toBe(id);
  b.finish("2026-12-01", [1, 2, 3, 4, 5]); expect(b.streak("2026-12-01")).toBe(1);
  expect(b.flag("x")).toBe(false); b.setFlag("x"); expect(b.flag("x")).toBe(true);
});
