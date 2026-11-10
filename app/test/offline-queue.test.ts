import { describe, expect, it, vi } from "vitest";
import { backoff, isOfflineError, PickQueue, QUEUE_KEY, type NewPick, type Store } from "../src/offline/pickQueue.ts";

const mem = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const pick = (moment: string, extra: Partial<NewPick> = {}): NewPick =>
  ({ player: "p1", moment, option: 2, guess: 1, date: "2026-12-01", index: 0, ...extra });
const ok = (points: number) => new Response(JSON.stringify({ option: 2, points, repeat: false }), { status: 200 });

describe("PickQueue", () => {
  it("enqueues into storage and dedupes by player + moment (the first answer wins)", () => {
    const s = mem();
    const q = new PickQueue(s);
    expect(q.enqueue(pick("m1", { option: 2 }))).toBe(true);
    expect(q.enqueue(pick("m1", { option: 5 }))).toBe(false);
    expect(q.enqueue(pick("m1", { player: "p2" }))).toBe(true);
    expect(q.enqueue(pick("m2", { index: 1 }))).toBe(true);
    expect(q.list().map((x) => `${x.player}/${x.moment}/${x.option}`)).toEqual(["p1/m1/2", "p2/m1/2", "p1/m2/2"]);
    expect(JSON.parse(s.data.get(QUEUE_KEY)!)).toHaveLength(3);
    expect(new PickQueue(s).pending("2026-12-01")).toHaveLength(3); // survives a reload
    expect(q.pending("2026-12-02")).toEqual([]);
  });

  it("flushes in order with the stored body and reports the scores", async () => {
    const send = vi.fn(async (p: NewPick) => ok(p.moment === "m1" ? 100 : 40));
    const q = new PickQueue(mem(), send);
    q.enqueue(pick("m1")); q.enqueue(pick("m2", { index: 1, guess: null }));
    const scored: [string, number][] = [];
    const rep = await q.flush((p, res) => { scored.push([p.moment, res.points]); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatchObject({ player: "p1", moment: "m2", option: 2, guess: null, index: 1 });
    expect(scored).toEqual([["m1", 100], ["m2", 40]]);
    expect(rep).toEqual({ scored: 2, dropped: 0, left: 0, offline: false });
    expect(q.list()).toEqual([]);
  });

  it("stops at a network failure, backs off and retries after the delay (or at once when forced)", async () => {
    let now = 1_000_000, online = false;
    const send = vi.fn(async () => { if (!online) throw new TypeError("Failed to fetch"); return ok(70); });
    const q = new PickQueue(mem(), send, () => now);
    q.enqueue(pick("m1")); q.enqueue(pick("m2", { index: 1 }));
    const onScored = vi.fn();
    let rep = await q.flush(onScored);
    expect(rep).toMatchObject({ scored: 0, left: 2, offline: true });
    expect(send).toHaveBeenCalledTimes(1); // still offline: the rest is not tried
    expect(q.list()[0]).toMatchObject({ tries: 1, nextAt: now + backoff(1) });
    rep = await q.flush(onScored); // m1 waits for its backoff; m2 is due and fails too
    expect(q.list().map((x) => x.tries)).toEqual([1, 1]);
    now += 500;
    expect(q.nextRetryAt()).toBe(now - 500 + backoff(1));
    online = true;
    now += backoff(1);
    rep = await q.flush(onScored);
    expect(rep).toMatchObject({ scored: 2, left: 0 });
    expect(onScored).toHaveBeenCalledTimes(2);

    q.enqueue(pick("m3")); online = false;
    await q.flush(onScored); await q.flush(onScored, true);
    expect(q.list()[0]!.tries).toBe(2); // forced: tried again despite the backoff
  });

  it("drops picks the server rejects for good, backs off on 429 / 5xx", async () => {
    const status: Record<string, number> = { bad: 400, gone: 404, busy: 429, err: 503 };
    const q = new PickQueue(mem(), async (p) => new Response("{}", { status: status[p.moment] ?? 200 }));
    for (const m of ["bad", "gone", "busy", "err"]) q.enqueue(pick(m));
    const rep = await q.flush(() => {});
    expect(rep).toMatchObject({ dropped: 2, left: 2, offline: false });
    expect(q.list().map((x) => [x.moment, x.tries])).toEqual([["busy", 1], ["err", 1]]);
  });

  it("runs one flush at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = vi.fn(async () => { await gate; return ok(10); });
    const q = new PickQueue(mem(), send);
    q.enqueue(pick("m1"));
    const a = q.flush(() => {}), b = q.flush(() => {});
    expect(a).toBe(b);
    release();
    await a;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("works without storage (memory only) and ignores corrupt data", () => {
    const broken: Store = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const q = new PickQueue(broken);
    q.enqueue(pick("m1"));
    expect(q.list()).toHaveLength(1);
    const s = mem(); s.setItem(QUEUE_KEY, "{not json");
    expect(new PickQueue(s).list()).toEqual([]);
  });

  it("backoff doubles and is capped; offline errors are told apart from server errors", () => {
    expect([1, 2, 3, 4].map(backoff)).toEqual([2000, 4000, 8000, 16000]);
    expect(backoff(30)).toBe(5 * 60_000);
    expect(isOfflineError(new TypeError("Failed to fetch"), true)).toBe(true);
    expect(isOfflineError(new Error("500"), true)).toBe(false);
    expect(isOfflineError(new Error("500"), false)).toBe(true);
  });
});
