import { describe, expect, it } from "vitest";
import {
  assignTeam, associate, cameraMoved, capSpeed, delayUntilNext, fixCentroids, moveStreak, nextFps, nextThrottle, patchDiffs, smooth,
  START_THROTTLE, stepTracks, THROTTLE, thumbnail, THUMB_H, THUMB_W, trackVelocity, velocityFrom, vote, voted, type LiveDet, type Track,
} from "../src/lab/live.ts";
import { cameraProblem, CAMERA_MESSAGES } from "../src/lab/camera.ts";
import type { RGB } from "../src/lab/teams.ts";

// deterministic noise
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("throttle", () => {
  it("adapts the interval to the measured time (duty 50 %), clamped to 10 fps .. 1 fps", () => {
    let t = START_THROTTLE;
    for (let k = 0; k < 30; k++) t = nextThrottle(t, 75);
    expect(t.avgMs).toBeCloseTo(75, 6);
    expect(t.interval).toBeCloseTo(150, 6); // 6.7 detections/s
    for (let k = 0; k < 30; k++) t = nextThrottle(t, 10);
    expect(t.interval).toBe(THROTTLE.minInterval);
    for (let k = 0; k < 40; k++) t = nextThrottle(t, 5000);
    expect(t.interval).toBe(THROTTLE.maxInterval);
  });
  it("smooths one slow frame instead of jumping", () => {
    let t = START_THROTTLE;
    for (let k = 0; k < 20; k++) t = nextThrottle(t, 60);
    const spike = nextThrottle(t, 400);
    expect(spike.interval).toBeGreaterThan(120);
    expect(spike.interval).toBeLessThan(400);
  });
  it("waits only for the rest of the interval", () => {
    expect(delayUntilNext(150, 60)).toBe(90);
    expect(delayUntilNext(150, 200)).toBe(0);
  });
  it("measures detections per second", () => {
    let f: number | null = null;
    for (let k = 0; k < 50; k++) f = nextFps(f, 125);
    expect(f).toBeCloseTo(8, 6);
    expect(nextFps(8, 0)).toBe(8);
  });
});

describe("fixed team centroids", () => {
  const red: RGB = [200, 30, 45], white: RGB = [235, 235, 235], yellow: RGB = [240, 220, 10];
  const jitter = (c: RGB, r: () => number): RGB => c.map((v) => Math.max(0, Math.min(255, v + (r() - 0.5) * 20))) as RGB;
  const r = rng(7);
  const frame = [...Array.from({ length: 6 }, () => jitter(red, r)), ...Array.from({ length: 6 }, () => jitter(white, r)), yellow];
  const cents = fixCentroids(frame)!;

  it("keeps two team centroids and a third one for the referee", () => {
    expect(cents.centres).toHaveLength(3);
    expect(cents.separation).toBeGreaterThan(30);
  });
  it("assigns new detections to the nearest stored centroid, frame after frame", () => {
    const teamOfRed = assignTeam(red, cents), teamOfWhite = assignTeam(white, cents);
    expect(teamOfRed).not.toBe(teamOfWhite);
    expect(teamOfRed).not.toBe("other");
    for (let k = 0; k < 20; k++) {
      expect(assignTeam(jitter(red, r), cents)).toBe(teamOfRed);
      expect(assignTeam(jitter(white, r), cents)).toBe(teamOfWhite);
    }
    expect(assignTeam(yellow, cents)).toBe("other");
    expect(assignTeam([20, 60, 220], cents)).toBe("other"); // far from both kits
  });
  it("needs a few colours and two teams", () => {
    expect(fixCentroids([red, white])).toBeNull();
  });
  it("team votes resist a single odd frame", () => {
    let v = vote([0, 0, 0], 0);
    for (let k = 0; k < 4; k++) v = vote(v, 0);
    v = vote(v, 1);
    expect(voted(v)).toBe(0);
    for (let k = 0; k < 6; k++) v = vote(v, 1);
    expect(voted(v)).toBe(1);
    expect(voted(vote([0, 0, 0], "other"))).toBe("other");
  });
});

