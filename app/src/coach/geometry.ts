// Pitch geometry: port of coach/geometry.py (COMPUTER-VISION-PROJECT-LIBRARY, project 20). Metres, centre spot =
// origin. "Normalised" frame: the team in question attacks towards +x (goal centre at (52.5, 0)).

export type Vec = [number, number];
export const HALF_LENGTH = 52.5, HALF_WIDTH = 34.0, GOAL_HALF_WIDTH = 3.66;

/** Rotate by 180° when the team attacks towards -x (keeps left/right consistent). Its own inverse. */
export function normalise(p: Vec, direction: number): Vec {
  return direction === 1 ? [p[0], p[1]] : [-p[0], -p[1]];
}

/** Distance to the goal centre and opening angle between the posts (radians) of a normalised point. */
export function goalGeometry(p: Vec): { dist: number; angle: number } {
  const dx = HALF_LENGTH - p[0];
  const dist = Math.hypot(dx, p[1]);
  if (dx <= 1e-9) return { dist, angle: Math.abs(p[1]) <= GOAL_HALF_WIDTH ? Math.PI : 0 };
  const a1 = Math.atan2(GOAL_HALF_WIDTH - p[1], dx), a2 = Math.atan2(-GOAL_HALF_WIDTH - p[1], dx);
  let angle = Math.abs(a1 - a2);
  if (angle > Math.PI) angle = 2 * Math.PI - angle;
  return { dist, angle };
}
