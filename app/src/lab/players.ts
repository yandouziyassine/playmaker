// From detector output to players on the pitch, and a cheap passing-lane proxy. Pure functions.
import { applyH, wOf, type Mat3, type Pt } from "./homography.ts";
import { onPitch } from "./landmarks.ts";
import type { Box } from "./teams.ts";

/** Shape of a MediaPipe ObjectDetector detection (only the fields we use). */
export type RawDetection = {
  boundingBox?: { originX: number; originY: number; width: number; height: number };
  categories: { categoryName?: string; score: number }[];
};
export type Person = { box: Box; score: number };

export const MIN_SCORE = 0.3;

/** Keeps "person" detections with score >= minScore. */
export function keepPersons(dets: RawDetection[], minScore = MIN_SCORE): Person[] {
  const out: Person[] = [];
  for (const d of dets) {
    const c = d.categories.find((c) => c.categoryName === "person");
    if (!c || c.score < minScore || !d.boundingBox) continue;
    const b = d.boundingBox;
    out.push({ box: { x: b.originX, y: b.originY, w: b.width, h: b.height }, score: c.score });
  }
  return out;
}

/**
 * Detector boxes of a standing player reach a little below the ground contact (boots, shadow, box padding): on the
 * synthetic benchmark (scripts/cv-bench, EfficientDet-Lite0, tiled) the median overshoot is ~1.2 % of the box height. One pixel is up to a metre on the far side of a
 * wide shot, so it is worth correcting. A wide box (w/h > 1.3: a fallen or sliding player) lies on the ground: no shift.
 */
export const FEET = { shrink: 0.012, lyingAspect: 1.3 } as const;

/** Ground contact point: bottom-centre of the box, raised by FEET.shrink of the height for an upright box. */
export function feet(b: Box, o: typeof FEET = FEET): Pt {
  const lying = b.h > 0 && b.w / b.h > o.lyingAspect;
  return { x: b.x + b.w / 2, y: b.y + b.h - (lying ? 0 : o.shrink * b.h) };
}

/** Image point to pitch metres; null if it falls behind the horizon or far off the pitch. */
export function toPitch(Himg2pitch: Mat3, p: Pt, margin = 6): Pt | null {
  if (wOf(Himg2pitch, p) <= 0) return null;
  const q = applyH(Himg2pitch, p);
  return q && onPitch(q, margin) ? q : null;
}

/** Shortest distance from p to segment ab. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export type Lane = { to: number; length: number; gap: number; forward: number; rating: "open" | "tight" | "blocked" };

/**
 * Passing lanes from the carrier to each teammate, rated by the distance from the nearest opponent to the lane
 * (a cheap proxy: it ignores defender speed, pass speed, height and body orientation).
 * `dir` is +1 when the attack goes to the right goal (+x), -1 otherwise. Thresholds: open >= 4 m, tight >= 2 m.
 */
export function passingLanes(carrier: Pt, mates: Pt[], opponents: Pt[], dir: 1 | -1): Lane[] {
  return mates.map((m, to) => {
    const gap = opponents.length ? Math.min(...opponents.map((o) => distToSegment(o, carrier, m))) : Infinity;
    return {
      to, gap, length: Math.hypot(m.x - carrier.x, m.y - carrier.y), forward: (m.x - carrier.x) * dir,
      rating: gap >= 4 ? "open" : gap >= 2 ? "tight" : "blocked",
    };
  });
}