describe("tracking", () => {
  it("smooths positions exponentially and estimates velocities", () => {
    expect(smooth({ x: 0, y: 0 }, { x: 10, y: -4 }, 0.5)).toEqual({ x: 5, y: -2 });
    expect(velocityFrom({ x: 0, y: 0 }, { x: 3, y: 1 }, 0.5)).toEqual({ x: 6, y: 2 });
    expect(velocityFrom({ x: 0, y: 0 }, { x: 3, y: 1 }, 0)).toEqual({ x: 0, y: 0 });
    const c = capSpeed({ x: 30, y: 40 }, 10);
    expect(Math.hypot(c.x, c.y)).toBeCloseTo(10, 9);
  });

  it("associates nearest neighbours within the gate, never across teams", () => {
    const pred = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const dets: LiveDet[] = [{ p: { x: 10.5, y: 0.2 }, team: 1 }, { p: { x: 0.4, y: -0.3 }, team: 0 }, { p: { x: 30, y: 0 }, team: 0 }];
    expect(associate(pred, [4, 4], [0, 1], dets)).toEqual([1, 0]);
    // the only nearby detection is of the other team: no match
    expect(associate([{ x: 0, y: 0 }], [4], [0], [{ p: { x: 1, y: 0 }, team: 1 }])).toEqual([-1]);
    // "other" can match anyone (a label still being decided)
    expect(associate([{ x: 0, y: 0 }], [4], [0], [{ p: { x: 1, y: 0 }, team: "other" }])).toEqual([0]);
    // shortest pair first: the contested detection goes to the closer track
    expect(associate([{ x: 0, y: 0 }, { x: 3, y: 0 }], [4, 4], [0, 0], [{ p: { x: 2.5, y: 0 }, team: 0 }])).toEqual([-1, 0]);
  });

  it("follows two players running at constant speed with noisy detections, ids stable, velocities ~ right", () => {
    const r = rng(3), dt = 0.15;
    let tracks: Track[] = [], nextId = 1;
    const ids = new Set<string>();
    for (let k = 0; k < 40; k++) {
      const t = k * dt;
      const a = { x: -10 + 6 * t, y: 5 }, b = { x: 10, y: -5 + 3 * t }; // 6 m/s along x, 3 m/s along y
      const n = () => (r() - 0.5) * 0.8; // +-0.4 m of detection noise
      const dets: LiveDet[] = [{ p: { x: b.x + n(), y: b.y + n() }, team: 1 }, { p: { x: a.x + n(), y: a.y + n() }, team: 0 }];
      const res = stepTracks(tracks, dets, dt, nextId);
      tracks = res.tracks; nextId = res.nextId;
      ids.add(`${res.byDet[0]!.id}-${res.byDet[1]!.id}`);
    }
    expect(ids.size).toBe(1);
    expect(tracks).toHaveLength(2);
    const ta = tracks.find((t) => t.team === 0)!, tb = tracks.find((t) => t.team === 1)!;
    const va = trackVelocity(ta)!, vb = trackVelocity(tb)!;
    expect(va.x).toBeGreaterThan(5); expect(va.x).toBeLessThan(7); expect(Math.abs(va.y)).toBeLessThan(1);
    expect(vb.y).toBeGreaterThan(2.2); expect(vb.y).toBeLessThan(3.8); expect(Math.abs(vb.x)).toBeLessThan(1);
    // the smoothed position sits closer to the truth than the noise amplitude
    const tEnd = 39 * dt;
    expect(Math.hypot(ta.p.x - (-10 + 6 * tEnd), ta.p.y - 5)).toBeLessThan(0.6);
  });

  it("standing players get a small speed despite the noise", () => {
    const r = rng(11);
    let tracks: Track[] = [], nextId = 1;
    for (let k = 0; k < 30; k++) {
      const res = stepTracks(tracks, [{ p: { x: 20 + (r() - 0.5) * 0.6, y: (r() - 0.5) * 0.6 }, team: 0 }], 0.15, nextId);
      tracks = res.tracks; nextId = res.nextId;
    }
    const v = trackVelocity(tracks[0]!)!;
    expect(Math.hypot(v.x, v.y)).toBeLessThan(1.5);
  });

  it("keeps a missed track for a few frames, then drops it; far detections start new tracks", () => {
    let { tracks, nextId } = stepTracks([], [{ p: { x: 0, y: 0 }, team: 0 }], 0.15, 1);
    expect(trackVelocity(tracks[0]!)).toBeNull(); // too young for a velocity
    for (let k = 0; k < 3; k++) ({ tracks, nextId } = stepTracks(tracks, [], 0.15, nextId));
    expect(tracks).toHaveLength(1);
    ({ tracks, nextId } = stepTracks(tracks, [], 0.15, nextId));
    expect(tracks).toHaveLength(0);
    const res = stepTracks([{ id: 1, p: { x: 0, y: 0 }, v: { x: 0, y: 0 }, hits: 5, misses: 0, votes: [3, 0, 0], team: 0 }], [{ p: { x: 20, y: 0 }, team: 0 }], 0.15, 2);
    expect(res.byDet[0]!.id).toBe(2);
    expect(res.tracks).toHaveLength(2);
  });
});

