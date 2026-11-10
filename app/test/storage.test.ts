// app/test/storage.test.ts
import { beforeEach, expect, it } from "vitest";
import { History } from "../src/storage.ts";
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
let h: History;
beforeEach(() => { h = new History(mem()); });
it("keeps one player id", () => { expect(h.player()).toMatch(/^[0-9a-f-]{36}$/); expect(h.player()).toBe(h.player()); });
it("streak counts consecutive finished days", () => {
  h.finish("2026-12-01", [100, 0, 0, 0, 0]); h.finish("2026-12-02", [100, 100, 0, 0, 0]);
  expect(h.streak("2026-12-02")).toBe(2);
  expect(h.streak("2026-12-04")).toBe(0);
});
it("survives a throwing storage", () => {
  const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
  const b = new History(bad); expect(b.player()).toMatch(/^[0-9a-f-]{36}$/); b.finish("2026-12-01", [1, 2, 3, 4, 5]);
});
