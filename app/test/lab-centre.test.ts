import { describe, expect, it } from "vitest";
import { applyH, computeHomography, invert3, mul3, type Mat3, type Pt } from "../src/lab/homography.ts";
import { pitchLines } from "../src/lab/landmarks.ts";
import { scanLines } from "../src/lab/lines.ts";
import { centreCircleCalibrate, centreCorrespondences, chamferRefine, conicDist, ellipseOf, fitConic, lineConic, propagateCalibration, ransacEllipse } from "../src/lab/autocal.ts";

// a broadcast-like centre view, 640 x 360: pitch metres -> picture px
const H: Mat3 = computeHomography(
  [{ x: -30, y: 34 }, { x: 30, y: 34 }, { x: 30, y: -34 }, { x: -30, y: -34 }],
  [{ x: 60, y: 95 }, { x: 580, y: 95 }, { x: 700, y: 330 }, { x: -60, y: 330 }],
)!;
const proj = (p: Pt) => applyH(H, p)!;

function ellipsePts(n: number, noise = 0): Pt[] {
  let s = 9;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  return Array.from({ length: n }, (_, i) => { const a = (2 * Math.PI * i) / n, p = proj({ x: 9.15 * Math.cos(a), y: 9.15 * Math.sin(a) }); return { x: p.x + noise * rnd(), y: p.y + noise * rnd() }; });
}

describe("ellipse fit", () => {
  it("fits the image of the centre circle from synthetic points", () => {
    const pts = ellipsePts(60, 0.6);
    const q = fitConic(pts)!;
    expect(ellipseOf(q)).not.toBeNull();
    for (const p of ellipsePts(16)) expect(conicDist(q, p)).toBeLessThan(0.6);
  });
  it("RANSAC ignores straight-line outliers", () => {
    const line = Array.from({ length: 80 }, (_, i) => ({ x: 100 + 4 * i, y: 300 }));
    const r = ransacEllipse([...ellipsePts(60, 0.4), ...line], { minInliers: 30 })!;
    expect(r).not.toBeNull();
    expect(r.inliers.length).toBeGreaterThanOrEqual(55);
    expect(r.inliers.length).toBeLessThan(70);
  });
  it("intersects a line with the conic", () => {
    const q = fitConic(ellipsePts(40))!;
    const a = proj({ x: 0, y: -30 }), b = proj({ x: 0, y: 30 });
    const l: [number, number, number] = [a.y - b.y, b.x - a.x, a.x * b.y - a.y * b.x];
    const xs = lineConic(q, l).sort((u, v) => u.y - v.y);
    expect(xs).toHaveLength(2);
    const top = proj({ x: 0, y: 9.15 });
    expect(Math.hypot(xs[0]!.x - top.x, xs[0]!.y - top.y)).toBeLessThan(0.5);
  });
});

describe("centre-view correspondences", () => {
  it("recovers the homography from the ellipse, the halfway line and one touchline", () => {
    const q = fitConic(ellipsePts(64))!;
    const a = proj({ x: 0, y: -34 }), b = proj({ x: 0, y: 34 });
    const l: [number, number, number] = [a.y - b.y, b.x - a.x, a.x * b.y - a.y * b.x];
    const corr = centreCorrespondences(q, l, { p: b, far: true })!;
    expect(corr).not.toBeNull();
    for (const c of corr) { const t = proj(c.model); expect(Math.hypot(t.x - c.p.x, t.y - c.p.y)).toBeLessThan(0.5); }
  });
});

// synthetic picture of the model lines through H (grass + white paint)
function draw(Hd: Mat3, w = 640, h = 360) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[4 * i] = 40; data[4 * i + 1] = 120; data[4 * i + 2] = 50; data[4 * i + 3] = 255; }
  for (const line of pitchLines()) for (let k = 0; k < line.length - 1; k++) {
    const a = applyH(Hd, line[k]!), b = applyH(Hd, line[k + 1]!);
    if (!a || !b) continue;
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2);
    for (let s = 0; s <= n; s++) {
      const x = Math.round(a.x + ((b.x - a.x) * s) / n), y = Math.round(a.y + ((b.y - a.y) * s) / n);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = 4 * (y * w + x); data[i] = data[i + 1] = data[i + 2] = 235;
    }
  }
  return { data, width: w, height: h };
}
const pitchErr = (A: Mat3, B: Mat3) => {
  const a = invert3(A)!, b = invert3(B)!;
  let m = 0;
  for (const p of [{ x: 160, y: 200 }, { x: 320, y: 250 }, { x: 480, y: 200 }]) { const u = applyH(a, p)!, v = applyH(b, p)!; m = Math.max(m, Math.hypot(u.x - v.x, u.y - v.y)); }
  return m;
};

describe("centre-circle calibration and motion propagation", () => {
  it("calibrates a midfield view with no box in sight", () => {
    const scan = scanLines(draw(H), 1);
    const cal = centreCircleCalibrate(scan);
    expect(cal).not.toBeNull();
    expect(pitchErr(cal!.H, H)).toBeLessThan(1);
  });
  it("propagates the previous homography through a camera pan", () => {
    const pan: Mat3 = [1, 0, -18, 0, 1, 3, 0, 0, 1];
    const H2 = mul3(pan, H);
    const scan = scanLines(draw(H2), 1);
    const p = propagateCalibration(scan, H)!;
    expect(p).not.toBeNull();
    expect(Math.abs(p.motion.x + 18)).toBeLessThanOrEqual(4);
    expect(pitchErr(p.H, H2)).toBeLessThan(0.6);
  });
  it("chamfer refinement does not move an exact homography", () => {
    const scan = scanLines(draw(H), 1);
    const r = chamferRefine(scan, H, 0);
    expect(r.mean).toBeLessThan(1);
    expect(pitchErr(r.Hw, H)).toBeLessThan(0.3);
  });
});
