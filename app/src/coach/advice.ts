// Rank the ball carrier's options in expected-goal units: port of coach/advice.py. For each pass and carry,
// score = p * V(target) - (1 - p) * V_opp(loss point) - V(now), where V_opp is the value for the opponent (point
// mirrored) and the loss point is where a failed pass is lost (laneLossPoint) or the carry point itself. A shot within
// shot_range scores xG - V(now). Sorted best first; ties keep insertion order (Python's sorted is stable too).
import { PASS_FEATURES, SHOT_FEATURES, VALUE_FEATURES, laneLossPoint, passFeatures, shotFeatures, valueFeatures, vector, type State } from "./features.ts";
import { HALF_LENGTH, HALF_WIDTH, type Vec } from "./geometry.ts";
import { control, type PitchControlParams } from "./pitchControl.ts";

export type Predict = (x: number[]) => number;
export interface AdviceParams { carry_dist: number; carry_angles_deg: number[]; shot_range: number }
export interface Coach { predict: { pass: Predict; value: Predict; arrival?: Predict; shot: Predict }; pc: PitchControlParams; advice: AdviceParams }
export interface CoachOption {
  kind: "pass" | "carry" | "shot";
  target?: number;   // pass: player index (match.json players)
  angle?: number;    // carry: degrees in the normalised frame, > 0 = to the carrier's left
  to: Vec;           // normalised end point
  p: number;         // pass arrives / team keeps the ball at the carry point / shot is a goal
  value: number;     // V(to); 1 for a shot
  vLost?: number;    // V_opp(loss point)
  score: number;     // expected change in net xG
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const valueAt = (coach: Coach, p: Vec) => coach.predict.value(vector(valueFeatures(p), VALUE_FEATURES));
/** V(target) of a pass that arrives: the arrival model when the export has one, else the possession value. */
export const arrivalAt = (coach: Coach, p: Vec) => (coach.predict.arrival ?? coach.predict.value)(vector(valueFeatures(p), VALUE_FEATURES));

export function options(s: State, carrier: number, coach: Coach): CoachOption[] {
  const out: CoachOption[] = [], loss: Vec[] = [];
  const here = s.att[carrier]!;
  for (let j = 0; j < s.att.length; j++) {
    if (j === carrier) continue;
    const p = coach.predict.pass(vector(passFeatures(s, carrier, j, coach.pc), PASS_FEATURES));
    const b = s.att[j]!;
    out.push({ kind: "pass", target: s.attIdx[j], to: [b[0], b[1]], p, value: 0, score: 0 });
    loss.push(laneLossPoint(s, here, b));
  }
  for (const a of coach.advice.carry_angles_deg) {
    const r = a * (Math.PI / 180); // np.radians
    const to: Vec = [
      clamp(here[0] + coach.advice.carry_dist * Math.cos(r), -HALF_LENGTH, HALF_LENGTH),
      clamp(here[1] + coach.advice.carry_dist * Math.sin(r), -HALF_WIDTH, HALF_WIDTH),
    ];
    out.push({ kind: "carry", angle: a, to, p: control(to, s.att, s.attV, s.def, s.defV, coach.pc), value: 0, score: 0 });
    loss.push(to);
  }
  const vNow = valueAt(coach, here);
  out.forEach((o, i) => {
    o.value = o.kind === "pass" ? arrivalAt(coach, o.to) : valueAt(coach, o.to);
    const l = loss[i]!;
    o.vLost = valueAt(coach, [-l[0], -l[1]]); // the opponent attacks the other way
    o.score = o.p * o.value - (1 - o.p) * o.vLost - vNow;
  });
  const sf = shotFeatures(here, s.def);
  if (sf.goal_dist! <= coach.advice.shot_range) {
    const p = coach.predict.shot(vector(sf, SHOT_FEATURES));
    out.push({ kind: "shot", to: [HALF_LENGTH, 0], p, value: 1, score: p - vNow });
  }
  return out.map((o, i) => ({ o, i })).sort((x, y) => y.o.score - x.o.score || x.i - y.i).map(({ o }) => o);
}
