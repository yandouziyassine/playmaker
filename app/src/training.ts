// Training: endless play over the whole content bank (every published moment, not only today's five). The order is a
// shuffle of the bank with no repeat until every play has been seen, then a new shuffle. Pure logic first (unit tested:
// app/test/training.test.ts), then the two network calls (bank and scoring) for the server and the static demo.
import type { Moment, PickResult } from "./api.ts";
import type { PickKind, TrainRecord, TrainState, Zone } from "./storage.ts";
import { ZONES, zoneOf } from "./stats.ts";

export type Rng = () => number;

/** Fisher-Yates on a copy. */
export function shuffle<T>(xs: readonly T[], rng: Rng = Math.random): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

/** Brings the saved order in line with the current bank: ids gone from the bank are dropped (the position follows),
 *  new ids are shuffled into the part not played yet. A first visit gets a full shuffle. */
export function syncBank(s: TrainState, bank: readonly string[], rng: Rng = Math.random): TrainState {
  const inBank = new Set(bank);
  const played = s.order.slice(0, s.pos).filter((id) => inBank.has(id));
  const rest = s.order.slice(s.pos).filter((id) => inBank.has(id));
  const known = new Set(s.order);
  const fresh = bank.filter((id) => !known.has(id));
  const order = [...played, ...shuffle([...rest, ...fresh], rng)];
  return { ...s, order: [...new Set(order)], pos: played.length };
}

/** The next moment to play (null: empty bank). At the end of the order a new shuffle starts (a new cycle); the moment
 *  just played is not put first, so a cycle change never repeats it back to back. `skip`: ids not wanted now (the
 *  zone filter); they stay in place for later. Null when every remaining id of the cycle is skipped. */
export function nextId(s: TrainState, rng: Rng = Math.random, skip: ReadonlySet<string> = new Set()): { state: TrainState; id: string | null } {
  if (!s.order.length) return { state: s, id: null };
  let state = s;
  if (state.pos >= state.order.length) {
    const last = state.order[state.order.length - 1];
    let order = shuffle(state.order, rng);
    if (order.length > 1 && order[0] === last) order = [...order.slice(1), order[0]!];
    state = { ...state, order, pos: 0, cycle: state.cycle + 1 };
  }
  const i = state.order.findIndex((id, j) => j >= state.pos && !skip.has(id));
  if (i < 0) return { state, id: null };
  if (i !== state.pos) { // bring it forward; the skipped ones keep their turn
    const order = [...state.order];
    const [id] = order.splice(i, 1);
    order.splice(state.pos, 0, id!);
    state = { ...state, order };
  }
  return { state, id: state.order[state.pos]! };
}

/** Zone, pick kind and league of an answered moment (from its own data; nothing is guessed). */
export function describe(mo: Moment, res: PickResult): Pick<TrainRecord, "zone" | "kind" | "league" | "guess_right"> {
  const release = mo.lead_up[mo.lead_up.length - 1];
  const pos = release?.[mo.carrier] ?? mo.ball[mo.ball.length - 1] ?? null;
  return {
    zone: zoneOf(pos?.[0]), kind: mo.options.find((o) => o.k === res.option)?.kind ?? "pass", league: mo.league,
    guess_right: typeof res.guess_right === "boolean" ? res.guess_right : null,
  };
}

/** The pitch zone of a moment (for the filter), from the carrier's position at the release. */
export const momentZone = (mo: Moment): Zone => {
  const release = mo.lead_up[mo.lead_up.length - 1];
  return zoneOf((release?.[mo.carrier] ?? mo.ball[mo.ball.length - 1] ?? null)?.[0]);
};

/** One play answered: the position moves on, the moment's best and the running totals are updated. */
export function recordPlay(s: TrainState, id: string, points: number, info: Pick<TrainRecord, "zone" | "kind" | "league" | "guess_right">): TrainState {
  const order = [...s.order];
  let pos = s.pos;
  const at = order.indexOf(id);
  if (at >= pos) { order.splice(at, 1); order.splice(pos, 0, id); pos++; } // normally at === pos
  else if (at < 0) { order.splice(pos, 0, id); pos++; }
  const prev = s.recs[id];
  const rec: TrainRecord = { ...info, best: Math.max(prev?.best ?? 0, points), last: points, plays: (prev?.plays ?? 0) + 1 };
  const run = points >= 100 ? s.run + 1 : 0;
  return { ...s, order, pos, recs: { ...s.recs, [id]: rec }, plays: s.plays + 1, sum: s.sum + points, run, bestRun: Math.max(s.bestRun, run) };
}

export interface BankSummary {
  size: number; seen: number; avgBest: number | null; avgAll: number | null;
  byZone: Record<Zone, { n: number; avg: number | null }>;
  byKind: Record<PickKind, { n: number; avg: number | null }>;
  /** Best and worst zone by average best points (zones with at least 2 moments seen), null until two qualify. */
  bestZone: Zone | null; worstZone: Zone | null;
}

/** The bank progress view: seen x of the bank, averages, best and worst zones. Only moments still in the bank count. */
export function bankSummary(s: TrainState, bank: readonly string[]): BankSummary {
  const recs = bank.map((id) => s.recs[id]).filter((r): r is TrainRecord => !!r);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const byZone = Object.fromEntries(ZONES.map((z) => { const r = recs.filter((x) => x.zone === z); return [z, { n: r.length, avg: avg(r.map((x) => x.best)) }]; })) as BankSummary["byZone"];
  const byKind = Object.fromEntries((["pass", "carry", "shot"] as PickKind[]).map((k) => { const r = recs.filter((x) => x.kind === k); return [k, { n: r.length, avg: avg(r.map((x) => x.best)) }]; })) as BankSummary["byKind"];
  const ok = ZONES.filter((z) => byZone[z].n >= 2).sort((a, b) => byZone[b].avg! - byZone[a].avg!);
  return {
    size: bank.length, seen: recs.length, avgBest: avg(recs.map((r) => r.best)), avgAll: s.plays ? Math.round(s.sum / s.plays) : null,
    byZone, byKind, bestZone: ok.length >= 2 ? ok[0]! : null, worstZone: ok.length >= 2 ? ok[ok.length - 1]! : null,
  };
}

// ---- network: the bank and the scoring, on the server (/api/train) or in the static demo (answer files) ----

const DEMO = import.meta.env.VITE_DEMO === "1";
const json = async <T>(r: Response): Promise<T> => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<T>; };

/** The bank's moment ids, from the content: the server lists the moments of past days (today's and later answers stay
 *  hidden); the demo, whose answers ship with it, uses every day of its content index. */
export async function getBank(): Promise<string[]> {
  if (!DEMO) return (await fetch("api/train/bank").then(json<{ moments: string[] }>)).moments;
  const idx = await fetch("content/days/index.json").then(json<{ days: { date: string }[] }>);
  const days = await Promise.all(idx.days.map((d) => fetch(`content/days/${d.date}.json`).then(json<{ moments: string[] }>)));
  return [...new Set(days.flatMap((d) => d.moments))];
}

/** Scores a training answer. Nothing is stored: the same moment can be answered again (no first-answer rule). */
export async function trainPick(moment: string, option: number, guess: number | null): Promise<PickResult> {
  if (DEMO) return (await import("./demo.ts")).demoTrain(moment, option, guess);
  return fetch("api/train", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(guess === null ? { moment, option } : { moment, option, guess }),
  }).then(json<PickResult>);
}
