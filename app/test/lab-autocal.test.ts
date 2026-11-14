import { describe, expect, it } from "vitest";
import { applyH, computeHomography, mul3, type Mat3, type Pt } from "../src/lab/homography.ts";
import { BOX, landmark, PITCH, pitchLines } from "../src/lab/landmarks.ts";
import { scanLines } from "../src/lab/lines.ts";
import { autoCalibrate, lineSamples, pickFour, refineCalibration, residualOf, vanishingPoints } from "../src/lab/autocal.ts";
import { sceneHomography, SCENE_H, SCENE_W } from "../src/lab/scene.ts";

// ---- synthetic pictures: the model lines drawn through a known homography on grass (same helpers as lab-lines.test.ts) ----
const GRASS = [40, 120, 50], WHITE = [235, 235, 235];
type Img = { data: Uint8ClampedArray; width: number; height: number };

function image(w: number, h: number, bg = GRASS, seed = 7): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const n = ((s >>> 24) % 9) - 4;
    data[4 * i] = bg[0]! + n; data[4 * i + 1] = bg[1]! + n; data[4 * i + 2] = bg[2]! + n; data[4 * i + 3] = 255;
  }
  return { data, width: w, height: h };
}
function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function paint(img: Img, a: Pt, b: Pt, halfWidth = 0.9, colour = WHITE) {
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - 3)), x1 = Math.min(img.width - 1, Math.ceil(Math.max(a.x, b.x) + 3));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - 3)), y1 = Math.min(img.height - 1, Math.ceil(Math.max(a.y, b.y) + 3));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (segDist({ x: x + 0.5, y: y + 0.5 }, a, b) > halfWidth) continue;
    const i = 4 * (y * img.width + x);
    img.data[i] = colour[0]!; img.data[i + 1] = colour[1]!; img.data[i + 2] = colour[2]!;
  }
}
/** Draws the pitch model through H (pitch -> picture px) into a w x h picture, skipping the polylines `skip` accepts. */
function draw(H: Mat3, w: number, h: number, skip: (line: Pt[]) => boolean = () => false): Img {
  const img = image(w, h);
  for (const line of pitchLines()) {
    if (skip(line)) continue;
    for (let i = 0; i < line.length - 1; i++) {
      const a = applyH(H, line[i]!), b = applyH(H, line[i + 1]!);
      if (!a || !b || Math.max(Math.abs(a.x), Math.abs(b.x)) > 4 * w || Math.max(Math.abs(a.y), Math.abs(b.y)) > 4 * h) continue;
      paint(img, a, b);
    }
  }
  return img;
}
const scale = (k: number): Mat3 => [k, 0, 0, 0, k, 0, 0, 0, 1];
/** Max error (px) of the recovered H on reference landmarks. */
const maxErr = (H: Mat3, truth: Mat3, ids: string[]) => Math.max(...ids.map((id) => {
  const m = landmark(id)!, a = applyH(H, m)!, b = applyH(truth, m)!;
  return Math.hypot(a.x - b.x, a.y - b.y);
}));

// the Lab's synthetic scene at the 640 px working size: the right half of the pitch (one penalty box, both touchlines)
const Hscene = mul3(scale(0.5), sceneHomography());
const W = SCENE_W / 2, Hh = SCENE_H / 2;
const RIGHT_BOX = ["R-box-goal-far", "R-box-edge-far", "R-box-edge-near", "R-box-goal-near"];

describe("line families by vanishing point", () => {
  it("splits the scene's lines into goal-line-parallel and touchline-parallel families", () => {
    const scan = scanLines(draw(Hscene, W, Hh), 1);
    const fams = vanishingPoints(scan.lines)!;
    expect(fams).toBeTruthy();
    const [a, b] = fams;
    expect(a.idx.length + b.idx.length).toBeGreaterThanOrEqual(6);
    // the touchline family is the more horizontal one
    const horiz = (idx: number[]) => idx.reduce((s, i) => s + Math.abs(scan.lines[i]!.ny), 0) / idx.length;
    const touch = horiz(a.idx) > horiz(b.idx) ? a : b;
    expect(horiz(touch.idx)).toBeGreaterThan(0.9);
    expect(lineSamples(scan.lines[0]!, 10).length).toBeGreaterThan(0);
  });
});

