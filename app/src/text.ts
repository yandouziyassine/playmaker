import type { Moment, PickResult } from "./api.ts";

type Opt = Moment["options"][number];

export function optionLabel(mo: Moment, k: number): string {
  const o = mo.options.find((q) => q.k === k);
  if (!o) return "?";
  if (o.kind === "pass") { const p = mo.players[o.player!]!; return `Pass to #${p.shirt} ${p.name}`; }
  if (o.kind === "shot") return "Shoot";
  return `Carry ${carryWord(o)}`;
}

function carryWord(o: Opt): string {
  const a = o.angle ?? 0;
  if (a === 0) return "forward";
  // angles are measured from the attacking direction; positive = towards +y = the player's left
  const side = a > 0 ? "left" : "right";
  return Math.abs(a) >= 60 ? `wide ${side}` : `forward-${side}`;
}

export const OUTCOME_TEXT: Record<PickResult["outcome"]["kind"], string> = {
  goal: "Goal within 15 s", shot: "Shot within 15 s", kept: "Possession kept", lost: "Ball lost",
};

export const tier = (points: number) => (points >= 100 ? "top" : points >= 50 ? "mid" : "low");

export function verdict(r: PickResult, mine: number): string {
  if (mine === r.ai_pick) return "Same pick as the AI coach";
  if (r.among_best) return "Close call: as good as the AI's pick";
  if (r.points >= 50) return "Decent option";
  return "The AI saw better options";
}

export const pct = (x: number) => `${Math.round(x * 100)} %`;

/** The reveal line for the second question ("What did the pro actually do?"), null when no guess was recorded. */
export function proReadLine(mo: Moment, r: PickResult): { cls: "ok" | "miss"; text: string } | null {
  if (r.guess == null || typeof r.guess_right !== "boolean") return null;
  if (r.guess_right) return { cls: "ok", text: "You read the pro" };
  return { cls: "miss", text: `The pro played ${optionLabel(mo, r.pro_pick)} · your read: ${optionLabel(mo, r.guess)}` };
}

/** "Pro reads 3/5" (done screen; the eye icon is added by the page). */
export const readsText = (right: number, of: number) => `Pro reads ${right}/${of}`;

/** "Moment 3 of 5" style progress: one entry per moment, "done" with points or "todo". */
export function progress(points: number[], total: number): string[] {
  return Array.from({ length: total }, (_, i) => (i < points.length ? tier(points[i]!) : i === points.length ? "now" : "todo"));
}
