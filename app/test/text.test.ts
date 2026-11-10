import { expect, it } from "vitest";
import type { Moment, PickResult } from "../src/api.ts";
import { optionLabel, progress, tier, verdict } from "../src/text.ts";

const mo = {
  players: [{ side: 0, shirt: 10, name: "A. Ten" }, { side: 0, shirt: 9, name: "B. Nine" }],
  options: [
    { k: 0, kind: "pass", player: 1, to: [0, 0] },
    { k: 1, kind: "carry", angle: 0, to: [0, 0] },
    { k: 2, kind: "carry", angle: 60, to: [0, 0] },
    { k: 3, kind: "carry", angle: -30, to: [0, 0] },
    { k: 4, kind: "shot", to: [5250, 0] },
  ],
} as unknown as Moment;

it("labels options", () => {
  expect([0, 1, 2, 3, 4].map((k) => optionLabel(mo, k))).toEqual([
    "Pass to #9 B. Nine", "Carry forward", "Carry wide left", "Carry forward-right", "Shoot",
  ]);
});

it("tiers, verdicts and progress", () => {
  expect([100, 90, 50, 49, 0].map(tier)).toEqual(["top", "mid", "mid", "low", "low"]);
  const r = { ai_pick: 2, among_best: true, points: 100 } as PickResult;
  expect(verdict(r, 2)).toBe("Same pick as the AI coach");
  expect(verdict(r, 1)).toBe("Close call: as good as the AI's pick");
  expect(verdict({ ...r, among_best: false, points: 20 }, 1)).toBe("The AI saw better options");
  expect(progress([100, 30], 5)).toEqual(["top", "low", "now", "todo", "todo"]);
});
