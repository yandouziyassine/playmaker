import { describe, expect, it } from "vitest";
import {
  attackDirection, ballGround, BALL_MIN_SCORE, keepBalls, pickBall, pickCarrier, rejectBall, stepBall, trackBox, type Ball, type BallTrack,
} from "../src/lab/ball.ts";
import { applyH, invert3, type Pt } from "../src/lab/homography.ts";
import { keepPersons, type RawDetection } from "../src/lab/players.ts";
import { sceneHomography, SCENE_BALL, SCENE_PLAYERS, SCENE_W } from "../src/lab/scene.ts";
import type { TeamLabel } from "../src/lab/teams.ts";

const det = (name: string, score: number, x: number, y: number, w: number, h: number): RawDetection =>
  ({ boundingBox: { originX: x, originY: y, width: w, height: h }, categories: [{ categoryName: name, score }] });
const ball = (x: number, y: number, s = 12, score = 0.5): Ball => ({ box: { x, y, w: s, h: s }, score });

describe("ball detections", () => {
  it("keeps sports balls above the (low) ball threshold, people stay at their own threshold", () => {
    const dets = [det("sports ball", 0.2, 10, 10, 8, 8), det("sports ball", 0.1, 50, 50, 8, 8), det("person", 0.2, 0, 0, 20, 50), det("person", 0.6, 0, 0, 20, 50)];
    expect(BALL_MIN_SCORE).toBeLessThan(0.3);
    expect(keepBalls(dets)).toEqual([{ box: { x: 10, y: 10, w: 8, h: 8 }, score: 0.2 }]);
    expect(keepPersons(dets)).toHaveLength(1); // the 0.2 person is still dropped
    expect(ballGround({ x: 10, y: 10, w: 8, h: 8 })).toEqual({ x: 14, y: 18 });
  });

  it("filters implausible boxes: elongated, too big, on a head", () => {
    const person = { box: { x: 100, y: 100, w: 40, h: 100 }, score: 0.9 };
    expect(rejectBall({ box: { x: 0, y: 0, w: 30, h: 8 }, score: 0.9 }, [], null, 1280)).toBe("not round");
    expect(rejectBall(ball(0, 0, 200), [], null, 1280)).toBe("too big");
    expect(rejectBall(ball(114, 102, 12), [person], null, 1280)).toBe("head"); // centre in the top 22 % of the box
    expect(rejectBall(ball(114, 185, 12), [person], null, 1280)).toBeNull(); // at his feet: fine
  });

  it("ignores balls in the crowd above the reprojected pitch once calibrated", () => {
    const i2p = invert3(sceneHomography())!;
    const field = applyH(sceneHomography(), { x: 40, y: 0 })!, crowdPt = { x: 600, y: 40 }; // y = 40 px is in the stands of the synthetic scene
    const good = ball(field.x - 6, field.y - 12, 12, 0.3), crowd = ball(crowdPt.x - 6, crowdPt.y - 12, 12, 0.9);
    expect(rejectBall(crowd, [], i2p, SCENE_W)).toBe("crowd");
    expect(rejectBall(crowd, [], null, SCENE_W)).toBeNull(); // not calibrated: cannot tell
    expect(pickBall([crowd, good], [], i2p, SCENE_W)).toBe(good); // best-scoring valid box
    expect(pickBall([crowd, good], [], null, SCENE_W)).toBe(crowd);
    expect(pickBall([], [], i2p, SCENE_W)).toBeNull();
  });
});

