// Why the coach likes or dislikes an option: port of coach/explain.py. The pass and shot models are logistic
// regressions, so each feature's share of the logit is exact (coef * (x - mean) / scale); the score splits exactly
// into p * gain + (1 - p) * loss. PHRASES and fmt are copied from the library (the parity fixture ships the table).
import type { CoachOption } from "./advice.ts";
import { passFeatures, shotFeatures, type Features, type State } from "./features.ts";
import type { LinearModel, ModelsJson } from "./models.ts";
import { DEFAULT_PC, type PitchControlParams } from "./pitchControl.ts";

export const DEG = 180.0 / Math.PI;
type Spec = { split: "mean" | "zero" | "count" | "none"; scale: number; nd: number } & Record<string, string | number>;
export const PHRASES: { pass: Record<string, Spec>; shot: Record<string, Spec>; value: Record<string, string> } = {
  pass: {
    distance: { split: "mean", scale: 1.0, nd: 0, hi: "long pass ({v} m)", lo: "short pass ({v} m)" },
    forward: { split: "zero", scale: 1.0, nd: 0, hi: "{v} m forward", lo: "{v} m backward" },
    abs_angle: { split: "none", scale: DEG, nd: 0, text: "{v}° off straight ahead" },
    lane_defenders: { split: "count", scale: 1.0, nd: 0, "0": "no defender in the lane", "1": "1 defender in the lane", n: "{v} defenders in the lane" },
    receiver_space: { split: "none", scale: 1.0, nd: 1, text: "receiver has {v} m of space" },
    passer_pressure: { split: "none", scale: 1.0, nd: 1, text: "nearest defender {v} m from the passer" },
    target_control: { split: "none", scale: 100.0, nd: 0, text: "{v} % pitch control at the receiver" },
    target_x: { split: "zero", scale: 1.0, nd: 0, hi: "receiver {v} m into the opponent half", lo: "receiver {v} m inside his own half" },
    target_goal_dist: { split: "none", scale: 1.0, nd: 0, text: "receiver {v} m from goal" },
  },
  shot: {
    goal_dist: { split: "none", scale: 1.0, nd: 0, text: "shot from {v} m" },
    goal_angle: { split: "none", scale: DEG, nd: 0, text: "{v}° of goal mouth visible" },
    cone_defenders: { split: "count", scale: 1.0, nd: 0, "0": "no defender in the shot cone", "1": "1 defender in the shot cone", n: "{v} defenders in the shot cone" },
  },
  value: {
    pass: "{gain} xG if it arrives, {loss} if lost there",
    carry_control: "{pct} % pitch control where the carry ends",
    carry: "{gain} xG if kept, {loss} if lost there",
    shot: "{xg} xG for the shot, {keep} if the ball is kept here",
  },
};
export const TOP_FEATURES = 2;

/** Round half away from zero to nd decimals, as a plain decimal string ("-" only when the rounded value is not 0). */
export function fmt(y: number, nd: number): string {
  const n = Math.floor(Math.abs(y) * 10 ** nd + 0.5);
  let s = String(n).padStart(nd + 1, "0");
  if (nd > 0) s = s.slice(0, -nd) + "." + s.slice(-nd);
  return (y < 0 && n > 0 ? "-" : "") + s;
}
export const signed = (y: number, nd = 3) => { const s = fmt(y, nd); return s.startsWith("-") ? s : "+" + s; };

export interface Contribution { feature: string; x: number; contribution: number }
export interface Explanation {
  kind: CoachOption["kind"];
  contributions: Contribution[]; intercept: number | null;
  valueTerms: Record<string, number>;
  phrases: string[];
  /** +1 the feature helps, -1 it hurts, 0 a value phrase. */
  signs: number[];
}
type Weights = Pick<ModelsJson, "pass" | "shot">;

export function contributions(w: LinearModel, x: Features): Contribution[] {
  return w.features.map((f, i) => ({ feature: f, x: x[f]!, contribution: (w.coef[i]! * (x[f]! - w.mean[i]!)) / w.scale[i]! }));
}

function featurePhrase(table: Record<string, Spec>, w: LinearModel, feature: string, x: number): string {
  const spec = table[feature]!;
  const v = fmt(Math.abs(x) * spec.scale, spec.nd);
  let key: string;
  if (spec.split === "mean") key = x >= w.mean[w.features.indexOf(feature)]! ? "hi" : "lo";
  else if (spec.split === "zero") key = x >= 0 ? "hi" : "lo";
  else if (spec.split === "count") key = v === "0" || v === "1" ? v : "n";
  else key = "text";
  return String(spec[key]).replace("{v}", v);
}

function valuePhrases(o: CoachOption, vNow: number): { texts: string[]; terms: Record<string, number> } {
  const t = PHRASES.value as Record<"pass" | "carry" | "carry_control" | "shot", string>;
  if (o.kind === "shot") {
    const terms = { xg: o.p, keep: vNow };
    return { texts: [t.shot.replace("{xg}", signed(terms.xg)).replace("{keep}", signed(terms.keep))], terms };
  }
  const terms = { gain: o.value - vNow, loss: -(o.vLost as number) - vNow };
  const texts = [t[o.kind].replace("{gain}", signed(terms.gain)).replace("{loss}", signed(terms.loss))];
  if (o.kind === "carry") texts.unshift(t.carry_control.replace("{pct}", fmt(o.p * 100.0, 0)));
  return { texts, terms };
}

/** Explanation of one option. `features`: passFeatures (pass) or shotFeatures (shot); unused for a carry. */
export function explain(o: CoachOption, vNow: number, models: Weights, features?: Features): Explanation {
  const out: Explanation = { kind: o.kind, contributions: [], intercept: null, valueTerms: {}, phrases: [], signs: [] };
  if (o.kind !== "carry") {
    const w = models[o.kind];
    const cs = contributions(w, features as Features);
    out.contributions = cs;
    out.intercept = w.intercept;
    const order = cs.map((_, i) => i).sort((a, b) => Math.abs(cs[b]!.contribution) - Math.abs(cs[a]!.contribution) || a - b);
    for (const i of order.slice(0, TOP_FEATURES)) {
      const c = cs[i]!;
      out.phrases.push(featurePhrase(PHRASES[o.kind], w, c.feature, c.x));
      out.signs.push(c.contribution >= 0 ? 1 : -1);
    }
  }
  const { texts, terms } = valuePhrases(o, vNow);
  out.valueTerms = terms;
  out.phrases.push(...texts);
  out.signs.push(...texts.map(() => 0));
  return out;
}

/** explain() for every option of advice.options(s, carrier), same order. */
export function explainOptions(s: State, carrier: number, opts: CoachOption[], models: Weights, vNow: number, pc: PitchControlParams = DEFAULT_PC): Explanation[] {
  const here = s.att[carrier]!;
  return opts.map((o) => {
    const f = o.kind === "pass" ? passFeatures(s, carrier, s.attIdx.indexOf(o.target as number), pc) : o.kind === "shot" ? shotFeatures(here, s.def) : undefined;
    return explain(o, vNow, models, f);
  });
}
