// Pitch model (105 x 68 m, metres, centre spot at 0,0) seen from the main TV camera:
// x grows from the LEFT goal (-52.5) to the RIGHT goal (+52.5); y grows from the NEAR touchline (-34,
// the camera side, bottom of a TV picture) to the FAR touchline (+34).
import type { Pt } from "./homography.ts";

export const PITCH = { length: 105, width: 68, halfL: 52.5, halfW: 34 } as const;
const BOX = { depth: 16.5, halfW: 20.16 };      // penalty area: 16.5 m deep, 40.32 m wide
const SIX = { depth: 5.5, halfW: 9.16 };        // goal area: 5.5 m deep, 18.32 m wide
const SPOT = 11, CIRCLE_R = 9.15, GOAL_HALF = 3.66;

export type Landmark = { id: string; label: string; x: number; y: number };

function sideMarks(side: "L" | "R"): Landmark[] {
  const s = side === "L" ? -1 : 1, name = side === "L" ? "Left" : "Right";
  const gx = s * PITCH.halfL, bx = s * (PITCH.halfL - BOX.depth), ax = s * (PITCH.halfL - SIX.depth);
  return [
    { id: `${side}-corner-far`, label: `${name} corner flag, far`, x: gx, y: PITCH.halfW },
    { id: `${side}-corner-near`, label: `${name} corner flag, near`, x: gx, y: -PITCH.halfW },
    { id: `${side}-box-goal-far`, label: `${name} penalty box: goal line, far`, x: gx, y: BOX.halfW },
    { id: `${side}-box-goal-near`, label: `${name} penalty box: goal line, near`, x: gx, y: -BOX.halfW },
    { id: `${side}-box-edge-far`, label: `${name} penalty box: front corner, far`, x: bx, y: BOX.halfW },
    { id: `${side}-box-edge-near`, label: `${name} penalty box: front corner, near`, x: bx, y: -BOX.halfW },
    { id: `${side}-six-goal-far`, label: `${name} goal area: goal line, far`, x: gx, y: SIX.halfW },
    { id: `${side}-six-goal-near`, label: `${name} goal area: goal line, near`, x: gx, y: -SIX.halfW },
    { id: `${side}-six-edge-far`, label: `${name} goal area: front corner, far`, x: ax, y: SIX.halfW },
    { id: `${side}-six-edge-near`, label: `${name} goal area: front corner, near`, x: ax, y: -SIX.halfW },
    { id: `${side}-spot`, label: `${name} penalty spot`, x: s * (PITCH.halfL - SPOT), y: 0 },
  ];
}

export const LANDMARKS: Landmark[] = [
  { id: "half-far", label: "Halfway line, far touchline", x: 0, y: PITCH.halfW },
  { id: "half-near", label: "Halfway line, near touchline", x: 0, y: -PITCH.halfW },
  { id: "centre", label: "Centre spot", x: 0, y: 0 },
  { id: "circle-far", label: "Centre circle meets halfway line, far", x: 0, y: CIRCLE_R },
  { id: "circle-near", label: "Centre circle meets halfway line, near", x: 0, y: -CIRCLE_R },
  ...sideMarks("L"),
  ...sideMarks("R"),
];

export function landmark(id: string): Landmark | undefined {
  return LANDMARKS.find((l) => l.id === id);
}

/** Default 4 landmarks: the right penalty box (the most common broadcast view of an attack). */
export const DEFAULT_LANDMARKS = ["R-box-goal-far", "R-box-edge-far", "R-box-edge-near", "R-box-goal-near"];

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 32): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

/** Painted pitch lines as polylines in pitch metres (for the top-down view and the reprojection overlay). */
export function pitchLines(): Pt[][] {
  const { halfL: L, halfW: W } = PITCH;
  const lines: Pt[][] = [
    [{ x: -L, y: -W }, { x: L, y: -W }, { x: L, y: W }, { x: -L, y: W }, { x: -L, y: -W }],
    [{ x: 0, y: -W }, { x: 0, y: W }],
    arc(0, 0, CIRCLE_R, 0, 2 * Math.PI, 64),
  ];
  for (const s of [-1, 1]) {
    const g = s * L, b = s * (L - BOX.depth), a = s * (L - SIX.depth), p = s * (L - SPOT);
    lines.push([{ x: g, y: -BOX.halfW }, { x: b, y: -BOX.halfW }, { x: b, y: BOX.halfW }, { x: g, y: BOX.halfW }]);
    lines.push([{ x: g, y: -SIX.halfW }, { x: a, y: -SIX.halfW }, { x: a, y: SIX.halfW }, { x: g, y: SIX.halfW }]);
    // penalty arc: the part of the 9.15 m circle around the spot that lies outside the box
    const half = Math.acos((BOX.depth - SPOT) / CIRCLE_R); // half-angle of the arc, seen from the spot
    const base = s < 0 ? 0 : Math.PI;
    lines.push(arc(p, 0, CIRCLE_R, base - half, base + half, 24));
    lines.push([{ x: g, y: -GOAL_HALF }, { x: g + s * 1.5, y: -GOAL_HALF }, { x: g + s * 1.5, y: GOAL_HALF }, { x: g, y: GOAL_HALF }]);
  }
  return lines;
}

export function onPitch(p: Pt, margin = 3): boolean {
  return Math.abs(p.x) <= PITCH.halfL + margin && Math.abs(p.y) <= PITCH.halfW + margin;
}
