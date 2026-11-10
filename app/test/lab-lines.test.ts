import { describe, expect, it } from "vitest";
import { applyH, computeHomography, type Mat3, type Pt } from "../src/lab/homography.ts";
import { DEFAULT_LANDMARKS, landmark, LANDMARKS, pitchLines } from "../src/lab/landmarks.ts";
import {
  calibrationCheck, distanceTransform, fitLine, fitQuality, houghLines, intersect, lineIntersections, runsOf, scanLines, snapPoint,
  toSource, whiteLineMask,
} from "../src/lab/lines.ts";
import { sceneHomography, SCENE_H, SCENE_W } from "../src/lab/scene.ts";

const GRASS = [40, 120, 50], WHITE = [235, 235, 235];
type Img = { data: Uint8ClampedArray; width: number; height: number };

function image(w: number, h: number, bg = GRASS, seed = 7): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const n = ((s >>> 24) % 9) - 4; // +-4 grey levels of noise
    data[4 * i] = bg[0]! + n; data[4 * i + 1] = bg[1]! + n; data[4 * i + 2] = bg[2]! + n; data[4 * i + 3] = 255;
  }
  return { data, width: w, height: h };
}

function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Paints a segment given in canvas coordinates (pixel centres at index + 0.5 within halfWidth of it). */
function paint(img: Img, a: Pt, b: Pt, halfWidth = 1, colour = WHITE) {
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - 3)), x1 = Math.min(img.width - 1, Math.ceil(Math.max(a.x, b.x) + 3));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - 3)), y1 = Math.min(img.height - 1, Math.ceil(Math.max(a.y, b.y) + 3));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (segDist({ x: x + 0.5, y: y + 0.5 }, a, b) > halfWidth) continue;
    const i = 4 * (y * img.width + x);
    img.data[i] = colour[0]!; img.data[i + 1] = colour[1]!; img.data[i + 2] = colour[2]!;
  }
}

// three known painted lines: a horizontal one, a vertical one meeting it at (60, 40), a slanted one meeting it at (120, 40)
function threeLines(): Img {
  const img = image(200, 150);
  paint(img, { x: 20, y: 40 }, { x: 180, y: 40 });
  paint(img, { x: 60, y: 40 }, { x: 60, y: 140 });
  paint(img, { x: 120, y: 40 }, { x: 170, y: 140 });
  return img;
}

describe("white-line mask", () => {
  it("keeps thin white lines on green, drops grass, wide white blobs and lines off the grass", () => {
    const img = threeLines();
    for (let y = 100; y < 125; y++) for (let x = 140; x < 165; x++) { const i = 4 * (y * 200 + x); img.data[i] = 240; img.data[i + 1] = 240; img.data[i + 2] = 240; } // a shirt
    for (let y = 0; y < 20; y++) for (let x = 0; x < 200; x++) { const i = 4 * (y * 200 + x); img.data[i] = 60; img.data[i + 1] = 60; img.data[i + 2] = 70; } // stands
    paint(img, { x: 10, y: 10 }, { x: 190, y: 10 }); // a white rail in the stands
    const m = whiteLineMask(img);
    const at = (x: number, y: number) => m[y * 200 + x];
    expect(at(100, 40)).toBe(1); expect(at(60, 90)).toBe(1); expect(at(145, 90)).toBe(1);
    expect(at(100, 80)).toBe(0); // grass
    let blob = 0;
    for (let y = 100; y < 125; y++) for (let x = 140; x < 165; x++) blob += m[y * 200 + x]!;
    expect(blob).toBe(0);
    let rail = 0;
    for (let x = 0; x < 200; x++) rail += m[10 * 200 + x]!;
    expect(rail).toBe(0);
    // excluded boxes (players) are cleared
    const ex = whiteLineMask(img, undefined, [{ x: 50, y: 30, w: 20, h: 20 }]);
    expect(ex[40 * 200 + 60]).toBe(0); expect(ex[40 * 200 + 100]).toBe(1);
  });
});

