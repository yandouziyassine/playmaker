import { describe, expect, it } from "vitest";
import { handleBank, handlePick, handleTrain, RATE_TRAIN_PER_DAY } from "../src/handler.ts";
import { MemoryStore } from "../src/memoryStore.ts";
import { parseTrain } from "../src/validate.ts";
import type { Answer, Deps } from "../src/types.ts";

const answer = (id: string): Answer => ({
  schema: 1, id,
  options: [
    { k: 0, score: 0.02, p: 0.8, share_top: 0.7, points: 100, reasons: [] },
    { k: 1, score: -0.01, p: 0.5, share_top: 0, points: 20, reasons: [] },
  ],
  ai_pick: 0, pro_pick: 1, outcome: { kind: "kept", net_xg_15s: 0.004 },
  models: { content_version: 1, trained_without: "X", refits: 20 },
});
const DATES: Record<string, string> = { OLD: "2026-11-30", OLD2: "2026-11-29", TODAY: "2026-12-01", NEXT: "2026-12-02" };
const deps = (over: Partial<Deps> = {}): Deps => ({
  store: new MemoryStore(), answer: async (m) => (m in DATES ? answer(m) : null), momentDate: async (m) => DATES[m] ?? null,
  today: () => "2026-12-01", ipHash: (ip) => "h" + ip, bank: async () => Object.entries(DATES).map(([id, date]) => ({ id, date })), ...over,
});
const body = (moment: string, option: number, guess?: number) => JSON.stringify(guess === undefined ? { moment, option } : { moment, option, guess });

describe("training API", () => {
  it("validates the request: moment and option, an optional guess, nothing else", () => {
    expect(parseTrain(body("OLD", 1))).toEqual({ moment: "OLD", option: 1, guess: null });
    expect(parseTrain(body("OLD", 1, 0))).toEqual({ moment: "OLD", option: 1, guess: 0 });
    expect(parseTrain(JSON.stringify({ moment: "OLD", option: 1, player: "x" }))).toBeNull();
    expect(parseTrain(JSON.stringify({ moment: "OLD", option: 1, guess: null }))).toBeNull();
    expect(parseTrain("{")).toBeNull();
  });
  it("scores a past moment, and the same moment again with another answer (not stored, no crowd)", async () => {
    const d = deps();
    const a = await handleTrain(body("OLD", 1, 1), "1", d);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ option: 1, points: 20, guess: 1, guess_right: true, crowd: null, repeat: false });
    const b = await handleTrain(body("OLD", 0), "1", d);
    expect(b.body).toMatchObject({ option: 0, points: 100, repeat: false });
  });
  it("never answers today's or a future day's moments (the daily game's answers stay hidden)", async () => {
    expect((await handleTrain(body("TODAY", 0), "1", deps())).status).toBe(404);
    expect((await handleTrain(body("NEXT", 0), "1", deps())).status).toBe(404);
    expect((await handleTrain(body("NOPE", 0), "1", deps())).status).toBe(404);
    expect((await handleTrain(body("OLD", 9), "1", deps())).status).toBe(400);
  });
  it("does not touch the daily game: a training answer is not the player's first answer", async () => {
    const d = deps({ today: () => "2026-12-01" });
    await handleTrain(body("OLD", 1), "1", d);
    expect(await d.store.getPick("3f1c2a9e-5b7d-4c1e-9a2b-000000000001", "OLD")).toBeNull();
    expect(await d.store.counts("OLD")).toEqual({});
    const daily = await handlePick(JSON.stringify({ player: "3f1c2a9e-5b7d-4c1e-9a2b-000000000001", moment: "TODAY", option: 0 }), "1", d);
    expect(daily.body).toMatchObject({ repeat: false });
  });
  it("has its own daily limit per network", async () => {
    const d = deps();
    for (let i = 0; i < RATE_TRAIN_PER_DAY; i++) expect((await handleTrain(body("OLD", 0), "9", d)).status).toBe(200);
    expect((await handleTrain(body("OLD", 0), "9", d)).status).toBe(429);
    expect((await handleTrain(body("OLD", 0), "8", d)).status).toBe(200);
  });
  it("lists the bank: every moment of the days before today, oldest first", async () => {
    expect((await handleBank(deps())).body).toEqual({ moments: ["OLD2", "OLD"] });
    expect((await handleBank(deps({ bank: undefined }))).body).toEqual({ moments: [] });
  });
});
