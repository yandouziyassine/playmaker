import type { Moment, PickResult } from "./api.ts";
import { pct as pctI18n, t, type Key } from "./i18n/index.ts";

type Opt = Moment["options"][number];

export function optionLabel(mo: Moment, k: number): string {
  const o = mo.options.find((q) => q.k === k);
  if (!o) return "?";
  if (o.kind === "pass") { const p = mo.players[o.player!]!; return t("opt.pass", { shirt: p.shirt, name: p.name }); }
  if (o.kind === "shot") return t("opt.shot");
  return t(carryKey(o));
}

function carryKey(o: Opt): Key {
  const a = o.angle ?? 0;
  if (a === 0) return "opt.carry.forward";
  // angles are measured from the attacking direction; positive = towards +y = the player's left
  const left = a > 0;
  if (Math.abs(a) >= 60) return left ? "opt.carry.wideLeft" : "opt.carry.wideRight";
  return left ? "opt.carry.fwdLeft" : "opt.carry.fwdRight";
}

/** "Goal within 15 s", ... in the current language. */
export const outcomeText = (kind: PickResult["outcome"]["kind"]): string => t(`out.${kind}`);

export const tier = (points: number) => (points >= 100 ? "top" : points >= 50 ? "mid" : "low");

export function verdict(r: PickResult, mine: number): string {
  if (mine === r.ai_pick) return t("verdict.same");
  if (r.among_best) return t("verdict.close");
  if (r.points >= 50) return t("verdict.decent");
  return t("verdict.better");
}

export const pct = (x: number) => pctI18n(x);

/** The reveal line for the second question ("What did the pro actually do?"), null when no guess was recorded. */
export function proReadLine(mo: Moment, r: PickResult): { cls: "ok" | "miss"; text: string } | null {
  if (r.guess == null || typeof r.guess_right !== "boolean") return null;
  if (r.guess_right) return { cls: "ok", text: t("pro.read") };
  return { cls: "miss", text: t("pro.miss", { pro: optionLabel(mo, r.pro_pick), guess: optionLabel(mo, r.guess) }) };
}

/** "Pro reads 3/5" (done screen; the eye icon is added by the page). */
export const readsText = (right: number, of: number) => t("done.reads", { right, of });

/** "Moment 3 of 5" style progress: one entry per moment, "done" with points or "todo". */
export function progress(points: number[], total: number): string[] {
  return Array.from({ length: total }, (_, i) => (i < points.length ? tier(points[i]!) : i === points.length ? "now" : "todo"));
}
