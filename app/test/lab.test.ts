import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyH, computeHomography, orientH, hasCollinearTriple, invert3, reprojectionError, solveLinear, type Mat3, type Pt } from "../src/lab/homography.ts";
import { DEFAULT_LANDMARKS, LANDMARKS, PITCH, landmark, pitchLines } from "../src/lab/landmarks.ts";
import { distToSegment, feet, FEET, keepPersons, passingLanes, toPitch } from "../src/lab/players.ts";
import { isGrass, kmeans, meanColour, rgbToLab, splitTeams, torsoBox, type RGB } from "../src/lab/teams.ts";
import { MEDIAPIPE_VERSION, iou, nms, tiles } from "../src/lab/detector.ts";

describe("solveLinear", () => {
  it("solves a system that needs pivoting", () => {
    const x = solveLinear([[0, 2, 1], [1, 1, 1], [2, 1, 0]], [7, 6, 4])!;
    expect(x[0]).toBeCloseTo(1, 12); expect(x[1]).toBeCloseTo(2, 12); expect(x[2]).toBeCloseTo(3, 12);
  });
  it("returns null for a singular matrix", () => {
    expect(solveLinear([[1, 2], [2, 4]], [1, 2])).toBeNull();
  });
});

describe("homography (DLT)", () => {
  // a broadcast-like perspective: pitch metres -> image pixels
  const Htrue: Mat3 = [9.5, 2.1, 640, -0.4, -3.2, 420, 0.0006, 0.0041, 1];
  const pitchPts: Pt[] = DEFAULT_LANDMARKS.map((id) => landmark(id)!);
  const imgPts = pitchPts.map((p) => applyH(Htrue, p)!);

  it("recovers a known transform from 4 points to 1e-6", () => {
    const H = computeHomography(pitchPts, imgPts)!;
    H.forEach((v, i) => expect(Math.abs(v - Htrue[i]!) / Math.max(1, Math.abs(Htrue[i]!))).toBeLessThan(1e-6));
    expect(reprojectionError(H, pitchPts, imgPts)).toBeLessThan(1e-6);
  });

  it("maps other points correctly and inverts (image -> pitch)", () => {
    const H = computeHomography(imgPts, pitchPts)!;
    for (const q of [{ x: 30, y: -12 }, { x: 52.5, y: 34 }, { x: 0, y: 0 }]) {
      const p = applyH(H, applyH(Htrue, q)!)!;
      expect(p.x).toBeCloseTo(q.x, 6); expect(p.y).toBeCloseTo(q.y, 6);
    }
    const back = applyH(invert3(H)!, { x: 30, y: -12 })!;
    const expected = applyH(Htrue, { x: 30, y: -12 })!;
    expect(back.x).toBeCloseTo(expected.x, 5);
  });

  it("uses least squares with more than 4 points (noise-free stays exact)", () => {
    const src = [...pitchPts, { x: 41.5, y: 0 }, { x: 47, y: 9.16 }];
    const H = computeHomography(src, src.map((p) => applyH(Htrue, p)!))!;
    expect(reprojectionError(H, src, src.map((p) => applyH(Htrue, p)!))).toBeLessThan(1e-6);
  });

  it("rejects degenerate input", () => {
    const line = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    expect(computeHomography(line, imgPts)).toBeNull();
    expect(hasCollinearTriple(line)).toBe(true);
    expect(hasCollinearTriple(pitchPts)).toBe(false);
    expect(computeHomography(pitchPts.slice(0, 3), imgPts.slice(0, 3))).toBeNull();
  });
});

describe("landmarks", () => {
  it("has unique ids, all on the 105 x 68 pitch", () => {
    expect(new Set(LANDMARKS.map((l) => l.id)).size).toBe(LANDMARKS.length);
    for (const l of LANDMARKS) { expect(Math.abs(l.x)).toBeLessThanOrEqual(52.5); expect(Math.abs(l.y)).toBeLessThanOrEqual(34); }
    expect(landmark("R-box-edge-far")).toMatchObject({ x: 36, y: 20.16 });
    expect(landmark("L-six-edge-near")).toMatchObject({ x: -47, y: -9.16 });
    expect(PITCH.length).toBe(105);
  });
  it("draws the penalty arcs outside the box", () => {
    const arcs = pitchLines().filter((l) => l.length === 25);
    expect(arcs).toHaveLength(2);
    for (const a of arcs) for (const p of a) expect(Math.abs(p.x)).toBeLessThanOrEqual(36 + 1e-9);
  });
});

