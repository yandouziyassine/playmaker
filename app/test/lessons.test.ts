import { afterEach, describe, expect, it } from "vitest";
import type { Moment, PickResult, Reason } from "../src/api.ts";
import {
  CROWDED, LANE_M, LONG_M, dayNotebook, lessonsFor as rawLessonsFor, notebookFromRecords, passGeom, revealLesson, SKILL_OF, shotGeom,
  valuesOf, weakestSkill, type Lesson,
} from "../src/lessons.ts";
import { setLang } from "../src/i18n/index.ts";
import { History } from "../src/storage.ts";
import { computeStats, toRecord } from "../src/stats.ts";

afterEach(() => setLang("en"));

type M = [number, number]; // metres, attack towards +x
/** A hand-built moment: the carrier (#10) at `carrier`, teammates (#7, #9, ...) and defenders, in metres. */
function moment(o: { carrier?: M; mates: M[]; defs?: M[]; options: Moment["options"] }): Moment {
  const pos = [o.carrier ?? [0, 0], ...o.mates, ...(o.defs ?? [])].map(([x, y]) => [x * 100, y * 100] as [number, number]);
  const players = [
    { side: 0 as const, shirt: 10, name: "Carrier" },
    ...o.mates.map((_, i) => ({ side: 0 as const, shirt: [7, 9, 11, 8][i] ?? 20 + i, name: ["Seven", "Nine", "Eleven", "Eight"][i] ?? `M${i}` })),
    ...(o.defs ?? []).map((_, i) => ({ side: 1 as const, shirt: 30 + i, name: `D${i}` })),
  ];
  return {
    id: "t", league: "L", home: "H", away: "A", attacking: "home", minute: 10, fps: 10, carrier: 0, players,
    lead_up: [pos], ball: [pos[0]!], options: o.options, credit: "",
  };
}
const pass = (k: number, player: number, to: M): Moment["options"][number] => ({ k, kind: "pass", player, to: [to[0] * 100, to[1] * 100] });
function result(o: Partial<PickResult> & { option: number; ai_pick: number }): PickResult {
  return {
    points: 30, among_best: false, pro_instinct: false, pro_pick: -1, outcome: { kind: "kept", net_xg_15s: 0 },
    reasons: {}, crowd: null, repeat: false, all_points: {}, after: null, guess: null, guess_right: null, ...o,
  };
}
const ids = (ls: Lesson[]) => ls.map((l) => l.id);
/** Numbers and "m" are bound by a no-break space in the dictionaries; the assertions below read plain spaces. */
const plain = (x: string) => x.replace(/ /g, " ");
const lessonsFor = (...a: Parameters<typeof rawLessonsFor>): Lesson[] =>
  rawLessonsFor(...a).map((l) => ({ ...l, title: plain(l.title), body: plain(l.body), evidence: l.evidence.map((e) => ({ ...e, text: plain(e.text) })) }));
const FAR: M[] = [[0, 30], [0, -30]]; // defenders far from every line and receiver

describe("geometry", () => {
  it("counts defenders within 2 m of the pass line (ends excluded) and the receiver's space", () => {
    const mo = moment({ mates: [[20, 0]], defs: [[10, 1.9], [10, -2.1], [19.5, 0.5], ...FAR], options: [pass(0, 1, [20, 0])] });
    const g = passGeom(mo, mo.options[0]!)!;
    expect(g.length).toBeCloseTo(20); expect(g.forward).toBeCloseTo(20); expect(g.angle).toBeCloseTo(0);
    expect(g.lane).toBe(1); // 1.9 m in, 2.1 m out, the one at the receiver (t > 0.95) not counted
    expect(g.space).toBeCloseTo(Math.hypot(0.5, 0.5));
    expect(LANE_M).toBe(2);
  });
  it("shot distance and goal mouth from the carrier", () => {
    const g = shotGeom(moment({ carrier: [24.5, 0], mates: [], options: [] }))!;
    expect(g.dist).toBeCloseTo(28); expect(g.angle).toBeGreaterThan(14); expect(g.angle).toBeLessThan(16);
  });
  it("reads the coach's value phrases", () => {
    const r = (text: string): Reason => ({ text, effect: 0 });
    expect(valuesOf([r("+0.021 xG if it arrives, -0.004 if lost there")])).toEqual({ gain: 0.021, loss: -0.004 });
    expect(valuesOf([r("12 % pitch control where the carry ends"), r("+0.001 xG if kept, -0.015 if lost there")])).toEqual({ control: 12, gain: 0.001, loss: -0.015 });
    expect(valuesOf([r("+0.040 xG for the shot, +0.010 if the ball is kept here")])).toEqual({ shotXg: 0.04 });
    expect(valuesOf(undefined)).toEqual({});
  });
});

