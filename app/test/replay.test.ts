// Free play: binary decode, time mapping, carrier snapping, coach state, fixed view orientation, pro reveal; synthetic
// frames first, then the shipped match (app/public/replay, CC BY 4.0) end to end with the shipped coach weights.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coachFromModels, type ModelsJson } from "../src/coach/models.ts";
import { toScreen as gameToScreen } from "../src/pitch.ts";
import { arrowLabel, placeLabel, toScreen } from "../src/replay/draw.ts";
import { adviceAt, optionEnd, outcome, proChoice, proLabel, snapFrame } from "../src/replay/coach.ts";
import {
  ABSENT, ballAt, carrierAt, clock, decodeHalf, frameDots, fromGlobal, goals, minuteLabel, nearestCarrierFrame, ownerAt,
  playerAt, scoreAt, stateAt, toGlobal, toView, totalFrames, velocityAt, viewFlip, type HalfInfo, type MatchMeta,
} from "../src/replay/data.ts";

// ---------- a tiny synthetic match: 3 players (0, 1 home; 2 guest), 2 halves of 40 frames ----------
type P = [number, number] | null;
function bin(frames: P[][]): ArrayBuffer {
  const out = new Int16Array(frames.length * frames[0]!.length * 2);
  frames.forEach((row, f) => row.forEach((p, c) => {
    const i = (f * row.length + c) * 2;
    out[i] = p ? Math.round(p[0] * 100) : ABSENT; out[i + 1] = p ? Math.round(p[1] * 100) : 0;
  }));
  return out.buffer;
}
const N = 40;
const info: HalfInfo = { frames: N, slots: [0, 1, 2], attack: [-1, 1] };
// player 0 runs +x at 1.25 m/frame from -10; ball with player 0 for frames < 20, then in flight; player 1 absent at frame 5
const rows: P[][] = Array.from({ length: N }, (_, f) => {
  const p0: P = [-10 + 1.25 * f, 2], p1: P = f === 5 ? null : [-20, -10], p2: P = [-30, 0];
  const ball: P = f < 20 ? [p0[0] + 0.5, 2] : [p0[0] + 8, 2];
  return [p0, p1, p2, ball];
});
const meta: MatchMeta = {
  match_id: "T", fps: 12.5, halves: [info, { ...info, attack: [1, -1] }],
  players: [{ team: 0, shirt: 10, name: "Ten" }, { team: 0, shirt: 7, name: "Seven" }, { team: 1, shirt: 4, name: "Four" }],
  meta: { home: "Home", guest: "Away", colors: ["#9F1922", "#FFFFFF"] },
  owner: ["1".repeat(N), "2".repeat(N)], alive: ["1".repeat(N), "1".repeat(30) + "0".repeat(10)],
  events: [
    { type: "shot", half: 0, frame: 30, team: 0, player: 0, goal: true },
    { type: "shot", half: 1, frame: null, nominal: 10, team: 1, player: 2, goal: true },
    { type: "shot", half: 1, frame: 12, team: 1, player: 2, goal: false },
    { type: "pass", half: 0, frame: 22, team: 0, player: 0, recipient: 1, success: true },
  ],
  credit: "test",
};
const h = decodeHalf(bin(rows), info, 3);

describe("replay binary decode", () => {
  it("reads centimetres per slot then the ball, and absent markers", () => {
    expect(playerAt(h, 0, 0)).toEqual([-10, 2]);
    expect(playerAt(h, 4, 1)).toEqual([-20, -10]);
    expect(playerAt(h, 5, 1)).toBeNull();
    expect(ballAt(h, 0)).toEqual([-9.5, 2]);
    expect(playerAt(h, 0, 7)).toBeNull(); // not a slot of this half
  });
  it("rejects a file of the wrong size", () => {
    expect(() => decodeHalf(new ArrayBuffer(10), info, 3)).toThrow(/expected/);
  });
  it("velocity is a 2-frame backward difference, zero at the start or when absent", () => {
    const v = velocityAt(h, 10, 0, 12.5);
    expect(v[0]).toBeCloseTo(1.25 * 12.5); expect(v[1]).toBeCloseTo(0);
    expect(velocityAt(h, 0, 0, 12.5)).toEqual([0, 0]);
    expect(velocityAt(h, 7, 1, 12.5)).toEqual([0, 0]); // frame 5 absent
  });
  it("interpolates fractional frames", () => {
    const d = frameDots(h, 2.5);
    expect(d.players.find((p) => p.player === 0)!.at[0]).toBeCloseTo(-10 + 1.25 * 2.5);
    expect(d.players.find((p) => p.player === 1)!.at).toEqual([-20, -10]);
  });
});

