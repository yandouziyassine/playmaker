// Features for the coach's three models from one normalised frame state (the team in question attacks +x): port of
// coach/features.py. Names and order match models.json; norms are sqrt(dx² + dy²) like np.linalg.norm.
import { GOAL_HALF_WIDTH, HALF_LENGTH, goalGeometry, type Vec } from "./geometry.ts";
import { DEFAULT_PC, control, type PitchControlParams } from "./pitchControl.ts";

export const PASS_FEATURES = ["distance", "forward", "abs_angle", "lane_defenders", "receiver_space", "passer_pressure",
  "target_control", "target_x", "target_goal_dist"] as const;
export const VALUE_FEATURES = ["x", "abs_y", "goal_dist", "goal_angle", "in_box", "near_goal", "mid_goal", "far_goal",
  "x_sq", "angle_near"] as const;
export const SHOT_FEATURES = ["goal_dist", "goal_angle", "cone_defenders"] as const;
export const LANE_WIDTH = 2.0;

/** One frame from the point of view of the attacking team (rows of att / def follow ascending player index). */
export interface State {
  att: Vec[]; attV: Vec[]; def: Vec[]; defV: Vec[];
  attIdx: number[]; defIdx: number[]; ball: Vec; direction: number;
}
export type Features = Record<string, number>;

/** Feature dict -> vector in a model's order. */
export const vector = (f: Features, names: readonly string[]): number[] => names.map((k) => f[k]!);
const norm = (x: number, y: number) => Math.sqrt(x * x + y * y);

/** Distance from p to the segment a-b and the projection parameter t in [0, 1]. */
export function segmentDist(p: Vec, a: Vec, b: Vec): { d: number; t: number } {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const raw = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / Math.max(abx * abx + aby * aby, 1e-9);
  const t = Math.min(1, Math.max(0, raw));
  return { d: norm(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby)), t };
}

export function passFeatures(s: State, passer: number, target: number, pc: PitchControlParams = DEFAULT_PC): Features {
  const a = s.att[passer]!, b = s.att[target]!;
  let lane = 0, space = Infinity, pressure = Infinity;
  for (const p of s.def) {
    const { d, t } = segmentDist(p, a, b);
    if (d < LANE_WIDTH && t > 0.05 && t < 0.95) lane++;
    space = Math.min(space, norm(p[0] - b[0], p[1] - b[1]));
    pressure = Math.min(pressure, norm(p[0] - a[0], p[1] - a[1]));
  }
  return {
    distance: norm(b[0] - a[0], b[1] - a[1]),
    forward: b[0] - a[0],
    abs_angle: Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0])),
    lane_defenders: lane,
    receiver_space: space,
    passer_pressure: pressure,
    target_control: control(b, s.att, s.attV, s.def, s.defV, pc),
    target_x: b[0],
    target_goal_dist: goalGeometry(b).dist,
  };
}

export function valueFeatures(ball: Vec): Features {
  const { dist: gd, angle: ga } = goalGeometry(ball);
  const near = Math.exp(-gd / 8.0);
  return {
    x: ball[0],
    abs_y: Math.abs(ball[1]),
    goal_dist: gd,
    goal_angle: ga,
    in_box: Math.abs(ball[1]) < 20.16 && ball[0] > HALF_LENGTH - 16.5 ? 1 : 0,
    near_goal: near,
    mid_goal: Math.exp(-gd / 20.0),
    far_goal: Math.exp(-gd / 50.0),
    x_sq: (ball[0] / HALF_LENGTH) ** 2,
    angle_near: ga * near,
  };
}

/** Where a pass from a to b is most likely lost: the nearest defender's projection on the lane (t clipped to
 *  [0.1, 0.95]), or the lane midpoint when no defender is within `reach` metres of it. */
export function laneLossPoint(s: State, a: Vec, b: Vec, reach = 10.0): Vec {
  let best = Infinity, tk = 0;
  for (const p of s.def) {
    const { d, t } = segmentDist(p, a, b);
    if (d < best) { best = d; tk = t; }
  }
  if (best > reach) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const t = Math.min(0.95, Math.max(0.1, tk));
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** Defenders inside the triangle ball-post-post count as blocking the shot. */
export function shotFeatures(ball: Vec, defenders: Vec[]): Features {
  const { dist, angle } = goalGeometry(ball);
  const tri: Vec[] = [ball, [HALF_LENGTH, GOAL_HALF_WIDTH], [HALF_LENGTH, -GOAL_HALF_WIDTH]];
  const inside = (p: Vec) => {
    const s = [0, 1, 2].map((i) => {
      const a = tri[i]!, b = tri[(i + 1) % 3]!;
      return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    });
    return s.every((v) => v >= 0) || s.every((v) => v <= 0);
  };
  return { goal_dist: dist, goal_angle: angle, cone_defenders: defenders.filter(inside).length };
}