describe("camera moved check", () => {
  // synthetic RGBA frames: a pitch-like pattern of stripes and lines, optionally shifted and with moving blobs
  function frame(w: number, h: number, shift: number, blobs: { x: number; y: number }[] = [], gain = 1) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const X = x + shift;
      let v = (Math.floor(X / 40) % 2 ? 90 : 120) + (Math.abs((X % 160) - 80) < 2 || Math.abs((y % 120) - 60) < 2 ? 120 : 0);
      for (const b of blobs) if (Math.abs(x - b.x) < 6 && Math.abs(y - b.y) < 14) v = 230;
      const k = (y * w + x) * 4;
      data[k] = v * gain * 0.6; data[k + 1] = v * gain; data[k + 2] = v * gain * 0.5; data[k + 3] = 255;
    }
    return { data, width: w, height: h };
  }
  const W = 320, H = 180;
  const ref = thumbnail(frame(W, H, 0, [{ x: 50, y: 90 }, { x: 200, y: 60 }]));

  it("ignores moving players and a brightness change", () => {
    expect(ref).toHaveLength(THUMB_W * THUMB_H);
    const players = thumbnail(frame(W, H, 0, [{ x: 70, y: 100 }, { x: 180, y: 70 }, { x: 260, y: 120 }]));
    expect(cameraMoved(patchDiffs(ref, players))).toBe(false);
    const brighter = thumbnail(frame(W, H, 0, [{ x: 50, y: 90 }, { x: 200, y: 60 }], 1.15));
    expect(cameraMoved(patchDiffs(ref, brighter))).toBe(false);
  });
  it("flags a pan of the view", () => {
    const panned = thumbnail(frame(W, H, 37, [{ x: 50, y: 90 }, { x: 200, y: 60 }]));
    expect(cameraMoved(patchDiffs(ref, panned))).toBe(true);
  });
  it("warns only after consecutive moved frames", () => {
    let s = 0;
    for (const m of [true, false, true, true, true]) s = moveStreak(s, m);
    expect(s).toBe(3);
    expect(cameraMoved([])).toBe(false);
  });
});

describe("camera errors", () => {
  it("turns getUserMedia errors into clear messages", () => {
    expect(cameraProblem({ name: "NotAllowedError" })).toBe("denied");
    expect(cameraProblem({ name: "NotFoundError" })).toBe("notfound");
    expect(cameraProblem({ name: "NotReadableError" })).toBe("busy");
    expect(cameraProblem({ name: "InsecureContext" })).toBe("insecure");
    expect(cameraProblem(new Error("x"))).toBe("other");
    expect(cameraProblem(null)).toBe("other");
    expect(CAMERA_MESSAGES.insecure).toMatch(/HTTPS/);
  });
});