describe("live ball tracker", () => {
  it("smooths a moving ball, coasts through a miss, drops it after several", () => {
    let t: BallTrack | null = null;
    for (let k = 0; k < 12; k++) t = stepBall(t, ball(100 + 20 * k, 300), 0.1, 1280); // 200 px/s to the right
    expect(t!.v.x).toBeCloseTo(200, -1);
    expect(t!.c.x).toBeGreaterThan(100 + 20 * 11 + 6 - 8);
    const before = t!.c.x;
    t = stepBall(t, null, 0.1, 1280);
    expect(t!.misses).toBe(1);
    expect(t!.c.x).toBeGreaterThan(before + 10); // predicted forward
    for (let k = 0; k < 4; k++) t = stepBall(t, null, 0.1, 1280);
    expect(t).toBeNull();
  });
  it("ignores one far outlier, but follows a new ball once the old one is lost", () => {
    let t: BallTrack | null = null;
    for (let k = 0; k < 5; k++) t = stepBall(t, ball(400, 300), 0.1, 1280);
    t = stepBall(t, ball(1100, 100), 0.1, 1280); // a head far away
    expect(t!.c.x).toBeCloseTo(406, 0);
    expect(t!.misses).toBe(1);
    t = stepBall(t, ball(1100, 100), 0.1, 1280);
    expect(t!.c.x).toBeCloseTo(1106, 0);
    expect(trackBox(t!).w).toBeCloseTo(12, 6);
  });
});

describe("automatic carrier and direction", () => {
  const pos: Pt[] = SCENE_PLAYERS.map((p) => p.p);
  const labels: TeamLabel[] = SCENE_PLAYERS.map((p) => (p.kit.shirt === "#d7263d" ? 0 : p.kit.shirt === "#f4f4f4" ? 1 : "other"));

  it("picks the nearest team player within 3 m of the ball", () => {
    const c = pickCarrier(SCENE_BALL, pos, labels)!;
    expect(pos[c.index]).toEqual({ x: 42, y: 8 });
    expect(labels[c.index]).toBe(0);
    expect(c.dist).toBeLessThan(1.1);
    expect(pickCarrier({ x: 0, y: -30 }, pos, labels)).toBeNull(); // nobody within 3 m
    // the referee at (29, 9) is never the carrier, even when closest
    const r = pickCarrier({ x: 29, y: 9.2 }, pos, labels);
    expect(r === null || labels[r.index] !== "other").toBe(true);
    expect(pickCarrier({ x: 42, y: 8 }, [null, ...pos.slice(1)], labels)).toBeTruthy();
  });

  it("guesses the attacking direction from the deepest players", () => {
    // right half of the pitch: white has the deepest outfield player near the right goal -> white defends it, red attacks it
    expect(attackDirection(pos, labels, 0)).toEqual({ dir: 1, ownSide: -1 });
    expect(attackDirection(pos, labels, 1)).toEqual({ dir: -1, ownSide: 1 });
    // mirrored picture: everything flips
    const mirror = pos.map((p) => ({ x: -p.x, y: p.y }));
    expect(attackDirection(mirror, labels, 0)!.dir).toBe(-1);
    // no opponent on the map: the plain deepest player decides (own goal on his side)
    const lone: TeamLabel[] = [0, 0, 0];
    expect(attackDirection([{ x: -40, y: 0 }, { x: -10, y: 5 }, { x: 5, y: 0 }], lone, 0)).toEqual({ dir: 1, ownSide: -1 });
    expect(attackDirection([{ x: 1, y: 1 }], [1], 0)).toBeNull();
  });
});

describe("ball-only tiled pass", () => {
  it("skips tiles of crowd and sky (grass share of a coarse sample)", async () => {
    const { grassShare, BALL_TILES, tiles } = await import("../src/lab/detector.ts");
    const w = 120, h = 60, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x), grass = y >= 20;
      data[i] = grass ? 40 : 30; data[i + 1] = grass ? 120 : 35; data[i + 2] = grass ? 50 : 45; data[i + 3] = 255;
    }
    const img = { data, width: w, height: h };
    expect(grassShare(img, { x: 0, y: 0, w: 120, h: 18 })).toBe(0);
    expect(grassShare(img, { x: 0, y: 30, w: 60, h: 30 })).toBe(1);
    expect(grassShare(img, { x: 0, y: 0, w: 120, h: 60 })).toBeCloseTo(2 / 3, 1);
    const kept = tiles(w, h, BALL_TILES.cols, BALL_TILES.rows).filter((t) => grassShare(img, t) >= BALL_TILES.minGrass);
    expect(kept.length).toBeLessThan(BALL_TILES.cols * BALL_TILES.rows);
    expect(kept.length).toBeGreaterThan(0);
  });
});
