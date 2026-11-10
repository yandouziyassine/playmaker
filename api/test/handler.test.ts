import { describe, expect, it } from "vitest";
import { handlePick } from "../src/handler.ts";
import { MemoryStore } from "../src/memoryStore.ts";
import type { Answer, Deps } from "../src/types.ts";

const answer: Answer = {
  schema: 1, id: "M1",
  options: [
    { k: 0, score: 0.02, p: 0.8, share_top: 0.7, points: 100, reasons: ["receiver has 6.2 m of space"] },
    { k: 1, score: 0.01, p: 0.9, share_top: 0.3, points: 100, reasons: [] },
    { k: 2, score: -0.01, p: 0.5, share_top: 0, points: 0, reasons: ["2 defenders in the lane"] },
  ],
  ai_pick: 0, pro_pick: 2, outcome: { kind: "kept", net_xg_15s: 0.004 },
  models: { content_version: 1, trained_without: "X", refits: 20 },
};
const P = (n: number) => `3f1c2a9e-5b7d-4c1e-9a2b-${String(n).padStart(12, "0")}`;
const deps = (over: Partial<Deps> = {}): Deps => ({
  store: new MemoryStore(), answer: async (m) => (m === "M1" ? answer : null),
  momentDate: async (m) => (m === "M1" ? "2026-12-01" : null), today: () => "2026-12-01", ipHash: (ip) => "h" + ip, ...over,
});
const body = (player: string, option: number, moment = "M1") => JSON.stringify({ player, moment, option });

describe("handlePick", () => {
  it("scores a pick and reveals the answer", async () => {
    const r = await handlePick(body(P(1), 2), "1.1.1.1", deps());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ points: 0, among_best: false, pro_instinct: true, ai_pick: 0, pro_pick: 2, crowd: null, repeat: false });
  });
  it("first pick wins", async () => {
    const d = deps();
    await handlePick(body(P(1), 2), "1.1.1.1", d);
    const r = await handlePick(body(P(1), 0), "1.1.1.1", d);
    expect(r.body).toMatchObject({ points: 0, repeat: true });
    expect(await d.store.counts("M1")).toEqual({ 2: 1 });
  });
  it("shows the crowd from 20 picks", async () => {
    const d = deps();
    for (let i = 0; i < 20; i++) await handlePick(body(P(i), i % 2), `10.0.0.${i}`, d);
    const r = await handlePick(body(P(99), 0), "9.9.9.9", d);
    expect(r.body.crowd).toEqual({ 0: 11 / 21, 1: 10 / 21 });
  });
  it("rejects invalid, unknown, future and rate-limited requests", async () => {
    expect((await handlePick("{", "1.1.1.1", deps())).status).toBe(400);
    expect((await handlePick(body(P(1), 9), "1.1.1.1", deps())).status).toBe(400);
    expect((await handlePick(body(P(1), 0, "M2"), "1.1.1.1", deps())).status).toBe(404);
    expect((await handlePick(body(P(1), 0), "1.1.1.1", deps({ today: () => "2026-11-29" }))).status).toBe(404);
    const d = deps();
    for (let i = 0; i < 50; i++) await handlePick(body(P(i), 0), "7.7.7.7", d);
    expect((await handlePick(body(P(77), 0), "7.7.7.7", d)).status).toBe(429);
  });
});
