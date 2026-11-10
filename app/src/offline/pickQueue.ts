// Answers given offline: kept in localStorage and sent to POST /api/pick when the network is back (on 'online', on the
// next page load and on a backoff timer). The server's "first answer wins" makes a resend safe: a pick that did reach
// it comes back as the same result (repeat: true).
import type { PickResult } from "../api.ts";

export interface QueuedPick {
  player: string; moment: string; option: number; guess: number | null;
  /** The day it belongs to and its position in that day (to fix the day's points once scored). */
  date: string; index: number;
  tries: number;
  /** Not resent before this time (ms since epoch), unless a flush is forced. */
  nextAt: number;
}
export type NewPick = Omit<QueuedPick, "tries" | "nextAt">;
export interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }
/** Sends one pick: resolves with the HTTP response, rejects when the network is down. */
export type Send = (p: NewPick) => Promise<Response>;
export type OnScored = (p: QueuedPick, res: PickResult) => void | Promise<void>;
export interface FlushReport { scored: number; dropped: number; left: number; offline: boolean }

export const QUEUE_KEY = "pm.pickq";
const BASE_MS = 2000, MAX_MS = 5 * 60_000;
/** Wait before the n-th retry (n >= 1): 2 s, 4 s, 8 s ... capped at 5 min. */
export const backoff = (tries: number) => Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, tries - 1));

export const sendPick: Send = (p) =>
  fetch("/api/pick", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(p.guess === null ? { player: p.player, moment: p.moment, option: p.option } : { player: p.player, moment: p.moment, option: p.option, guess: p.guess }),
  });

/** Network down (fetch rejects with a TypeError, or the browser says it is offline): not a server answer. */
export const isOfflineError = (e: unknown, online = typeof navigator === "undefined" || navigator.onLine !== false) =>
  !online || e instanceof TypeError;

export class PickQueue {
  private mem: string | null = null;
  private running: Promise<FlushReport> | null = null;
  constructor(private store: Store | null, private send: Send = sendPick, private now: () => number = Date.now) {}

  list(): QueuedPick[] {
    let raw: string | null = this.mem;
    try { raw = this.store?.getItem(QUEUE_KEY) ?? this.mem; } catch { /* memory only */ }
    try { const v = JSON.parse(raw ?? "[]") as unknown; return Array.isArray(v) ? (v as QueuedPick[]).filter(valid) : []; } catch { return []; }
  }
  private save(list: QueuedPick[]) {
    this.mem = JSON.stringify(list);
    try { this.store?.setItem(QUEUE_KEY, this.mem); } catch { /* memory only */ }
  }

  /** Adds a pick; false when this player already has one queued for the moment (the first answer wins). */
  enqueue(p: NewPick): boolean {
    const list = this.list();
    if (list.some((q) => q.player === p.player && q.moment === p.moment)) return false;
    list.push({ ...p, tries: 0, nextAt: 0 });
    this.save(list);
    return true;
  }

  /** Picks still waiting for a score (for one day, or all). */
  pending(date?: string): QueuedPick[] { return this.list().filter((q) => date === undefined || q.date === date); }

  /** Earliest time a waiting pick may be retried (null: nothing queued). */
  nextRetryAt(): number | null {
    const l = this.list();
    return l.length ? Math.min(...l.map((q) => q.nextAt)) : null;
  }

  /** Sends the due picks in order. A network failure stops the round (still offline) and backs that pick off;
   * a 400 / 404 (unknown or invalid moment: never going to work) drops it; other errors (429, 5xx) back off.
   * `force`: ignore the backoff (the browser just came back online, or a fresh page load). One flush at a time. */
  flush(onScored: OnScored, force = false): Promise<FlushReport> {
    this.running ??= this.run(onScored, force).finally(() => { this.running = null; });
    return this.running;
  }

  private async run(onScored: OnScored, force: boolean): Promise<FlushReport> {
    const rep: FlushReport = { scored: 0, dropped: 0, left: 0, offline: false };
    for (const q of this.list()) {
      if (!force && q.nextAt > this.now()) continue;
      let res: Response;
      try { res = await this.send(q); } catch {
        this.retryLater(q); rep.offline = true; break;
      }
      if (res.ok) {
        let body: PickResult | null = null;
        try { body = (await res.json()) as PickResult; } catch { /* unreadable: retry later */ }
        if (!body) { this.retryLater(q); continue; }
        this.remove(q);
        rep.scored++;
        try { await onScored(q, body); } catch { /* the score is in; local bookkeeping is best effort */ }
      } else if (res.status === 400 || res.status === 404) {
        this.remove(q); rep.dropped++;
      } else {
        this.retryLater(q);
      }
    }
    rep.left = this.list().length;
    return rep;
  }

  private update(q: QueuedPick, fn: (list: QueuedPick[], i: number) => void) {
    const list = this.list();
    const i = list.findIndex((x) => x.player === q.player && x.moment === q.moment);
    if (i >= 0) { fn(list, i); this.save(list); }
  }
  private remove(q: QueuedPick) { this.update(q, (l, i) => l.splice(i, 1)); }
  private retryLater(q: QueuedPick) {
    this.update(q, (l, i) => { const tries = l[i]!.tries + 1; l[i] = { ...l[i]!, tries, nextAt: this.now() + backoff(tries) }; });
  }
}

const valid = (q: unknown): q is QueuedPick => {
  const x = q as QueuedPick | null;
  return !!x && typeof x.player === "string" && typeof x.moment === "string" && typeof x.option === "number" &&
    typeof x.date === "string" && typeof x.index === "number";
};