describe("line fitting", () => {
  it("total least squares recovers a line through noisy points", () => {
    const pts = Array.from({ length: 50 }, (_, k) => ({ x: k, y: 0.5 * k + 3 + (k % 2 ? 0.1 : -0.1) }));
    const f = fitLine(pts)!;
    // y = 0.5 x + 3  <=>  -0.5 x + y = 3, normalised
    const n = Math.hypot(0.5, 1);
    expect(Math.abs(f.nx * n)).toBeCloseTo(0.5, 2); expect(Math.abs(f.ny * n)).toBeCloseTo(1, 2);
    expect(Math.abs(f.rho * n)).toBeCloseTo(3, 1);
  });
  it("splits positions into painted runs", () => {
    expect(runsOf([0, 1, 2, 3, 30, 31, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56], 5, 3)).toEqual([[0, 3], [45, 56]]);
  });
  it("the Hough transform finds the three known lines and nothing else", () => {
    const img = threeLines();
    const lines = houghLines(whiteLineMask(img), img.width, img.height);
    expect(lines).toHaveLength(3);
    const truth = [
      { nx: 0, ny: 1, rho: 40 }, { nx: 1, ny: 0, rho: 60 },
      (() => { const n = Math.hypot(100, 50); return { nx: 100 / n, ny: -50 / n, rho: (100 * 120 - 50 * 40) / n }; })(),
    ];
    for (const t of truth) {
      const hit = lines.find((l) => {
        const s = Math.sign(l.nx * t.nx + l.ny * t.ny) || 1;
        return Math.abs(Math.abs(l.nx * t.nx + l.ny * t.ny) - 1) < 1e-3 && Math.abs(s * l.rho - t.rho) < 0.8;
      });
      expect(hit, JSON.stringify(t)).toBeTruthy();
    }
  });
});

describe("intersections", () => {
  it("intersects two lines, rejects near-parallel ones", () => {
    const p = intersect({ nx: 0, ny: 1, rho: 40 }, { nx: 1, ny: 0, rho: 60 })!;
    expect(p.x).toBeCloseTo(60, 9); expect(p.y).toBeCloseTo(40, 9);
    const a = Math.PI / 4;
    const q = intersect({ nx: Math.cos(a), ny: Math.sin(a), rho: 10 * Math.SQRT2 }, { nx: 0, ny: 1, rho: 0 })!; // x + y = 20 and y = 0
    expect(q.x).toBeCloseTo(20, 9); expect(q.y).toBeCloseTo(0, 9);
    expect(intersect({ nx: 0, ny: 1, rho: 0 }, { nx: Math.sin(0.1), ny: Math.cos(0.1), rho: 5 })).toBeNull(); // 6 degrees apart
  });
  it("keeps only the corners that lie on the painted runs of both lines", () => {
    const img = threeLines();
    const pts = lineIntersections(houghLines(whiteLineMask(img), 200, 150), 200, 150);
    expect(pts).toHaveLength(2); // the vertical and slanted lines would meet at y = -80, off their paint and off the image
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    expect(Math.hypot(sorted[0]!.x - 60, sorted[0]!.y - 40)).toBeLessThan(1);
    expect(Math.hypot(sorted[1]!.x - 120, sorted[1]!.y - 40)).toBeLessThan(1);
  });
});

describe("snapping rule", () => {
  const cands = [{ x: 100, y: 100 }, { x: 130, y: 100 }];
  it("snaps to the nearest candidate within the radius", () => {
    expect(snapPoint({ x: 112, y: 104 }, cands, 20)).toEqual({ p: { x: 100, y: 100 }, d: Math.hypot(12, 4) });
    expect(snapPoint({ x: 118, y: 100 }, cands, 20)!.p).toEqual({ x: 130, y: 100 });
  });
  it("keeps the tap when nothing is close enough", () => {
    expect(snapPoint({ x: 100, y: 125 }, cands, 20)).toBeNull();
    expect(snapPoint({ x: 0, y: 0 }, [], 20)).toBeNull();
    expect(snapPoint({ x: 100, y: 120 }, cands, 20)!.d).toBe(20); // the radius is inclusive
  });
});