describe("replay time mapping", () => {
  it("global <-> (half, frame) round trip and clamping", () => {
    expect(totalFrames(meta)).toBe(80);
    expect(toGlobal(meta, 1, 3)).toBe(43);
    expect(fromGlobal(meta, 43)).toEqual({ half: 1, frame: 3 });
    expect(fromGlobal(meta, 38.5)).toEqual({ half: 0, frame: 38.5 });
    expect(fromGlobal(meta, 39.5)).toEqual({ half: 0, frame: 39 }); // clamped to the last frame of the half
    expect(fromGlobal(meta, -5)).toEqual({ half: 0, frame: 0 });
    expect(fromGlobal(meta, 500)).toEqual({ half: 1, frame: 39 });
    for (const g of [0, 17, 39, 40, 79]) { const w = fromGlobal(meta, g); expect(toGlobal(meta, w.half, w.frame)).toBe(g); }
  });
  it("clock and minute labels", () => {
    expect(clock(0, 0, 12.5)).toBe("00:00");
    expect(clock(1, 12.5 * 61, 12.5)).toBe("46:01");
    expect(minuteLabel(0, 0, 12.5)).toBe("1'");
    expect(minuteLabel(1, 0, 12.5)).toBe("46'");
    expect(minuteLabel(0, 12.5 * 60 * 46.5, 12.5)).toBe("45+2'");
    expect(minuteLabel(1, 12.5 * 60 * 45.2, 12.5)).toBe("90+1'");
  });
  it("live score counts goals up to the frame (nominal frame when unsynced)", () => {
    expect(scoreAt(meta, 0, 29)).toEqual([0, 0]);
    expect(scoreAt(meta, 0, 30)).toEqual([1, 0]);
    expect(scoreAt(meta, 1, 10)).toEqual([1, 1]);
    expect(goals(meta).map((g) => [g.half, g.frame, g.team])).toEqual([[0, 30, 0], [1, 10, 1]]);
  });
});

describe("replay carrier snapping", () => {
  it("the nearest player of the team in possession within 2 m has the ball", () => {
    expect(ownerAt(meta, 0, 3)).toBe(0); expect(ownerAt(meta, 1, 3)).toBe(1);
    expect(carrierAt(meta, 0, h, 10)).toEqual({ player: 0, team: 0 });
    expect(carrierAt(meta, 0, h, 25)).toBeNull(); // ball 8 m ahead
  });
  it("snaps to the closest frame with a carrier within 2 s, earlier first", () => {
    expect(nearestCarrierFrame(meta, 0, h, 10)).toBe(10);
    expect(nearestCarrierFrame(meta, 0, h, 25)).toBe(19);
    expect(nearestCarrierFrame(meta, 0, h, 39, 1, 1)).toBeNull(); // 20 frames away > 12.5
    expect(snapFrame(meta, 0, h, 22)).toBe(19);
  });
  it("no carrier when the ball is dead", () => {
    const h1 = decodeHalf(bin(rows), meta.halves[1]!, 3);
    expect(carrierAt(meta, 1, h1, 35)).toBeNull();
  });
});

