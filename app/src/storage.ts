export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
const KEY_ID = "pm.player", KEY_DAYS = "pm.days", KEY_LIVE = "pm.live", KEY_MOMENTS = "pm.moments";

export type Zone = "build" | "middle" | "final";
export type PickKind = "pass" | "carry" | "shot";
/** Coach's notebook skills (app/src/lessons.ts). */
export type Skill = "scanning" | "risk" | "progression" | "finishing" | "reading";
/** One answered moment, as remembered for the personal stats (no positions, no names). */
export interface MomentRecord {
  id: string; points: number; among_best: boolean; pro_instinct: boolean; same_as_ai: boolean;
  kind: PickKind; zone: Zone; league: string; outcome: "goal" | "shot" | "kept" | "lost";
  /** Second question: did the player guess the pro's real pass? Missing/null on records from before it existed. */
  guess_right?: boolean | null;
  /** Coach's notebook: rule ids and skills of the moment's lessons (empty: none). Missing on older records. */
  lessons?: string[];
  skills?: Skill[];
}

/** Everything the game remembers lives in this browser only (no account). Storage failures (private mode, blocked
 * site data) fall back to memory for the session. */
export class History {
  private mem = new Map<string, string>();
  constructor(private kv: KV) {}
  private get(k: string) { try { return this.kv.getItem(k) ?? this.mem.get(k) ?? null; } catch { return this.mem.get(k) ?? null; } }
  private set(k: string, v: string) { this.mem.set(k, v); try { this.kv.setItem(k, v); } catch { /* memory only */ } }
  private json<T>(k: string, fallback: T): T { try { return JSON.parse(this.get(k) ?? "") as T; } catch { return fallback; } }

  player(): string {
    const id = this.get(KEY_ID) ?? crypto.randomUUID();
    this.set(KEY_ID, id); return id;
  }
  days(): Record<string, number[]> { return this.json(KEY_DAYS, {}); }
  /** `live`: played on the day itself (only those count for the streak; archive days do not). */
  finish(date: string, points: number[], live = true) {
    const d = this.days(); d[date] = points; this.set(KEY_DAYS, JSON.stringify(d));
    if (live) { const l = this.json<string[]>(KEY_LIVE, []); if (!l.includes(date)) l.push(date); this.set(KEY_LIVE, JSON.stringify(l)); }
  }
  /** Per-moment records by date (days played before records existed simply have none). */
  moments(): Record<string, MomentRecord[]> {
    const m = this.json<unknown>(KEY_MOMENTS, {});
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, MomentRecord[]>) : {};
  }
  /** Adds or replaces (same moment id) the record of one answered moment. */
  record(date: string, rec: MomentRecord) {
    const m = this.moments();
    const list = Array.isArray(m[date]) ? m[date]!.filter((r) => r && r.id !== rec.id) : [];
    list.push(rec); m[date] = list; this.set(KEY_MOMENTS, JSON.stringify(m));
  }
  streak(today: string): number {
    const live = new Set(this.json<string[]>(KEY_LIVE, []));
    let t = Date.parse(today + "T00:00:00Z");
    if (!live.has(new Date(t).toISOString().slice(0, 10))) t -= 86400000; // today not played yet: streak still alive
    let n = 0;
    while (live.has(new Date(t).toISOString().slice(0, 10))) { n++; t -= 86400000; }
    return n;
  }
  flag(k: string): boolean { return this.get(k) === "1"; }
  setFlag(k: string) { this.set(k, "1"); }
}

/** Training (endless play over the content bank): kept apart from the daily game (other keys), so streaks, daily
 *  history and daily stats never see it. One shuffled order of the bank, a position in it, and per moment the best
 *  points (app/src/training.ts holds the logic). */
export interface TrainRecord {
  best: number; last: number; plays: number;
  zone: Zone; kind: PickKind; league: string; guess_right: boolean | null;
}
export interface TrainState {
  v: 1;
  /** The bank's moment ids in play order; `pos` is the next one to play. A new shuffle starts when pos reaches the end. */
  order: string[]; pos: number; cycle: number;
  recs: Record<string, TrainRecord>;
  /** Running totals over every training play: plays, points, current and best run of top picks (100 points). */
  plays: number; sum: number; run: number; bestRun: number;
  /** Pitch-zone filter ("all": none). */
  zone: Zone | "all";
}
export const emptyTrain = (): TrainState => ({ v: 1, order: [], pos: 0, cycle: 0, recs: {}, plays: 0, sum: 0, run: 0, bestRun: 0, zone: "all" });
const KEY_TRAIN = "pm.train";

export class TrainStore {
  private mem: string | null = null;
  constructor(private kv: KV) {}
  load(): TrainState {
    let raw: string | null = this.mem;
    try { raw = this.kv.getItem(KEY_TRAIN) ?? raw; } catch { /* memory only */ }
    try {
      const s = JSON.parse(raw ?? "") as TrainState;
      if (s && s.v === 1 && Array.isArray(s.order) && typeof s.pos === "number" && s.recs && typeof s.recs === "object") return { ...emptyTrain(), ...s };
    } catch { /* fresh start */ }
    return emptyTrain();
  }
  save(s: TrainState) {
    this.mem = JSON.stringify(s);
    try { this.kv.setItem(KEY_TRAIN, this.mem); } catch { /* memory only */ }
  }
}