describe("automatic calibration on synthetic views", () => {
  it("one penalty box (the Lab's scene): the box corners land within 2 px, in good time", () => {
    const scan = scanLines(draw(Hscene, W, Hh), 1);
    const r = autoCalibrate(scan, {}, () => 0); // fixed clock: never truncated by machine load
    expect(r.best, JSON.stringify({ reason: r.reason, tried: r.tried })).toBeTruthy();
    expect(maxErr(r.best!.H, Hscene, RIGHT_BOX)).toBeLessThan(2);
    expect(r.best!.rating).toBe("good");
    expect(r.best!.side).toBe("R");
    expect(r.best!.inliers).toBeGreaterThanOrEqual(6);
    expect(r.best!.matched.length).toBeGreaterThanOrEqual(4);
    expect(r.ms).toBeLessThan(1500); // a cold vitest worker; ~100 ms on a laptop in the browser
    const four = pickFour(r.best!, W, Hh)!;
    expect(four.ids).toHaveLength(4);
    expect(new Set(four.ids).size).toBe(4);
    four.ids.forEach((id, i) => {
      const t = applyH(Hscene, landmark(id)!)!;
      expect(Math.hypot(four.pts[i]!.x - t.x, four.pts[i]!.y - t.y), id).toBeLessThan(2);
    });
  });

  it("the whole pitch from a high wide camera", () => {
    const Hfull = computeHomography(
      [{ x: -PITCH.halfL, y: PITCH.halfW }, { x: PITCH.halfL, y: PITCH.halfW }, { x: PITCH.halfL, y: -PITCH.halfW }, { x: -PITCH.halfL, y: -PITCH.halfW }],
      [{ x: 150, y: 70 }, { x: 500, y: 75 }, { x: 625, y: 330 }, { x: 15, y: 320 }],
    )!;
    const scan = scanLines(draw(Hfull, 640, 360), 1);
    const r = autoCalibrate(scan, {}, () => 0); // fixed clock: never truncated by machine load
    expect(r.best).toBeTruthy();
    expect(maxErr(r.best!.H, Hfull, ["L-corner-far", "R-corner-far", "R-corner-near", "L-corner-near"])).toBeLessThan(2);
    expect(r.best!.side).toBe("both");
    expect(r.best!.rating).toBe("good");
  });

  it("two missing lines (far touchline and the box front edge): still within 2 px", () => {
    // skip the right penalty box polyline, then paint its two sides back (only its front edge stays missing)
    const b = PITCH.halfL - BOX.depth, g = PITCH.halfL;
    const img = draw(Hscene, W, Hh, (line) => line.length === 4 && Math.abs(line[1]!.x - b) < 1e-9);
    for (const y of [-BOX.halfW, BOX.halfW]) paint(img, applyH(Hscene, { x: g, y })!, applyH(Hscene, { x: b, y })!);
    // erase the far touchline with grass
    const grass = image(W, Hh, GRASS, 11);
    const a = applyH(Hscene, { x: -60, y: PITCH.halfW })!, c = applyH(Hscene, { x: 60, y: PITCH.halfW })!;
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      if (segDist({ x: x + 0.5, y: y + 0.5 }, a, c) >= 2.5) continue;
      for (let k = 0; k < 4; k++) img.data[4 * (y * W + x) + k] = grass.data[4 * (y * W + x) + k]!;
    }
    const scan = scanLines(img, 1);
    const r = autoCalibrate(scan, {}, () => 0); // fixed clock: never truncated by machine load
    expect(r.best).toBeTruthy();
    expect(maxErr(r.best!.H, Hscene, RIGHT_BOX)).toBeLessThan(2);
  });

  it("the left box (goal line on the left of the picture) is told from the right one", () => {
    // mirror the pitch (left box <-> right box) and the picture: the camera stays on the near side
    const Hleft = mul3([-1, 0, W, 0, 1, 0, 0, 0, 1], mul3(Hscene, [-1, 0, 0, 0, 1, 0, 0, 0, 1]));
    const scan = scanLines(draw(Hleft, W, Hh), 1);
    const r = autoCalibrate(scan, {}, () => 0); // fixed clock: never truncated by machine load
    expect(r.best).toBeTruthy();
    expect(r.best!.side).toBe("L");
    expect(maxErr(r.best!.H, Hleft, ["L-box-goal-far", "L-box-edge-far", "L-box-edge-near", "L-box-goal-near"])).toBeLessThan(2);
  });

  it("an ambiguous view (one rectangle, nothing else) is ranked with alternatives and not rated good", () => {
    const img = image(W, Hh);
    const box = [{ x: 52.5, y: -BOX.halfW }, { x: 36, y: -BOX.halfW }, { x: 36, y: BOX.halfW }, { x: 52.5, y: BOX.halfW }, { x: 52.5, y: -BOX.halfW }];
    for (let i = 0; i < 4; i++) paint(img, applyH(Hscene, box[i]!)!, applyH(Hscene, box[i + 1]!)!);
    const scan = scanLines(img, 1);
    const r = autoCalibrate(scan, {}, () => 0); // fixed clock: never truncated by machine load
    expect(r.best, JSON.stringify({ reason: r.reason, tried: r.tried, lines: scan.lines.length })).toBeTruthy();
    expect(r.alternatives.length).toBeGreaterThan(0);
    expect(r.best!.rating).not.toBe("good");
    expect(r.best!.score).toBeLessThanOrEqual(r.alternatives[0]!.score);
  });

  it("gives up cleanly without lines and respects the time cap", () => {
    const empty = scanLines(image(200, 120), 1);
    expect(autoCalibrate(empty, {}, () => 0).reason).toBe("lines");
    const scan = scanLines(draw(Hscene, W, Hh), 1);
    let t = 0;
    const r = autoCalibrate(scan, { budgetMs: 1 }, () => (t += 0.5));
    expect(r.truncated).toBe(true);
    expect(r.ms).toBeGreaterThan(0);
  });
});

describe("live refinement seeded by the current calibration", () => {
  const scan = scanLines(draw(Hscene, W, Hh), 1);
  it("pulls a calibration a few px off back onto the lines", () => {
    const off = Hscene.map((v, i) => (i === 2 ? v + 3 * Hscene[8]! : i === 5 ? v - 2 * Hscene[8]! : v)) as Mat3; // 3 px right, 2 px up
    expect(maxErr(off, Hscene, RIGHT_BOX)).toBeGreaterThan(2);
    const r = refineCalibration(scan, off)!;
    expect(r).toBeTruthy();
    expect(maxErr(r.H, Hscene, RIGHT_BOX)).toBeLessThan(1);
    expect(residualOf(scan, r.H)!).toBeLessThan(residualOf(scan, off)!);
  });
  it("returns null when the seed is nowhere near the lines", () => {
    const far = Hscene.map((v, i) => (i === 2 ? v + 80 * Hscene[8]! : v)) as Mat3;
    expect(refineCalibration(scan, far)).toBeNull();
  });
});
