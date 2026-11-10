import { describe, expect, it } from "vitest";
import type { Moment, PickResult } from "../src/api.ts";
import { computeStats, insightFor, toRecord, zoneOf } from "../src/stats.ts";
import type { MomentRecord } from "../src/storage.ts";

let seq = 0;
const rec = (o: Partial<MomentRecord> = {}): MomentRecord => ({
  id: `m${seq++}`, points: 100, among_best: true, pro_instinct: false, same_as_ai: true,
  kind: "pass", zone: "middle", league: "L", outcome: "kept", ...o,
});

describe("zoneOf", () => {
  it("splits the pitch in thirds at 17.5 m either side of halfway", () => {
    expect(zoneOf(-5000)).toBe("build");
    expect(zoneOf(-1751)).toBe("build");
    expect(zoneOf(-1750)).toBe("middle");
    expect(zoneOf(0)).toBe("middle");
    expect(zoneOf(1750)).toBe("middle");
    expect(zoneOf(1751)).toBe("final");
    expect(zoneOf(null)).toBe("middle");
    expect(zoneOf(Number.NaN)).toBe("middle");
  });
});

describe("toRecord", () => {
  const mo = {
    id: "m1", league: "Bundesliga", carrier: 1,
    lead_up: [[[0, 0], [0, 0]], [[-100, 0], [3000, 200]]], ball: [[0, 0], [2990, 200]],
    options: [{ k: 0, kind: "pass", player: 0, to: [0, 0] }, { k: 1, kind: "shot", to: [5250, 0] }],
  } as unknown as Moment;
  const res = {
    option: 1, points: 60, among_best: false, pro_instinct: true, ai_pick: 0, pro_pick: 1,
    outcome: { kind: "shot", net_xg_15s: 0.1 },
  } as PickResult;

  it("keeps the recorded pick, the zone from the carrier's release x, and AI agreement", () => {
    expect(toRecord(mo, res)).toEqual({
      id: "m1", points: 60, among_best: false, pro_instinct: true, same_as_ai: false,
      kind: "shot", zone: "final", league: "Bundesliga", outcome: "shot",
    });
  });

  it("falls back to the ball when the carrier is missing", () => {
    const m2 = { ...mo, lead_up: [[[0, 0], null]], ball: [[-4000, 0]] } as unknown as Moment;
    expect(toRecord(m2, { ...res, option: 0, ai_pick: 0 })).toMatchObject({ zone: "build", kind: "pass", same_as_ai: true });
  });
});

describe("computeStats", () => {
  it("handles no history and old days without records", () => {
    expect(computeStats({}, {})).toMatchObject({ games: 0, moments: 0, avgDay: null, bestDay: null, perfect: null, insight: "" });
    const old = computeStats({ "2026-12-01": [100, 50, 0, 100, 0] }, {});
    expect(old).toMatchObject({ games: 1, avgDay: 250, bestDay: { date: "2026-12-01", total: 250 }, perfect: 0.4, proInstinct: null });
    expect(old.insight).toMatch(/5 more moments/);
  });

  it("ignores corrupt records", () => {
    const bad = { d: [null, { id: 1 }, rec()], e: "x" } as unknown as Record<string, MomentRecord[]>;
    expect(computeStats({ d: [100] }, bad).moments).toBe(1);
  });

  it("aggregates days, rates, zones and kinds", () => {
    const days = { "2026-12-01": [100, 100, 0, 50, 50], "2026-12-02": [100, 100, 100, 100, 0] };
    const moments = {
      "2026-12-01": [
        rec({ zone: "final" }), rec({ zone: "final", pro_instinct: true }), rec({ points: 0, zone: "build", same_as_ai: false }),
        rec({ points: 50, zone: "build", kind: "carry", same_as_ai: false }), rec({ points: 50, kind: "carry", same_as_ai: false }),
      ],
    };
    const s = computeStats(days, moments);
    expect(s.games).toBe(2);
    expect(s.avgDay).toBe(350);
    expect(s.bestDay).toEqual({ date: "2026-12-02", total: 400 });
    expect(s.perfect).toBeCloseTo(0.6);
    expect(s.proInstinct).toBeCloseTo(0.2);
    expect(s.aiAgree).toBeCloseTo(0.4);
    expect(s.byZone).toEqual({ build: { n: 2, avg: 25 }, middle: { n: 1, avg: 50 }, final: { n: 2, avg: 100 } });
    expect(s.byKind.carry).toEqual({ n: 2, avg: 50 });
    expect(s.byKind.shot).toEqual({ n: 0, avg: null });
    expect(s.insight).toBe("You score best in the final third (100) and worst in build-up (25): look for the safe pass when pressed deep.");
  });
});

describe("insight rules", () => {
  const days = { d: [100, 100, 100, 100, 100] };

  it("flags shooting more than the AI", () => {
    const s = computeStats(days, { d: [rec({ kind: "shot", same_as_ai: false }), rec({ kind: "shot", same_as_ai: false }), rec({ kind: "shot" }), rec(), rec()] });
    expect(s.insight).toBe("You shoot more than the AI would: shots chosen 3 times, AI agreed 1.");
  });

  it("flags weak carries when the zones are even", () => {
    const s = computeStats(days, { d: [rec(), rec(), rec({ kind: "carry", points: 0 }), rec({ kind: "carry", points: 50 }), rec()] });
    expect(s.insight).toMatch(/^Your carries average 25 against 100 for passes/);
  });

  it("praises the pro instinct, then AI agreement", () => {
    const pro = computeStats(days, { d: Array.from({ length: 6 }, () => rec({ pro_instinct: true })) });
    expect(pro.insight).toBe("Pro instinct: you made the pro's choice in 100 % of moments.");
    const ai = computeStats(days, { d: Array.from({ length: 6 }, () => rec()) });
    expect(ai.insight).toMatch(/like the AI coach: same pick in 100 %/);
  });

  it("falls back to a neutral line, and asks for more moments first", () => {
    const s = computeStats({ d: [0, 0, 0, 0, 0] }, { d: Array.from({ length: 5 }, () => rec({ points: 0, same_as_ai: false })) });
    expect(s.insight).toMatch(/^Balanced profile/);
    expect(insightFor({ ...s, moments: 4 })).toBe("Answer 1 more moment to unlock your playing profile.");
  });
});