describe("rules", () => {
  it("crowded lane: 2+ defenders near the line; the AI's alternative with its clear line", () => {
    const mo = moment({ mates: [[20, 0], [10, 15]], defs: [[8, 1], [12, -1.5], ...FAR], options: [pass(0, 1, [20, 0]), pass(1, 2, [10, 15])] });
    const ls = lessonsFor(mo, result({ option: 0, ai_pick: 1 }), (k) => `opt${k}`);
    expect(ids(ls)).toContain("lane");
    const l = ls.find((x) => x.id === "lane")!;
    expect(l.skill).toBe("scanning");
    expect(l.body).toBe("You passed into a crowded lane: 2 defenders were within 2 m of the line. The AI preferred #9 Nine, on a clear line.");
    expect(l.evidence.map((e) => e.text)).toContain("Defenders within 2 m of your pass line: 2");
    expect(CROWDED).toBe(2);
  });
  it("one defender in the lane only counts when the AI's line was clear", () => {
    const one = (aiLane: boolean) => moment({
      mates: [[20, 0], [0, 15]], defs: [[10, 1], ...(aiLane ? [[0.5, 7] as M] : []), ...FAR], options: [pass(0, 1, [20, 0]), pass(1, 2, [0, 15])],
    });
    expect(ids(lessonsFor(one(false), result({ option: 0, ai_pick: 1 })))).toContain("lane");
    expect(ids(lessonsFor(one(true), result({ option: 0, ai_pick: 1 })))).not.toContain("lane");
  });
  it("marked receiver: under 2.5 m while the AI's receiver had 4 m+ (and twice as much)", () => {
    const mk = (aiSpace: number) => moment({ mates: [[15, -10], [15, 10]], defs: [[16.5, -10], [15, 10 + aiSpace], [-5, 0]], options: [pass(0, 1, [15, -10]), pass(1, 2, [15, 10])] });
    const l = lessonsFor(mk(6), result({ option: 0, ai_pick: 1 })).find((x) => x.id === "space")!;
    expect(l.body).toBe("Your receiver was tightly marked: the nearest defender was 1.5 m away. The AI preferred #9 Nine, with 6.0 m of space.");
    expect(ids(lessonsFor(mk(3), result({ option: 0, ai_pick: 1 })))).not.toContain("space");
  });
  it("long pass: 30 m+ when the AI's was clearly shorter; cites the coach's loss value", () => {
    const mo = moment({ mates: [[34, 0], [12, 0]], defs: FAR, options: [pass(0, 1, [34, 0]), pass(1, 2, [12, 0])] });
    const reasons = { 0: [{ text: "long pass (34 m)", effect: -1 as const }, { text: "+0.015 xG if it arrives, -0.020 if lost there", effect: 0 as const }] };
    const l = lessonsFor(mo, result({ option: 0, ai_pick: 1, reasons })).find((x) => x.id === "long")!;
    expect(l.skill).toBe("risk");
    expect(l.body).toContain("Your pass travelled 34 m");
    expect(l.body).toContain("If lost there, the model scores it -0.020 xG.");
    expect(l.body).toContain("The AI preferred a shorter pass: #9 Nine, 12 m.");
    expect(l.evidence).toContainEqual({ text: "long pass (34 m)", effect: -1 }); // the coach's own phrase about the pick
    const close = moment({ mates: [[34, 0], [28, 5]], defs: FAR, options: [pass(0, 1, [34, 0]), pass(1, 2, [28, 5])] });
    expect(ids(lessonsFor(close, result({ option: 0, ai_pick: 1 })))).not.toContain("long");
    expect(LONG_M).toBe(30);
  });
  it("backward pass when the AI went forward for more", () => {
    const mo = moment({ mates: [[-10, 3], [12, -4]], defs: FAR, options: [pass(0, 1, [-10, 3]), pass(1, 2, [12, -4])] });
    const reasons = {
      0: [{ text: "+0.002 xG if it arrives, -0.030 if lost there", effect: 0 as const }],
      1: [{ text: "+0.021 xG if it arrives, -0.004 if lost there", effect: 0 as const }],
    };
    const l = lessonsFor(mo, result({ option: 0, ai_pick: 1, reasons })).find((x) => x.id === "back")!;
    expect(l.skill).toBe("progression");
    expect(l.body).toBe("You played it 10 m backward; the AI saw #9 Nine, 12 m forward, worth +0.021 xG if it arrives.");
    // the AI's forward pass worth less than the backward one: no lesson
    const worse = { 0: reasons[1], 1: reasons[0] };
    expect(ids(lessonsFor(mo, result({ option: 0, ai_pick: 1, reasons: worse })))).not.toContain("back");
  });
  it("low-percentage shot: far or narrow, with the model's goal chance", () => {
    const mo = moment({ carrier: [24.5, 0], mates: [[30, 10]], defs: FAR, options: [{ k: 0, kind: "shot", to: [5250, 0] }, pass(1, 1, [30, 10])] });
    const reasons = { 0: [{ text: "+0.040 xG for the shot, +0.010 if the ball is kept here", effect: 0 as const }] };
    const l = lessonsFor(mo, result({ option: 0, ai_pick: 1, reasons })).find((x) => x.id === "shot")!;
    expect(l.skill).toBe("finishing");
    expect(l.body).toMatch(/^Shooting from 28 m with 1[45]° of goal visible: the model gives about 4 % goal chance\./);
    const near = moment({ carrier: [42, 0], mates: [[30, 10]], defs: FAR, options: [{ k: 0, kind: "shot", to: [5250, 0] }, pass(1, 1, [30, 10])] });
    expect(ids(lessonsFor(near, result({ option: 0, ai_pick: 1 })))).not.toContain("shot");
  });
  it("the AI would have shot", () => {
    const mo = moment({ carrier: [40, 2], mates: [[30, 10]], defs: FAR, options: [{ k: 0, kind: "shot", to: [5250, 0] }, pass(1, 1, [30, 10])] });
    const reasons = { 0: [{ text: "+0.180 xG for the shot, +0.020 if the ball is kept here", effect: 0 as const }] };
    const l = lessonsFor(mo, result({ option: 1, ai_pick: 0, reasons })).find((x) => x.id === "noshot")!;
    expect(l.body).toMatch(/^The AI would have shot here: 13 m from goal, \d+° of goal visible, about 18 % goal chance\.$/);
  });
  it("carry into traffic: low pitch control where the carry ends", () => {
    const mo = moment({ mates: [[15, 0]], defs: FAR, options: [{ k: 0, kind: "carry", angle: 0, to: [800, 0] }, pass(1, 1, [15, 0])] });
    const reasons = { 0: [{ text: "20 % pitch control where the carry ends", effect: 0 as const }, { text: "+0.001 xG if kept, -0.015 if lost there", effect: 0 as const }] };
    const l = lessonsFor(mo, result({ option: 0, ai_pick: 1, reasons })).find((x) => x.id === "carry")!;
    expect(l.skill).toBe("risk");
    expect(l.body).toContain("only 20 % of the space");
    const roomy = { 0: [{ text: "60 % pitch control where the carry ends", effect: 0 as const }] };
    expect(ids(lessonsFor(mo, result({ option: 0, ai_pick: 1, reasons: roomy })))).not.toContain("carry");
  });
  it("reading the pro: picked like the pro against the AI; a wrong guess shows what the pro saw", () => {
    const mo = moment({ mates: [[10, 0], [12, 8]], defs: FAR, options: [pass(0, 1, [10, 0]), pass(1, 2, [12, 8])] });
    const pro = lessonsFor(mo, result({ option: 0, ai_pick: 1, pro_pick: 0, pro_instinct: true }));
    expect(pro.find((l) => l.id === "pro")!.body).toBe("You read the pro but the AI disagreed: both can be right; the AI values risk differently.");
    const g = lessonsFor(mo, result({ option: 0, ai_pick: 1, pro_pick: 1, guess: 0, guess_right: false }));
    expect(g.find((l) => l.id === "guess")!.body).toMatch(/^The pro found #9 Nine: [\d.]+ m of space, 12 m forward\.$/);
  });
});

describe("selection", () => {
  const crowded = moment({ mates: [[34, 0], [12, 0]], defs: [[10, 1], [20, -1], ...FAR], options: [pass(0, 1, [34, 0]), pass(1, 2, [12, 0])] });
  it("no lesson when the pick was the AI's", () => {
    expect(lessonsFor(crowded, result({ option: 0, ai_pick: 0, pro_pick: 0, guess: 1, guess_right: false }))).toEqual([]);
  });
  it("a close call (as good as the AI's) only gets the reading-the-pro notes", () => {
    const ls = lessonsFor(crowded, result({ option: 0, ai_pick: 1, pro_pick: 0, among_best: true, points: 100 }));
    expect(ids(ls)).toEqual(["pro"]);
  });
  it("at most 2 lessons, never two of one skill, the most useful first; skills tagged", () => {
    const ls = lessonsFor(crowded, result({ option: 0, ai_pick: 1, pro_pick: 0 }));
    expect(ls.length).toBe(2);
    expect(ids(ls)).toEqual(["lane", "long"]); // scanning (5) before risk (3); "pro" (1.5) dropped
    expect(new Set(ls.map((l) => l.skill)).size).toBe(2);
    for (const l of ls) expect(l.skill).toBe(SKILL_OF[l.id]);
  });
  it("the reveal prefers a lesson not shown yet today", () => {
    const ls = lessonsFor(crowded, result({ option: 0, ai_pick: 1 }));
    const seen = new Set<string>();
    expect(revealLesson(ls, seen)!.id).toBe("lane");
    expect(revealLesson(ls, seen)!.id).toBe("long");
    expect(revealLesson(ls, seen)!.id).toBe("lane"); // all seen: the most useful again
    expect(revealLesson([], seen)).toBeNull();
  });
  it("the day's notebook deduplicates by rule, counts repeats and keeps the 3 most useful", () => {
    const L = (id: Lesson["id"], weight: number): Lesson => ({ id, skill: SKILL_OF[id], title: id, body: `${id}${weight}`, evidence: [], weight });
    const nb = dayNotebook([[L("lane", 5), L("long", 3)], [], [L("lane", 6)], [L("pro", 1.5)], [L("back", 4), L("guess", 1)]]);
    expect(nb.map((e) => [e.lesson.id, e.count])).toEqual([["lane", 2], ["back", 1], ["long", 1]]);
    expect(nb[0]!.lesson.body).toBe("lane6"); // the latest instance speaks for the rule
    expect(dayNotebook([[], []])).toEqual([]);
  });
  it("a number never wraps away from its unit", () => {
    expect(rawLessonsFor(crowded, result({ option: 0, ai_pick: 1 }))[0]!.body).toContain("2 m of the line");
  });
  it("French lessons", () => {
    setLang("fr");
    const l = lessonsFor(crowded, result({ option: 0, ai_pick: 1 }))[0]!;
    expect(l.title).toBe("Trajectoire encombrée");
    expect(l.body).toContain("2 défenseurs étaient à moins de 2 m de la ligne");
  });
});

describe("history", () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
  const base = { points: 50, among_best: false, pro_instinct: false, same_as_ai: false, kind: "pass", zone: "middle", league: "L", outcome: "kept" } as const;

  it("records keep lesson ids and skills; older records without them still read and count", () => {
    const h = new History(mem());
    h.record("2026-11-01", { ...base, id: "old" }); // before the notebook
    h.record("2026-12-01", { ...base, id: "a", lessons: ["lane", "long"], skills: ["scanning", "risk"] });
    h.record("2026-12-01", { ...base, id: "b", lessons: [], skills: [] });
    h.record("2026-12-02", { ...base, id: "c", lessons: ["long"], skills: ["risk"] });
    const m = h.moments();
    expect(m["2026-12-01"]![0]!.lessons).toEqual(["lane", "long"]);
    expect(m["2026-11-01"]![0]!.lessons).toBeUndefined();
    expect(computeStats({ "2026-12-01": [50, 50] }, m).moments).toBe(4);
    expect(weakestSkill(m)).toEqual({ skill: "risk", n: 2, of: 3 }); // the old record is not counted
    expect(weakestSkill({ "2026-11-01": [{ ...base, id: "old" }] })).toBeNull();
    expect(weakestSkill({ x: "junk" as unknown as never[] })).toBeNull();
  });
  it("a reopened day rebuilds its notebook from the stored rule ids (generic tips)", () => {
    const nb = notebookFromRecords([{ ...base, id: "a", lessons: ["long", "bogus"] }, { ...base, id: "b", lessons: ["long", "lane"] }, null]);
    expect(nb.map((e) => [e.lesson.id, e.count])).toEqual([["long", 2], ["lane", 1]]);
    expect(nb[0]!.lesson.body).toBe("Long passes lose the ball more often: keep them for a receiver who is clearly free.");
    expect(notebookFromRecords(undefined)).toEqual([]);
  });
  it("toRecord stores the moment's lesson ids and skills", () => {
    const mo = moment({ mates: [[34, 0], [12, 0]], defs: [[10, 1], [20, -1], ...FAR], options: [pass(0, 1, [34, 0]), pass(1, 2, [12, 0])] });
    expect(toRecord(mo, result({ option: 0, ai_pick: 1 }))).toMatchObject({ lessons: ["lane", "long"], skills: ["scanning", "risk"] });
    expect(toRecord(mo, result({ option: 1, ai_pick: 1 }))).toMatchObject({ lessons: [], skills: [] });
  });
});
