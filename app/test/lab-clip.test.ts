import { describe, expect, it } from "vitest";
import {
  CLIP, classifyFrame, diagnostics, frameAt, frameTimes, fromOwnGoal, guessSides, heatBins, histDistance, outfield, possessionOf,
  possessionShare, processingSize, signature, teamNumbers, teamShape, type ClipFrame, type ClipPlayer,
} from "../src/lab/clip.ts";

const P = (x: number, y: number) => ({ x, y });
const img = (w: number, h: number, rgb: [number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { data, width: w, height: h };
};
const player = (id: number, team: 0 | 1 | "other", x: number, y: number, seen = true): ClipPlayer =>
  ({ id, team, p: P(x, y), v: null, box: seen ? { x: 0, y: 0, w: 10, h: 30 } : null });
const frame = (t: number, players: ClipPlayer[], extra: Partial<ClipFrame> = {}): ClipFrame =>
  ({ t, status: "ok", cut: false, rating: "good", fit: 1, players, ball: null, ballBox: null, ballScore: 0, cal: null, ms: 100, ...extra });

describe("frame schedule", () => {
  it("samples every 1/fps from the start, a little after each boundary, capped at maxSec", () => {
    expect(frameTimes(1, 5)).toEqual([0.01, 0.21, 0.41, 0.61, 0.81]);
    expect(frameTimes(120, 5).length).toBe(300); // 60 s cap
    expect(frameTimes(120, 5).at(-1)).toBeLessThan(CLIP.maxSec);
    expect(frameTimes(0, 5)).toEqual([]);
    expect(frameTimes(Number.NaN, 5)).toEqual([]);
    expect(frameTimes(0.005, 5)).toEqual([]); // shorter than the seek offset
  });
  it("scales to 720p at most, never up, keeping the aspect", () => {
    expect(processingSize(1920, 1080)).toMatchObject({ w: 1280, h: 720 });
    expect(processingSize(640, 360)).toMatchObject({ w: 640, h: 360, k: 1 });
    expect(processingSize(1080, 1920)).toMatchObject({ w: 405, h: 720 }); // portrait
  });
  it("finds the analysed frame shown at a video time", () => {
    const ts = frameTimes(2, 5);
    expect(frameAt(ts, 0)).toBe(0);
    expect(frameAt(ts, 0.5)).toBe(2);
    expect(frameAt(ts, 9)).toBe(ts.length - 1);
    expect(frameAt([], 1)).toBe(-1);
  });
});

describe("camera cuts", () => {
  const grass = img(40, 30, [40, 120, 50]), crowd = img(40, 30, [40, 40, 50]);
  it("histograms: identical frames are 0 apart, disjoint ones 1", () => {
    const a = signature(grass, 2), b = signature(crowd, 2);
    expect(histDistance(a.hist, a.hist)).toBe(0);
    expect(histDistance(a.hist, b.hist)).toBeCloseTo(1);
    expect(a.grass).toBe(1);
    expect(b.grass).toBe(0);
  });
  it("same shot, cut and no-pitch frames", () => {
    const g = signature(grass, 2);
    expect(classifyFrame(null, g)).toBe("same");
    expect(classifyFrame(g, g)).toBe("same");
    // a close-up: still a lot of grass, but half the picture is now a player's kit
    const close = img(40, 30, [40, 120, 50]);
    for (let i = 0; i < 40 * 15; i++) close.data.set([200, 30, 40, 255], i * 4);
    expect(classifyFrame(g, signature(close, 2))).toBe("cut");
    expect(classifyFrame(g, signature(crowd, 2))).toBe("noPitch");
  });
});

describe("tactical numbers", () => {
  // team defending the left goal (x = -52.5): back four at x = -30, midfield at -15, two forwards at 0, a keeper at -50
  const back = [P(-30, -20), P(-30, -7), P(-30, 7), P(-30, 20)];
  const mid = [P(-15, -15), P(-15, 0), P(-15, 15), P(-12, 5)];
  const fwd = [P(0, -5), P(0, 5)];
  const keeper = P(-50, 0);
  it("drops a lone keeper, keeps a deep but not isolated defender", () => {
    expect(outfield([...back, keeper], -1)).toHaveLength(4);
    expect(outfield([P(-45, 0), P(-40, 3), P(-20, 0)], -1)).toHaveLength(3);
    expect(fromOwnGoal(P(-30, 0), -1)).toBe(22.5);
    expect(fromOwnGoal(P(30, 0), 1)).toBe(22.5);
  });
  it("width, depth, line height and the distances between lines", () => {
    const s = teamShape([keeper, ...back, ...mid, ...fwd], -1)!;
    expect(s.n).toBe(10);
    expect(s.width).toBe(40);
    expect(s.depth).toBe(30);
    expect(s.lineHeight).toBe(22.5);
    expect(s.gapDM).toBeCloseTo(15.75); // mid mean x -14.25 vs back -30
    expect(s.gapMA).toBeCloseTo(14.25);
  });
  it("mirrors for the right goal; too few players gives null; lines need 7", () => {
    const mirror = (p: { x: number; y: number }) => P(-p.x, p.y);
    const s = teamShape([...back, ...mid, ...fwd].map(mirror), 1)!;
    expect(s.lineHeight).toBe(22.5);
    expect(teamShape(back.slice(0, 3), -1)).toBeNull();
    const four = teamShape(back, -1)!;
    expect(four.gapDM).toBeNull();
    expect(four.lineHeight).toBe(22.5); // the deepest 2 of 4
  });
  it("possession: nearest team player within 2 m, never 'other'", () => {
    const ps = [player(1, 0, 10, 0), player(2, 1, 11.5, 0), player(3, "other", 12, 0.1)];
    expect(possessionOf(P(11.9, 0), ps)).toBe(1);
    expect(possessionOf(P(10.2, 0), ps)).toBe(0);
    expect(possessionOf(P(20, 0), ps)).toBeNull();
    expect(possessionOf(null, ps)).toBeNull();
    const frames = [frame(0, ps, { ball: P(10, 0) }), frame(0.2, ps, { ball: P(10.1, 0) }), frame(0.4, ps, { ball: P(11.6, 0) }), frame(0.6, ps, { ball: P(30, 0) }),
      frame(0.8, ps, { ball: P(10, 0), status: "poorCal" })];
    expect(possessionShare(frames)).toEqual({ a: 2 / 3, b: 1 / 3, n: 3, open: 1 });
  });
  it("guesses which goal each team defends and averages the shapes over the clip", () => {
    const teamA = [...back, ...mid, ...fwd].map((p, i) => player(i, 0, p.x, p.y));
    const teamB = [...back, ...mid, ...fwd].map((p, i) => player(100 + i, 1, -p.x + 5, p.y));
    const frames = [frame(0, [...teamA, ...teamB]), frame(0.2, [...teamA, ...teamB]), frame(0.4, [], { status: "noPitch" })];
    const g = guessSides(frames);
    expect(g.sides).toEqual([-1, 1]);
    expect(g.agree).toBe(1);
    const [a, b] = teamNumbers(frames, g.sides);
    expect(a.width).toEqual({ mean: 40, n: 2 });
    expect(a.lineHeight.mean).toBe(22.5);
    expect(b.lineHeight.mean).toBe(17.5); // B's back four at x = 35: 17.5 m from the right goal
  });
});

describe("heatmap and diagnostics", () => {
  it("bins positions on the pitch, edge cells take what is a little off", () => {
    const b = heatBins([P(-52.5, -34), P(52.4, 33.9), P(0, 0), P(0.1, 0.1), P(60, 40), P(-60, -40)], 21, 14);
    expect(b.reduce((s, v) => s + v, 0)).toBe(6);
    expect(b[0]).toBe(2);                     // near-left corner + the point off it
    expect(b[13 * 21 + 20]).toBe(2);          // far-right corner + the point off it
    expect(b[7 * 21 + 10]).toBe(2);           // centre cell
  });
  it("counts calibration, cuts, skipped frames and tracks", () => {
    const fr = [
      frame(0, [player(1, 0, 0, 0), player(2, 1, 5, 5)]),
      frame(0.2, [player(1, 0, 0, 0), player(2, 1, 5, 5, false)]),
      frame(0.4, [player(1, 0, 0, 0)]),
      frame(0.6, [], { status: "poorCal" }),
      frame(0.8, [], { status: "noPitch", cut: true, ms: 5 }),
    ];
    const d = diagnostics(fr, 5);
    expect(d).toMatchObject({ frames: 5, goodCal: 0.6, poorCal: 1, noPitch: 1, cuts: 1, tracks: 1 });
    expect(d.avgTrackSec).toBeCloseTo(0.6); // seen at 0, 0.2, 0.4 -> 0.4 s + one frame
    expect(d.msPerFrame).toBe(100);
  });
});
