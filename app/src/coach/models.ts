// The exported model weights (app/public/coach/models.json, written by the library's coach/export.py): StandardScaler
// + logistic regression (pass, shot) or ridge (value). score = ((x - mean) / scale) . coef + intercept; probability =
// sigmoid(score) for link "logit", the score itself for "identity".
import type { AdviceParams, Coach } from "./advice.ts";
import { PASS_FEATURES, SHOT_FEATURES, VALUE_FEATURES } from "./features.ts";
import type { PitchControlParams } from "./pitchControl.ts";

export interface LinearModel { features: string[]; link: "logit" | "identity"; mean: number[]; scale: number[]; coef: number[]; intercept: number }
export interface ModelsJson {
  trained_without: string; trained_on: string[];
  /** The shot model's training data: IDSSE matches (Bundesliga), SkillCorner matches (A-League) and the shots used. */
  shot_trained_on?: { idsse: string[]; skillcorner_matches: number; shots: number };
  pass: LinearModel; value: LinearModel & { horizon_s?: number };
  /** Value of a pass target if the pass arrives (cut-back fix); same features as value. Passes only. */
  arrival?: LinearModel & { horizon_s?: number }; shot: LinearModel;
  pitch_control: PitchControlParams; advice: AdviceParams;
}

export function predictLinear(m: LinearModel, x: readonly number[]): number {
  let z = m.intercept;
  for (let i = 0; i < x.length; i++) z += ((x[i]! - m.mean[i]!) / m.scale[i]!) * m.coef[i]!;
  return m.link === "logit" ? 1 / (1 + Math.exp(-z)) : z;
}

function check(m: LinearModel, names: readonly string[], what: string) {
  if (m.features.join() !== names.join()) throw new Error(`${what} features [${m.features}] differ from the port's [${names}]`);
}

export function coachFromModels(w: ModelsJson): Coach {
  check(w.pass, PASS_FEATURES, "pass");
  check(w.value, VALUE_FEATURES, "value");
  if (w.arrival) check(w.arrival, VALUE_FEATURES, "arrival");
  check(w.shot, SHOT_FEATURES, "shot");
  return {
    predict: { pass: (x) => predictLinear(w.pass, x), value: (x) => predictLinear(w.value, x), arrival: w.arrival ? (x) => predictLinear(w.arrival!, x) : undefined, shot: (x) => predictLinear(w.shot, x) },
    pc: w.pitch_control,
    advice: w.advice,
  };
}