describe("colours and teams", () => {
  it("converts sRGB to CIELAB", () => {
    const w = rgbToLab([255, 255, 255]);
    expect(w[0]).toBeCloseTo(100, 1); expect(Math.abs(w[1])).toBeLessThan(0.5);
    const r = rgbToLab([255, 0, 0]);
    expect(r[0]).toBeCloseTo(53.2, 0); expect(r[1]).toBeCloseTo(80.1, 0);
  });

  it("k-means separates two colour blobs", () => {
    const pts = [...Array.from({ length: 6 }, (_, i) => [10 + i * 0.3, 0, 0]), ...Array.from({ length: 5 }, (_, i) => [80, 20 + i * 0.2, 5])];
    const { labels } = kmeans(pts, 2);
    expect(new Set(labels.slice(0, 6)).size).toBe(1);
    expect(new Set(labels.slice(6)).size).toBe(1);
    expect(labels[0]).not.toBe(labels[6]);
  });

  it("splits red vs white shirts and flags the yellow referee as other", () => {
    const red: RGB[] = [[200, 20, 30], [190, 30, 35], [210, 25, 25], [185, 15, 40], [205, 35, 30]];
    const white: RGB[] = [[240, 240, 240], [230, 232, 235], [245, 245, 240], [225, 228, 230], [238, 236, 241]];
    const ref: RGB = [240, 220, 20];
    const s = splitTeams([...red, ...white, ref]);
    expect(new Set(s.labels.slice(0, 5)).size).toBe(1);
    expect(new Set(s.labels.slice(5, 10)).size).toBe(1);
    expect(s.labels[0]).not.toBe(s.labels[5]);
    expect(s.labels[10]).toBe("other");
    expect(s.separation).toBeGreaterThan(40);
  });

  it("averages torso pixels and ignores grass", () => {
    const w = 10, h = 10, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      const c = x < 5 ? [40, 140, 50] : [200, 20, 30];
      data.set([...c, 255], i * 4);
    }
    expect(isGrass(40, 140, 50)).toBe(true);
    expect(isGrass(200, 20, 30)).toBe(false);
    expect(meanColour({ data, width: w, height: h }, { x: 0, y: 0, w: 10, h: 10 })).toEqual([200, 20, 30]);
    expect(torsoBox({ x: 0, y: 0, w: 20, h: 100 })).toEqual({ x: 5, y: 20, w: 10, h: 30 });
  });
});

describe("players", () => {
  it("keeps persons above the score threshold", () => {
    const dets = [
      { boundingBox: { originX: 10, originY: 20, width: 30, height: 60 }, categories: [{ categoryName: "person", score: 0.8 }] },
      { boundingBox: { originX: 0, originY: 0, width: 5, height: 5 }, categories: [{ categoryName: "person", score: 0.2 }] },
      { boundingBox: { originX: 0, originY: 0, width: 5, height: 5 }, categories: [{ categoryName: "sports ball", score: 0.9 }] },
    ];
    const ps = keepPersons(dets);
    expect(ps).toHaveLength(1);
    expect(feet(ps[0]!.box)).toEqual({ x: 25, y: 80 - 60 * FEET.shrink }); // bottom-centre, raised by the measured box overshoot
  });

  it("maps feet to pitch metres and drops points off the pitch", () => {
    const Htrue: Mat3 = [9.5, 2.1, 640, -0.4, -3.2, 420, 0.0006, 0.0041, 1];
    const Hinv = orientH(invert3(Htrue)!, applyH(Htrue, { x: 20, y: 5 })!);
    const p = toPitch(Hinv, applyH(Htrue, { x: 20, y: 5 })!)!;
    expect(p.x).toBeCloseTo(20, 6);
    expect(toPitch(Hinv, applyH(Htrue, { x: 90, y: 5 })!)).toBeNull();
  });

  it("rates passing lanes by nearest-opponent distance", () => {
    expect(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distToSegment({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    const lanes = passingLanes({ x: 0, y: 0 }, [{ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 }], [{ x: 5, y: 1 }, { x: 3, y: 7 }], 1);
    expect(lanes.map((l) => l.rating)).toEqual(["blocked", "tight", "open"]);
    expect(lanes[0]!.forward).toBe(10);
    expect(lanes[2]!.forward).toBe(-10);
  });
});

describe("detector config", () => {
  it("pins the wasm CDN to the installed @mediapipe/tasks-vision version", () => {
    const pkg = JSON.parse(readFileSync("node_modules/@mediapipe/tasks-vision/package.json", "utf8")) as { version: string };
    expect(MEDIAPIPE_VERSION).toBe(pkg.version);
  });
});

describe("tiled detection helpers", () => {
  it("tiles cover the image with overlap", () => {
    const ts = tiles(1200, 600, 3, 2);
    expect(ts).toHaveLength(6);
    expect(ts[0]).toMatchObject({ x: 0, y: 0 });
    const last = ts[5]!;
    expect(last.x + last.w).toBeGreaterThanOrEqual(1199);
    expect(last.y + last.h).toBeGreaterThanOrEqual(599);
    expect(ts[1]!.x).toBeLessThan(ts[0]!.w);
  });
  it("NMS merges duplicates from overlapping tiles", () => {
    const a = { box: { x: 0, y: 0, w: 10, h: 20 }, score: 0.9 };
    const b = { box: { x: 1, y: 0, w: 10, h: 20 }, score: 0.6 };
    const cut = { box: { x: 0, y: 0, w: 10, h: 9 }, score: 0.5 }; // half a player at a tile edge
    const c = { box: { x: 50, y: 0, w: 10, h: 20 }, score: 0.4 };
    expect(iou(a.box, a.box)).toBe(1);
    expect(nms([b, a, cut, c])).toEqual([a, c]);
  });
});

describe("synthetic scene", () => {
  it("shows the 4 default landmarks inside the picture", async () => {
    const { sceneHomography, SCENE_W, SCENE_H } = await import("../src/lab/scene.ts");
    const H = sceneHomography();
    for (const id of DEFAULT_LANDMARKS) {
      const p = applyH(H, landmark(id)!)!;
      expect(p.x).toBeGreaterThan(20); expect(p.x).toBeLessThan(SCENE_W - 20);
      expect(p.y).toBeGreaterThan(20); expect(p.y).toBeLessThan(SCENE_H - 20);
    }
  });
});
