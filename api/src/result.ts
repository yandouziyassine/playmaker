import type { Answer, PickResult } from "./types.ts";

export const CROWD_MIN = 20;

export function buildResult(a: Answer, option: number, counts: Record<number, number>, repeat: boolean, guess: number | null = null): PickResult {
  const opt = a.options.find((o) => o.k === option)!;
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const crowd = total >= CROWD_MIN ? Object.fromEntries(Object.entries(counts).map(([k, n]) => [Number(k), n / total])) : null;
  return {
    option, points: opt.points, among_best: opt.points === 100, pro_instinct: option === a.pro_pick,
    ai_pick: a.ai_pick, pro_pick: a.pro_pick, outcome: a.outcome,
    reasons: Object.fromEntries(a.options.map((o) => [o.k, o.reasons])), crowd, repeat,
    after: a.after ?? null,
    all_points: Object.fromEntries(a.options.map((o) => [o.k, o.points])),
    guess, guess_right: guess === null ? null : guess === a.pro_pick,
  };
}