describe("distance transform", () => {
  it("approximates the Euclidean distance to the nearest mask pixel", () => {
    const w = 41, h = 41, m = new Uint8Array(w * h);
    m[20 * w + 20] = 1;
    const d = distanceTransform(m, w, h);
    expect(d[20 * w + 20]).toBe(0);
    expect(d[20 * w + 30]).toBeCloseTo(10, 6);
    expect(Math.abs(d[30 * w + 30]! - Math.hypot(10, 10)) / Math.hypot(10, 10)).toBeLessThan(0.08);
  });
});

describe("a synthetic broadcast picture: corners, snapping and fit quality", () => {
  // the Lab's synthetic scene homography, at the 640 px working size of the line search
  const k = 0.5, W = SCENE_W * k, H = SCENE_H * k;
  const P: Mat3 = computeHomography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], [{ x: 0, y: 0 }, { x: k, y: 0 }, { x: k, y: k }, { x: 0, y: k }])!;
  const Hs = sceneHomography(); // pitch -> 1280 x 720 scene pixels
  const toWork = (m: Pt) => { const q = applyH(Hs, m)!; return applyH(P, q)!; };
  const img = image(W, H);
  for (const line of pitchLines()) for (let i = 0; i < line.length - 1; i++) {
    const a = toWork(line[i]!), b = toWork(line[i + 1]!);
    if (Math.max(Math.abs(a.x), Math.abs(b.x)) > 4 * W || Math.max(Math.abs(a.y), Math.abs(b.y)) > 4 * H) continue;
    paint(img, a, b, 0.9);
  }
  const scan = scanLines(img, k);
  const cornersSrc = scan.corners.map((c) => toSource(k, c));

  it("finds a corner within 2 px of each visible penalty-box and goal-area corner", () => {
    for (const id of [...DEFAULT_LANDMARKS, "R-six-edge-far", "R-six-edge-near", "R-six-goal-far", "R-six-goal-near"]) {
      const truth = applyH(Hs, landmark(id)!)!;
      const s = snapPoint(truth, cornersSrc, 20);
      expect(s, id).toBeTruthy();
      expect(s!.d, id).toBeLessThan(2);
    }
  });

  it("snaps taps placed 6-12 px off onto the true corners", () => {
    const nudge = [{ x: 9, y: -6 }, { x: -8, y: 7 }, { x: 6, y: 8 }, { x: -7, y: -9 }];
    DEFAULT_LANDMARKS.forEach((id, i) => {
      const truth = applyH(Hs, landmark(id)!)!;
      const s = snapPoint({ x: truth.x + nudge[i]!.x, y: truth.y + nudge[i]!.y }, cornersSrc, 20)!;
      expect(Math.hypot(s.p.x - truth.x, s.p.y - truth.y)).toBeLessThan(2);
    });
  });

  it("rates the true calibration good and a shifted one worse", () => {
    const good = fitQuality(scan, Hs, pitchLines())!;
    expect(good.rating).toBe("good");
    expect(good.mean).toBeLessThan(2);
    const shifted = Hs.map((v, i) => (i === 2 ? v + 6 * Hs[8]! : i === 5 ? v + 5 * Hs[8]! : v)) as Mat3; // 6 px right, 5 px down
    const bad = fitQuality(scan, shifted, pitchLines())!;
    expect(bad.mean).toBeGreaterThan(good.mean + 3);
    expect(bad.rating).not.toBe("good");
  });

  it("reports the 4-point reprojection error against the other line corners", () => {
    const pitch4 = DEFAULT_LANDMARKS.map((id) => landmark(id)!);
    const extra = LANDMARKS.filter((l) => !DEFAULT_LANDMARKS.includes(l.id) && !/spot|^centre$/.test(l.id));
    const exact = calibrationCheck(pitch4, pitch4.map((m) => applyH(Hs, m)!), extra, cornersSrc)!;
    expect(exact.n).toBeGreaterThan(6);
    expect(exact.err).toBeLessThan(1.5);
    const off = calibrationCheck(pitch4, pitch4.map((m, i) => { const q = applyH(Hs, m)!; return i === 1 ? { x: q.x + 8, y: q.y - 6 } : q; }), extra, cornersSrc)!;
    expect(off.err).toBeGreaterThan(exact.err + 1);
    expect(calibrationCheck(pitch4, pitch4.map((m) => applyH(Hs, m)!), extra, [])).toEqual({ err: 0, n: 4 });
  });
});
