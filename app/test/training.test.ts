import { describe as group, expect, it } from "vitest";
import { emptyTrain, TrainStore } from "../src/storage.ts";
import { bankSummary, nextId, recordPlay, shuffle, syncBank } from "../src/training.ts";

/** Deterministic generator (mulberry32). */
const rng = (seed = 1) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const bank = Array.from({ length: 150 }, (_, i) => `m${i}`);
const info = { zone: "middle" as const, kind: "pass" as const, league: "L", guess_right: null };

/** Plays n moments through the public functions; returns the ids in play order and the final state. */
function play(n: number, s = syncBank(emptyTrain(), bank, rng(7)), r = rng(9), points = () => 50) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { state, id } = nextId(s, r);
    ids.push(id!);
    s = recordPlay(state, id!, points(), info);
  }
  return { ids, s };
}

group("training order", () => {
  it("shuffle keeps every element once", () => {
    const a = shuffle(bank, rng(3));
    expect([...a].sort()).toEqual([...bank].sort());
    expect(a).not.toEqual(bank);
  });
  it("no repeat until every play of the bank has been seen, then a new shuffle", () => {
    const { ids, s } = play(450);
    for (let c = 0; c < 3; c++) expect(new Set(ids.slice(c * 150, (c + 1) * 150)).size).toBe(150);
    expect(ids.slice(0, 150)).not.toEqual(ids.slice(150, 300));
    expect(s.cycle).toBe(2);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]); // never back to back across a cycle change
  });
  it("survives a reload: the saved order and position carry on", () => {
    const kv = new Map<string, string>();
    const store = new TrainStore({ getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => void kv.set(k, v) });
    const first = play(60);
    store.save(first.s);
    const rest = play(90, syncBank(store.load(), bank, rng(11)));
    expect(new Set([...first.ids, ...rest.ids]).size).toBe(150);
  });
  it("a bank that grows (a new day) adds the new plays to the part not played yet", () => {
    const { ids, s } = play(100);
    const bigger = [...bank, "n1", "n2", "n3", "n4", "n5"];
    const more = play(55, syncBank(s, bigger, rng(5)));
    expect(new Set([...ids, ...more.ids]).size).toBe(155);
    expect(more.ids).toEqual(expect.arrayContaining(["n1", "n5"]));
  });
  it("moments gone from the bank are dropped", () => {
    const s = syncBank(play(10).s, bank.slice(5), rng(2));
    expect(s.order).toHaveLength(145);
    expect(s.order.slice(0, s.pos).every((id) => bank.slice(5).includes(id))).toBe(true);
  });
  it("the zone filter skips without losing the skipped plays' turn", () => {
    const s = syncBank(emptyTrain(), bank, rng(4));
    const skip = new Set(s.order.slice(0, 3));
    const { state, id } = nextId(s, rng(1), skip);
    expect(skip.has(id!)).toBe(false);
    expect(state.order.slice(1, 4)).toEqual(s.order.slice(0, 3)); // still next in line
    expect(nextId(s, rng(1), new Set(bank)).id).toBeNull();
    expect(nextId(emptyTrain()).id).toBeNull();
  });
});

group("training records", () => {
  it("keeps the best per moment, the running average and the run of top picks", () => {
    let s = syncBank(emptyTrain(), ["a", "b", "c"], rng(1));
    const pts = [100, 100, 40, 100];
    const seen: string[] = [];
    for (const p of pts) { const n = nextId(s, rng(2)); seen.push(n.id!); s = recordPlay(n.state, n.id!, p, info); }
    expect(s.plays).toBe(4); expect(s.sum).toBe(340); expect(s.run).toBe(1); expect(s.bestRun).toBe(2);
    expect(s.recs[seen[3]!]!.best).toBe(Math.max(100, seen[3] === seen[2] ? 40 : 0));
    expect(s.recs[seen[2]!]!.plays).toBe(seen.filter((x) => x === seen[2]).length);
  });
  it("bank summary: seen x of the bank, averages and best / worst zones", () => {
    let s = syncBank(emptyTrain(), ["a", "b", "c", "d", "e"], rng(1));
    const zones = { a: "build", b: "build", c: "final", d: "final", e: "middle" } as const;
    const points = { a: 100, b: 80, c: 10, d: 30, e: 50 } as const;
    for (const id of ["a", "b", "c", "d"] as const) s = recordPlay(s, id, points[id], { ...info, zone: zones[id] });
    const sum = bankSummary(s, ["a", "b", "c", "d", "e"]);
    expect(sum).toMatchObject({ size: 5, seen: 4, avgBest: 55, avgAll: 55, bestZone: "build", worstZone: "final" });
    expect(sum.byZone.build).toEqual({ n: 2, avg: 90 });
    expect(bankSummary(s, ["e"])).toMatchObject({ size: 1, seen: 0, avgBest: null, bestZone: null });
  });
});