describe("replay coach state and view", () => {
  it("state is attack-normalised for the team in question", () => {
    const s = stateAt(meta, 0, h, 10, 0); // home attacks -x in the first half: turned 180°
    expect(s.direction).toBe(-1);
    expect(s.attIdx).toEqual([0, 1]); expect(s.defIdx).toEqual([2]);
    expect(s.att[0]![0]).toBeCloseTo(-(-10 + 12.5)); expect(s.att[0]![1]).toBeCloseTo(-2);
    expect(s.attV[0]![0]).toBeCloseTo(-1.25 * 12.5);
    expect(s.ball[0]).toBeCloseTo(-(-10 + 12.5 + 0.5));
    const g = stateAt(meta, 0, h, 10, 1);
    expect(g.direction).toBe(1); expect(g.att[0]).toEqual([-30, 0]);
  });
  it("fixed view: the home team attacks up the screen in the first half", () => {
    const flip = viewFlip(meta), v = { w: 400, h: 600 };
    expect(flip).toBe(-1);
    const ownGoal = toScreen(toView([52.5, 0], flip), v), target = toScreen(toView([-52.5, 0], flip), v); // home attacks -x
    expect(target[1]).toBeLessThan(ownGoal[1]);
    expect(viewFlip({ halves: [{ ...info, attack: [1, -1] }] })).toBe(1);
    for (const p of [[10, 5], [-52.5, 34], [0, 0]] as [number, number][]) expect(toScreen(p, v)).toEqual(gameToScreen(p, v)); // same mapping as the game
  });
  it("option end points come back in raw metres", () => {
    const s = stateAt(meta, 0, h, 10, 0);
    expect(optionEnd({ kind: "pass", target: 1, to: [0, 0], p: 1, value: 0, score: 0 }, s)).toEqual([-20, -10]);
    expect(optionEnd({ kind: "shot", to: [52.5, 0], p: 1, value: 1, score: 0 }, s)).toEqual([-52.5, -0]);
  });
  it("the pro's next pass is revealed and the outcome read from events and possession", () => {
    const opts = [{ kind: "pass" as const, target: 1, to: [0, 0] as [number, number], p: 0.9, value: 0.02, score: 0.01 }];
    const pro = proChoice(meta, 0, h, 19, { player: 0, team: 0 }, opts);
    expect(pro).toMatchObject({ kind: "pass", revealFrame: 22, recipient: 1, success: true });
    expect(pro.option).toBe(opts[0]);
    expect(proLabel(pro, meta.players)).toMatch(/passed to #7 Seven \(coach value \+0\.010 xG\)/);
    expect(outcome(meta, 0, 19, 0)).toBe("goal");
    expect(outcome(meta, 1, 0, 0)).toBe("lost");
    expect(arrowLabel(0, opts[0]!)).toBe("1 · 90 % · +0.010 xG");
  });
});

describe("replay arrow labels", () => {
  it("never overlap and stay on the canvas", () => {
    const v = { w: 300, h: 400 }, taken: { x: number; y: number; w: number; h: number }[] = [];
    for (let i = 0; i < 3; i++) taken.push(placeLabel({ x: 290, y: 100 + i * 3, w: 80, h: 16 }, taken, v));
    for (const b of taken) { expect(b.x + b.w).toBeLessThanOrEqual(298); expect(b.y).toBeGreaterThanOrEqual(2); }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const a = taken[i]!, b = taken[j]!;
      expect(a.y + a.h <= b.y || b.y + b.h <= a.y || a.x + a.w <= b.x || b.x + b.w <= a.x).toBe(true);
    }
  });
});

// ---------- the shipped match ----------
describe("replay shipped match data", () => {
  const read = (f: string) => readFileSync(new URL(`../public/replay/${f}`, import.meta.url));
  const m: MatchMeta = JSON.parse(read("match.json").toString("utf8"));
  const models: ModelsJson = JSON.parse(readFileSync(new URL("../public/coach/models.json", import.meta.url), "utf8"));
  const coach = coachFromModels(models);
  const buf = read("h0.bin");
  const h0 = decodeHalf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, m.halves[0]!, m.players.length);

  it("decodes the first half and has the credit line", () => {
    expect(m.fps).toBe(12.5);
    expect(m.owner[0]!.length).toBe(m.halves[0]!.frames);
    expect(m.credit).toMatch(/CC BY 4\.0/);
    const ball = ballAt(h0, 1000)!;
    expect(Math.abs(ball[0])).toBeLessThan(60); expect(Math.abs(ball[1])).toBeLessThan(40);
  });
  it("pausing anywhere in play snaps to a carrier and the coach ranks at least 3 options with reasons", () => {
    let asked = 0;
    for (let f = 2000; f < m.halves[0]!.frames; f += 5000) {
      const s = snapFrame(m, 0, h0, f);
      if (s === null) continue;
      const a = adviceAt(m, 0, h0, s, coach, models)!;
      expect(a).not.toBeNull();
      expect(a.ranked.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < a.ranked.length; i++) expect(a.ranked[i - 1]!.option.score).toBeGreaterThanOrEqual(a.ranked[i]!.option.score);
      expect(a.ranked[0]!.reasons.length).toBeGreaterThan(0);
      const top = a.ranked[0]!;
      if (top.option.kind === "pass") expect(top.to).toEqual(playerAt(h0, s, top.option.target!));
      asked++;
    }
    expect(asked).toBeGreaterThan(2);
  });
});
