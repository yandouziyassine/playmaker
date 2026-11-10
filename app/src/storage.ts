export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
const KEY_ID = "pm.player", KEY_DAYS = "pm.days", KEY_LIVE = "pm.live";

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
