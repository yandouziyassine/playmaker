// Closed-form pitch control: port of coach/pitch_control.py. Each player reacts for `reaction` s (moving with his
// current velocity), then runs straight at `vmax`; a team's control of a point is a logistic function of the gap
// between the fastest defender's and the fastest attacker's arrival times (sigma = arrival-time uncertainty).
import type { Vec } from "./geometry.ts";

export interface PitchControlParams { reaction: number; vmax: number; sigma: number }
export const DEFAULT_PC: PitchControlParams = { reaction: 0.7, vmax: 5.0, sigma: 0.45 };

/** Arrival time of one player at a point; Infinity for a missing (NaN) player. */
export function timeToReach(pos: Vec, vel: Vec, point: Vec, pc: PitchControlParams): number {
  const sx = pos[0] + vel[0] * pc.reaction, sy = pos[1] + vel[1] * pc.reaction;
  const dx = point[0] - sx, dy = point[1] - sy;
  const t = pc.reaction + Math.sqrt(dx * dx + dy * dy) / pc.vmax; // np.linalg.norm in the Python
  return Number.isNaN(t) ? Infinity : t;
}

/** Probability that the attacking team controls the point. */
export function control(point: Vec, att: Vec[], attV: Vec[], def: Vec[], defV: Vec[], pc: PitchControlParams = DEFAULT_PC): number {
  let ta = Infinity, td = Infinity;
  for (let i = 0; i < att.length; i++) ta = Math.min(ta, timeToReach(att[i]!, attV[i]!, point, pc));
  for (let i = 0; i < def.length; i++) td = Math.min(td, timeToReach(def[i]!, defV[i]!, point, pc));
  const scale = Math.PI / Math.sqrt(3) / pc.sigma;
  return 1 / (1 + Math.exp(-scale * Math.max(-50, Math.min(50, td - ta))));
}
